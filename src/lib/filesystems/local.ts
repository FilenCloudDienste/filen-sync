import fs from "fs-extra"
import watcher from "@parcel/watcher"
import {
	promiseAllSettledChunked,
	isRelativePathIgnoredByDefault,
	isDirectoryPathIgnoredByDefault,
	isSystemPathIgnoredByDefault,
	serializeError
} from "../../utils"
import pathModule from "path"
import process from "process"
import type Sync from "../sync"
import { SYNC_INTERVAL, LOCAL_TRASH_NAME } from "../../constants"
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
export type LocalTreeIgnored = {
	localPath: string
	relativePath: string
	reason: "dotFile" | "localIgnore" | "defaultIgnore"
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
	 *
	 * @constructor
	 * @public
	 * @param {Sync} sync
	 */
	public constructor(sync: Sync) {
		this.sync = sync
	}

	public async getDirectoryTree(): Promise<{
		result: LocalTree
		errors: LocalTreeError[]
		ignored: LocalTreeIgnored[]
		changed: boolean
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
				errors: [],
				ignored: [],
				changed: false
			}
		}

		const isWindows = process.platform === "win32"
		const tree: LocalDirectoryTree = {}
		const inodes: LocalDirectoryINodes = {}
		const errors: LocalTreeError[] = []
		const ignored: LocalTreeIgnored[] = []
		const dir = await fs.readdir(this.sync.syncPair.localPath, {
			recursive: true,
			encoding: "utf-8"
		})

		await promiseAllSettledChunked(
			dir.map(async entry => {
				if (entry.startsWith(LOCAL_TRASH_NAME)) {
					return
				}

				const itemPath = pathModule.join(this.sync.syncPair.localPath, entry)

				if (this.sync.localIgnorer.ignores(entry)) {
					ignored.push({
						localPath: itemPath,
						relativePath: entry,
						reason: "localIgnore"
					})

					return
				}

				if (
					isDirectoryPathIgnoredByDefault(entry) ||
					isRelativePathIgnoredByDefault(entry) ||
					isSystemPathIgnoredByDefault(itemPath)
				) {
					ignored.push({
						localPath: itemPath,
						relativePath: entry,
						reason: "defaultIgnore"
					})

					return
				}

				const entryPath = `/${isWindows ? entry.replace(/\\/g, "/") : entry}`
				const itemName = pathModule.posix.basename(entryPath)

				if (itemName.startsWith(LOCAL_TRASH_NAME)) {
					return
				}

				if (this.sync.excludeDotFiles && itemName.startsWith(".")) {
					ignored.push({
						localPath: itemPath,
						relativePath: entry,
						reason: "dotFile"
					})

					return
				}

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
					this.sync.worker.logger.log("error", e, "filesystems.local.getDirectoryTree")

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
			errors,
			ignored,
			changed: true
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
			if (!err && events && events.length > 0) {
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
		const waitTimeout = SYNC_INTERVAL * 2

		await new Promise<void>(resolve => {
			if (Date.now() > this.lastDirectoryChangeTimestamp + waitTimeout) {
				resolve()

				return
			}

			const wait = setInterval(() => {
				if (Date.now() > this.lastDirectoryChangeTimestamp + waitTimeout) {
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

	public async unlink({ relativePath, permanent = false }: { relativePath: string; permanent?: boolean }): Promise<void> {
		const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)

		if (!permanent) {
			const localTrashPath = pathModule.join(this.sync.syncPair.localPath, LOCAL_TRASH_NAME)

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

	public async rename({ fromRelativePath, toRelativePath }: { fromRelativePath: string; toRelativePath: string }): Promise<fs.Stats> {
		const fromLocalPath = pathModule.join(this.sync.syncPair.localPath, fromRelativePath)
		const toLocalPath = pathModule.join(this.sync.syncPair.localPath, toRelativePath)
		const fromLocalPathParentPath = pathModule.dirname(fromLocalPath)
		const toLocalPathParentPath = pathModule.dirname(toLocalPath)

		if (!(await fs.exists(toLocalPathParentPath))) {
			throw new Error(`Could not rename ${fromLocalPath} to ${toLocalPath}: Parent directory missing.`)
		}

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
		const stats = await fs.stat(localPath)

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
				localPath,
				size: stats.size
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
					this.sync.worker.logger.log("error", err, "filesystems.local.upload")

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: "upload",
							type: "error",
							relativePath,
							localPath,
							error: serializeError(err),
							size: stats.size
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
							bytes,
							size: stats.size
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
							localPath,
							size: stats.size
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
					localPath,
					size: stats.size
				}
			})

			return item
		} catch (e) {
			this.sync.worker.logger.log("error", e, "filesystems.local.upload")

			if (e instanceof Error) {
				postMessageToMain({
					type: "transfer",
					syncPair: this.sync.syncPair,
					data: {
						of: "upload",
						type: "error",
						relativePath,
						localPath,
						error: serializeError(e),
						size: stats.size
					}
				})
			}

			throw e
		} finally {
			delete this.sync.pauseSignals[signalKey]
			delete this.sync.abortControllers[signalKey]
		}
	}

	public async isPathWritable(path: string): Promise<boolean> {
		try {
			await fs.access(path, fs.constants.W_OK | fs.constants.R_OK)

			return true
		} catch {
			return false
		}
	}

	public async isPathReadable(path: string): Promise<boolean> {
		try {
			await fs.access(path, fs.constants.R_OK)

			return true
		} catch {
			return false
		}
	}
}

export default LocalFileSystem
