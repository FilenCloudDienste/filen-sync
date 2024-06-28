import fs from "fs-extra"
import watcher from "@parcel/watcher"
import { promiseAllChunked } from "../../utils"
import pathModule from "path"
import process from "process"
import type Sync from "../sync"
import { SYNC_INTERVAL } from "../../constants"
import crypto from "crypto"
import { pipeline } from "stream"
import { promisify } from "util"
import { type CloudItem, PauseSignal } from "@filen/sdk"
import { postMessageToMain } from "../ipc"

const pipelineAsync = promisify(pipeline)

export type LocalItem = {
	lastModified: number
	type: "file" | "directory"
	path: string
	size: number
	creation: number
	inode: number
}

export type LocalDirectoryTree = Record<string, LocalItem>
export type LocalDirectoryINodes = Record<number, LocalItem>
export type LocalTree = {
	tree: LocalDirectoryTree
	inodes: LocalDirectoryINodes
}
export type LocalTreeError = {
	localPath: string
	relativePath: string
	error: Error
}

/**
 * LocalFileSystem
 * @date 3/2/2024 - 12:38:22 PM
 *
 * @export
 * @class LocalFileSystem
 * @typedef {LocalFileSystem}
 */
export class LocalFileSystem {
	private readonly sync: Sync
	public lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL * 2
	public getDirectoryTreeCache: {
		timestamp: number
		tree: LocalDirectoryTree
		inodes: LocalDirectoryINodes
	} = {
		timestamp: 0,
		tree: {},
		inodes: {}
	}
	public watcherRunning = false
	private watcherInstance: watcher.AsyncSubscription | null = null

	/**
	 * Creates an instance of LocalFileSystem.
	 * @date 3/2/2024 - 12:38:20 PM
	 *
	 * @constructor
	 * @public
	 * @param {{ sync: Sync }} param0
	 * @param {Sync} param0.sync
	 */
	public constructor({ sync }: { sync: Sync }) {
		this.sync = sync
	}

	/**
	 * Get the local directory tree.
	 *
	 * @public
	 * @async
	 * @returns {Promise<{
	 * 		result: LocalTree
	 * 		errors: LocalTreeError[]
	 * 	}>}
	 */
	public async getDirectoryTree(): Promise<{
		result: LocalTree
		errors: LocalTreeError[]
	}> {
		if (
			this.lastDirectoryChangeTimestamp > 0 &&
			this.getDirectoryTreeCache.timestamp > 0 &&
			this.lastDirectoryChangeTimestamp < this.getDirectoryTreeCache.timestamp
		) {
			return {
				result: {
					tree: this.getDirectoryTreeCache.tree,
					inodes: this.getDirectoryTreeCache.inodes
				},
				errors: []
			}
		}

		const isWindows = process.platform === "win32"
		const tree: LocalDirectoryTree = {}
		const inodes: LocalDirectoryINodes = {}
		const errors: LocalTreeError[] = []
		const dir = await fs.readdir(this.sync.syncPair.localPath, {
			recursive: true,
			encoding: "utf-8"
		})

		await promiseAllChunked(
			dir.map(async entry => {
				if (entry.startsWith(".filen.trash.local")) {
					return
				}

				const itemPath = pathModule.join(this.sync.syncPair.localPath, entry)
				const entryPath = `/${isWindows ? entry.replace(/\\/g, "/") : entry}`

				try {
					const stats = await fs.stat(itemPath)
					const item: LocalItem = {
						lastModified: parseInt(stats.mtimeMs as unknown as string), // Sometimes comes as a float, but we need an int
						type: stats.isDirectory() ? "directory" : "file",
						path: entryPath,
						creation: parseInt(stats.birthtimeMs as unknown as string), // Sometimes comes as a float, but we need an int
						size: stats.size,
						inode: stats.ino
					}

					tree[entryPath] = item
					inodes[stats.ino] = item
				} catch (e) {
					if (e instanceof Error) {
						errors.push({
							localPath: itemPath,
							relativePath: entryPath,
							error: e
						})
					}
				}
			})
		)

		this.getDirectoryTreeCache = {
			timestamp: Date.now(),
			tree,
			inodes
		}

		return {
			result: {
				tree,
				inodes
			},
			errors
		}
	}

	/**
	 * Start the local sync directory watcher.
	 * @date 3/2/2024 - 12:38:00 PM
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async startDirectoryWatcher(): Promise<void> {
		if (this.watcherInstance) {
			return
		}

		this.watcherInstance = await watcher.subscribe(this.sync.syncPair.localPath, (err, events) => {
			if (!err && events) {
				this.lastDirectoryChangeTimestamp = Date.now()
			}
		})
	}

	/**
	 * Stop the local sync directory watcher.
	 * @date 3/2/2024 - 12:37:48 PM
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async stopDirectoryWatcher(): Promise<void> {
		if (!this.watcherInstance) {
			return
		}

		await this.watcherInstance.unsubscribe()

		this.watcherInstance = null
	}

	/**
	 * Wait for local directory updates to be done.
	 * Sometimes the user might copy a lot of new files, folders etc.
	 * We want to wait (or at least try) until all local operations are done until we start syncing.
	 * This can save a lot of sync cycles.
	 * @date 3/1/2024 - 10:40:14 PM
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async waitForLocalDirectoryChanges(): Promise<void> {
		await new Promise<void>(resolve => {
			if (Date.now() > this.lastDirectoryChangeTimestamp + SYNC_INTERVAL) {
				resolve()

				return
			}

			const wait = setInterval(() => {
				if (Date.now() > this.lastDirectoryChangeTimestamp + SYNC_INTERVAL) {
					clearInterval(wait)

					resolve()
				}
			}, 100)
		})
	}

	/**
	 * Creates a hash of a file using streams.
	 *
	 * @public
	 * @async
	 * @param {{
	 * 		relativePath: string
	 * 		algorithm: "sha512" | "md5" | "sha256"
	 * 	}} param0
	 * @param {string} param0.relativePath
	 * @param {("sha512" | "md5" | "sha256")} param0.algorithm
	 * @returns {Promise<string>}
	 */
	public async createFileHash({
		relativePath,
		algorithm
	}: {
		relativePath: string
		algorithm: "sha512" | "md5" | "sha256"
	}): Promise<string> {
		const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)
		const hasher = crypto.createHash(algorithm)

		await pipelineAsync(fs.createReadStream(localPath), hasher)

		const hash = hasher.digest("hex")

		return hash
	}

	/**
	 * Create a directory inside the local sync path. Recursively creates intermediate directories if needed.
	 * @date 3/2/2024 - 12:36:23 PM
	 *
	 * @public
	 * @async
	 * @param {{ relativePath: string }} param0
	 * @param {string} param0.relativePath
	 * @returns {Promise<fs.Stats>}
	 */
	public async mkdir({ relativePath }: { relativePath: string }): Promise<fs.Stats> {
		const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)

		await fs.ensureDir(localPath)

		return await fs.stat(localPath)
	}

	/**
	 * Delete a file/directory inside the local sync path.
	 * @date 3/3/2024 - 10:05:55 PM
	 *
	 * @public
	 * @async
	 * @param {{ relativePath: string; permanent?: boolean }} param0
	 * @param {string} param0.relativePath
	 * @param {boolean} [param0.permanent=false]
	 * @returns {Promise<void>}
	 */
	public async unlink({ relativePath, permanent = false }: { relativePath: string; permanent?: boolean }): Promise<void> {
		const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)

		if (!permanent) {
			const localTrashPath = pathModule.join(this.sync.syncPair.localPath, ".filen.trash.local")

			await fs.ensureDir(localTrashPath)

			await fs.move(localPath, pathModule.join(localTrashPath, pathModule.posix.basename(relativePath)), {
				overwrite: true
			})

			return
		}

		await fs.rm(localPath, {
			force: true,
			maxRetries: 60 * 10,
			recursive: true,
			retryDelay: 100
		})
	}

	/**
	 * Rename a file/directory inside the local sync path. Recursively creates intermediate directories if needed.
	 * @date 3/2/2024 - 12:41:15 PM
	 *
	 * @public
	 * @async
	 * @param {{ fromRelativePath: string; toRelativePath: string }} param0
	 * @param {string} param0.fromRelativePath
	 * @param {string} param0.toRelativePath
	 * @returns {Promise<fs.Stats>}
	 */
	public async rename({ fromRelativePath, toRelativePath }: { fromRelativePath: string; toRelativePath: string }): Promise<fs.Stats> {
		const fromLocalPath = pathModule.join(this.sync.syncPair.localPath, fromRelativePath)
		const toLocalPath = pathModule.join(this.sync.syncPair.localPath, toRelativePath)
		const fromLocalPathParentPath = pathModule.dirname(fromLocalPath)
		const toLocalPathParentPath = pathModule.dirname(toLocalPath)

		await fs.ensureDir(toLocalPathParentPath)

		if (fromLocalPathParentPath === toLocalPathParentPath) {
			await fs.rename(fromLocalPath, toLocalPath)

			return await fs.stat(toLocalPath)
		}

		await fs.move(fromLocalPath, toLocalPath, {
			overwrite: true
		})

		return await fs.stat(toLocalPath)
	}

	/**
	 * Upload a local file.
	 * @date 3/2/2024 - 9:43:58 PM
	 *
	 * @public
	 * @async
	 * @param {{ relativePath: string }} param0
	 * @param {string} param0.relativePath
	 * @returns {Promise<void>}
	 */
	public async upload({ relativePath }: { relativePath: string }): Promise<CloudItem> {
		const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)
		const signalKey = `upload:${relativePath}`

		if (!this.sync.pauseSignals[signalKey]) {
			this.sync.pauseSignals[signalKey] = new PauseSignal()
		}

		if (!this.sync.abortControllers[signalKey]) {
			this.sync.abortControllers[signalKey] = new AbortController()
		}

		postMessageToMain({
			type: "transfer",
			syncPair: this.sync.syncPair,
			data: {
				of: "upload",
				type: "queued",
				relativePath,
				localPath
			}
		})

		try {
			const parentPath = pathModule.posix.dirname(relativePath)

			await this.sync.remoteFileSystem.mkdir({ relativePath: parentPath })

			const parentUUID = await this.sync.remoteFileSystem.pathToItemUUID({ relativePath: parentPath })

			if (!parentUUID) {
				throw new Error(`Could not upload ${relativePath}: Parent path not found.`)
			}

			const hash = await this.createFileHash({
				relativePath,
				algorithm: "md5"
			})

			this.sync.localFileHashes[relativePath] = hash

			const item = await this.sync.sdk.cloud().uploadLocalFile({
				source: localPath,
				parent: parentUUID,
				name: pathModule.basename(localPath),
				pauseSignal: this.sync.pauseSignals[signalKey],
				abortSignal: this.sync.abortControllers[signalKey]?.signal,
				onError: err => {
					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: "upload",
							type: "error",
							relativePath,
							localPath,
							error: err
						}
					})
				},
				onProgress: bytes => {
					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: "upload",
							type: "progress",
							relativePath,
							localPath,
							bytes
						}
					})
				},
				onStarted: () => {
					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: "upload",
							type: "started",
							relativePath,
							localPath
						}
					})
				}
			})

			await this.sync.remoteFileSystem.itemsMutex.acquire()

			this.sync.remoteFileSystem.getDirectoryTreeCache.tree[relativePath] = {
				...item,
				path: relativePath
			}

			this.sync.remoteFileSystem.getDirectoryTreeCache.uuids[item.uuid] = {
				...item,
				path: relativePath
			}

			this.sync.remoteFileSystem.itemsMutex.release()

			postMessageToMain({
				type: "transfer",
				syncPair: this.sync.syncPair,
				data: {
					of: "upload",
					type: "finished",
					relativePath,
					localPath
				}
			})

			return item
		} catch (e) {
			if (e instanceof Error) {
				postMessageToMain({
					type: "transfer",
					syncPair: this.sync.syncPair,
					data: {
						of: "upload",
						type: "error",
						relativePath,
						localPath,
						error: e
					}
				})
			}

			throw e
		} finally {
			delete this.sync.pauseSignals[signalKey]
			delete this.sync.abortControllers[signalKey]
		}
	}
}

export default LocalFileSystem
