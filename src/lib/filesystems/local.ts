import fs from "fs-extra"
import watcher from "@parcel/watcher"
import {
	promiseAllChunked,
	isRelativePathIgnoredByDefault,
	serializeError,
	replacePathStartWithFromAndTo,
	pathIncludesDotFile,
	normalizeUTime
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
import { Semaphore } from "../../semaphore"
import { v4 as uuidv4 } from "uuid"

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
	uuid: string
}
export type LocalTreeIgnoredReason =
	| "dotFile"
	| "filenIgnore"
	| "defaultIgnore"
	| "empty"
	| "symlink"
	| "invalidType"
	| "duplicate"
	| "permissions"
export type LocalTreeIgnored = {
	localPath: string
	relativePath: string
	reason: LocalTreeIgnoredReason
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
		ignored: LocalTreeIgnored[]
		errors: LocalTreeError[]
	} = {
		timestamp: 0,
		tree: {},
		inodes: {},
		ignored: [],
		errors: []
	}
	public watcherRunning = false
	private watcherInstance: watcher.AsyncSubscription | null = null
	public readonly itemsMutex = new Semaphore(1)
	public readonly mutex = new Semaphore(1)
	public readonly mkdirMutex = new Semaphore(1)
	public readonly listSemaphore = new Semaphore(64)
	public readonly watcherMutex = new Semaphore(1)

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
				errors: this.getDirectoryTreeCache.errors,
				ignored: this.getDirectoryTreeCache.ignored,
				changed: false
			}
		}

		const isWindows = process.platform === "win32"
		const pathsAdded: Record<string, boolean> = {}

		const dir = await fs.readdir(this.sync.syncPair.localPath, {
			recursive: true,
			encoding: "utf-8"
		})

		this.getDirectoryTreeCache.tree = {}
		this.getDirectoryTreeCache.inodes = {}
		this.getDirectoryTreeCache.ignored = []
		this.getDirectoryTreeCache.errors = []

		await promiseAllChunked(
			dir.map(async entry => {
				await this.listSemaphore.acquire()

				try {
					const entryPath = `/${isWindows ? entry.replace(/\\/g, "/") : entry}`

					if (entryPath.includes(LOCAL_TRASH_NAME)) {
						return
					}

					const itemPath = pathModule.join(this.sync.syncPair.localPath, entry)

					if (isRelativePathIgnoredByDefault(entryPath)) {
						this.getDirectoryTreeCache.ignored.push({
							localPath: itemPath,
							relativePath: entry,
							reason: "defaultIgnore"
						})

						return
					}

					if (this.sync.excludeDotFiles && pathIncludesDotFile(entryPath)) {
						this.getDirectoryTreeCache.ignored.push({
							localPath: itemPath,
							relativePath: entry,
							reason: "dotFile"
						})

						return
					}

					if (this.sync.ignorer.ignores(entry)) {
						this.getDirectoryTreeCache.ignored.push({
							localPath: itemPath,
							relativePath: entry,
							reason: "filenIgnore"
						})

						return
					}

					try {
						await fs.access(itemPath, fs.constants.R_OK | fs.constants.W_OK)
					} catch {
						this.getDirectoryTreeCache.ignored.push({
							localPath: itemPath,
							relativePath: entry,
							reason: "permissions"
						})

						return
					}

					try {
						const stats = await fs.lstat(itemPath)

						if (stats.isBlockDevice() || stats.isCharacterDevice() || stats.isFIFO() || stats.isSocket()) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: itemPath,
								relativePath: entry,
								reason: "invalidType"
							})

							return
						}

						if (stats.isSymbolicLink()) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: itemPath,
								relativePath: entry,
								reason: "symlink"
							})

							return
						}

						if (stats.isFile() && stats.size <= 0) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: itemPath,
								relativePath: entry,
								reason: "empty"
							})

							return
						}

						const lowercasePath = entryPath.toLowerCase()

						if (pathsAdded[lowercasePath]) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: itemPath,
								relativePath: entry,
								reason: "duplicate"
							})

							return
						}

						pathsAdded[lowercasePath] = true

						const item: LocalItem = {
							lastModified: normalizeUTime(stats.mtimeMs), // Sometimes comes as a float, but we need an int
							type: stats.isDirectory() ? "directory" : "file",
							path: entryPath,
							creation: normalizeUTime(stats.birthtimeMs), // Sometimes comes as a float, but we need an int
							size: stats.size,
							inode: stats.ino
						}

						this.getDirectoryTreeCache.tree[entryPath] = item
						this.getDirectoryTreeCache.inodes[item.inode] = item
					} catch (e) {
						this.sync.worker.logger.log("error", e, "filesystems.local.getDirectoryTree")
						this.sync.worker.logger.log("error", e)

						if (e instanceof Error) {
							this.getDirectoryTreeCache.errors.push({
								localPath: itemPath,
								relativePath: entryPath,
								error: e,
								uuid: uuidv4()
							})
						}
					}
				} finally {
					this.listSemaphore.release()
				}
			})
		)

		this.getDirectoryTreeCache.timestamp = Date.now()

		return {
			result: {
				tree: this.getDirectoryTreeCache.tree,
				inodes: this.getDirectoryTreeCache.inodes
			},
			errors: this.getDirectoryTreeCache.errors,
			ignored: this.getDirectoryTreeCache.ignored,
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
		await this.watcherMutex.acquire()

		try {
			if (this.watcherInstance) {
				return
			}

			this.watcherInstance = await watcher.subscribe(
				this.sync.syncPair.localPath,
				(err, events) => {
					if (!err && events && events.length > 0) {
						this.lastDirectoryChangeTimestamp = Date.now()
					}
				},
				{
					ignore: [".filen.trash.local"],
					backend:
						process.platform === "win32"
							? "windows"
							: process.platform === "darwin"
							? "fs-events"
							: process.platform === "linux"
							? "inotify"
							: undefined
				}
			)
		} finally {
			this.watcherMutex.release()
		}
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
		await this.watcherMutex.acquire()

		try {
			if (!this.watcherInstance) {
				return
			}

			await this.watcherInstance.unsubscribe()

			this.watcherInstance = null
		} finally {
			this.watcherMutex.release()
		}
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

		if (Date.now() > this.lastDirectoryChangeTimestamp + waitTimeout) {
			return
		}

		postMessageToMain({
			type: "cycleWaitingForLocalDirectoryChangesStarted",
			syncPair: this.sync.syncPair
		})

		const maxWaitTimeout = Date.now() + 60000 * 15

		await new Promise<void>(resolve => {
			const wait = setInterval(() => {
				if (Date.now() > maxWaitTimeout) {
					clearInterval(wait)

					resolve()

					return
				}

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
		await this.mkdirMutex.acquire()

		try {
			const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)

			await fs.ensureDir(localPath)

			const stats = await fs.stat(localPath)

			await this.itemsMutex.acquire()

			const item: LocalItem = {
				type: "directory",
				inode: stats.ino,
				lastModified: normalizeUTime(stats.mtimeMs), // Sometimes comes as a float, but we need an int
				creation: normalizeUTime(stats.birthtimeMs), // Sometimes comes as a float, but we need an int
				size: 0,
				path: relativePath
			}

			this.getDirectoryTreeCache.tree[relativePath] = item
			this.getDirectoryTreeCache.inodes[item.inode] = item

			this.itemsMutex.release()

			return stats
		} finally {
			this.mkdirMutex.release()
		}
	}

	public async unlink({ relativePath, permanent = false }: { relativePath: string; permanent?: boolean }): Promise<void> {
		await this.mutex.acquire()

		try {
			const item = this.getDirectoryTreeCache.tree[relativePath]

			if (!item) {
				return
			}

			const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)

			if (!permanent && !this.sync.localTrashDisabled) {
				const localTrashPath = pathModule.join(this.sync.syncPair.localPath, LOCAL_TRASH_NAME)

				await fs.ensureDir(localTrashPath)
				await fs.move(localPath, pathModule.join(localTrashPath, pathModule.posix.basename(relativePath)), {
					overwrite: true
				})
			} else {
				await fs.rm(localPath, {
					force: true,
					maxRetries: 60 * 10,
					recursive: true,
					retryDelay: 100
				})
			}

			await this.itemsMutex.acquire()

			delete this.getDirectoryTreeCache.tree[relativePath]
			delete this.getDirectoryTreeCache.inodes[item.inode]
			delete this.sync.localFileHashes[relativePath]

			for (const entry in this.getDirectoryTreeCache.tree) {
				if (entry.startsWith(relativePath + "/") || entry === relativePath) {
					const entryItem = this.getDirectoryTreeCache.tree[entry]

					if (entryItem) {
						delete this.getDirectoryTreeCache.inodes[entryItem.inode]
					}

					delete this.sync.localFileHashes[entry]
					delete this.getDirectoryTreeCache.tree[entry]
				}
			}

			this.itemsMutex.release()
		} finally {
			this.mutex.release()
		}
	}

	public async rename({ fromRelativePath, toRelativePath }: { fromRelativePath: string; toRelativePath: string }): Promise<fs.Stats> {
		await this.mutex.acquire()

		try {
			if (fromRelativePath === "/" || toRelativePath === "/") {
				throw new Error("Invalid paths.")
			}

			const item = this.getDirectoryTreeCache.tree[fromRelativePath]

			if (!item) {
				throw new Error(`Could not rename ${fromRelativePath} to ${toRelativePath}: Path not found.`)
			}

			const fromLocalPath = pathModule.join(this.sync.syncPair.localPath, fromRelativePath)
			const toLocalPath = pathModule.join(this.sync.syncPair.localPath, toRelativePath)
			const fromLocalPathParentPath = pathModule.dirname(fromLocalPath)
			const toLocalPathParentPath = pathModule.dirname(toLocalPath)

			await fs.ensureDir(toLocalPathParentPath)

			if (
				fromLocalPathParentPath === toLocalPathParentPath ||
				Buffer.from(fromLocalPathParentPath, "utf-8").toString("hex") ===
					Buffer.from(toLocalPathParentPath, "utf-8").toString("hex")
			) {
				await fs.rename(fromLocalPath, toLocalPath)
			} else {
				if (toRelativePath.startsWith(fromRelativePath)) {
					throw new Error("Invalid paths.")
				}

				await fs.move(fromLocalPath, toLocalPath, {
					overwrite: true
				})
			}

			const stats = await fs.stat(toLocalPath)

			await this.itemsMutex.acquire()

			this.getDirectoryTreeCache.tree[toRelativePath] = {
				...item,
				path: toRelativePath
			}

			this.getDirectoryTreeCache.inodes[item.inode] = {
				...item,
				path: toRelativePath
			}

			delete this.getDirectoryTreeCache.tree[fromRelativePath]
			delete this.sync.localFileHashes[fromRelativePath]

			for (const oldPath in this.getDirectoryTreeCache.tree) {
				if (oldPath.startsWith(fromRelativePath + "/") && oldPath !== fromRelativePath) {
					const newPath = replacePathStartWithFromAndTo(oldPath, fromRelativePath, toRelativePath)
					const oldItem = this.getDirectoryTreeCache.tree[oldPath]

					if (oldItem) {
						this.getDirectoryTreeCache.tree[newPath] = {
							...oldItem,
							path: newPath
						}

						delete this.getDirectoryTreeCache.tree[oldPath]

						const oldItemInode = this.getDirectoryTreeCache.inodes[oldItem.inode]

						if (oldItemInode) {
							this.getDirectoryTreeCache.inodes[oldItem.inode] = {
								...oldItemInode,
								path: newPath
							}
						}
					}

					const oldItemHash = this.sync.localFileHashes[oldPath]

					if (oldItemHash) {
						this.sync.localFileHashes[newPath] = oldItemHash

						delete this.sync.localFileHashes[oldPath]
					}
				}
			}

			this.itemsMutex.release()

			return stats
		} finally {
			this.mutex.release()
		}
	}

	/**
	 * Upload a local file.
	 * @date 3/2/2024 - 9:43:58 PM
	 *
	 * @public
	 * @async
	 * @param {{ relativePath: string }} param0
	 * @param {string} param0.relativePath
	 * @returns {Promise<CloudItem>}
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
					this.sync.worker.logger.log("error", err)

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: "upload",
							type: "error",
							relativePath,
							localPath,
							error: serializeError(err),
							size: stats.size,
							uuid: uuidv4()
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
			this.sync.worker.logger.log("error", e)

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
						size: stats.size,
						uuid: uuidv4()
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

	public async pathExists(path: string): Promise<boolean> {
		try {
			return await fs.exists(path)
		} catch {
			return false
		}
	}
}

export default LocalFileSystem
