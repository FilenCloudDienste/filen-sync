import { type Stats } from "fs-extra"
import {
	isRelativePathIgnoredByDefault,
	serializeError,
	replacePathStartWithFromAndTo,
	pathIncludesDotFile,
	normalizeUTime,
	isAbsolutePathIgnoredByDefault,
	isPathOverMaxLength,
	isNameOverMaxLength,
	isValidPath
} from "../../utils"
import pathModule from "path"
import type Sync from "../sync"
import { SYNC_INTERVAL, LOCAL_TRASH_NAME } from "../../constants"
import crypto from "crypto"
import { pipeline } from "stream"
import { promisify } from "util"
import { type CloudItem, PauseSignal } from "@filen/sdk"
import { postMessageToMain } from "../ipc"
import { Semaphore } from "../../semaphore"
import { v4 as uuidv4 } from "uuid"
import { type SyncWatcher } from "../environment"
import FastGlob from "fast-glob"

const pipelineAsync = promisify(pipeline)

/**
 * Upper bound on how many local entries are stat'd concurrently during a single tree scan.
 *
 * The scan fans a filesystem `lstat` (+ `access`) out over every glob entry. Mapping all entries to
 * promises up front would, on a tree with millions of entries, allocate millions of pending promises
 * and in-flight stat results at once — an O(n) peak-memory spike on top of the (unavoidable) result
 * tree, plus unbounded pressure on the libuv thread pool and open file descriptors. Walking the entries
 * in fixed-size batches caps peak concurrency — and therefore peak memory — without reducing throughput,
 * since the thread pool only services a handful of these operations in parallel regardless of how many
 * are queued. Batches run sequentially, so the first-occurrence-wins dedup order is preserved exactly.
 */
export const LOCAL_SCAN_CONCURRENCY = 1000

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
	size: number
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
	| "pathLength"
	| "invalidPath"
	| "nameLength"

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
		size: number
	} = {
		timestamp: 0,
		tree: {},
		inodes: {},
		ignored: [],
		errors: [],
		size: 0
	}
	public watcherRunning = false
	private watcherInstance: SyncWatcher | null = null
	public readonly itemsMutex = new Semaphore(1)
	public readonly mutex = new Semaphore(1)
	public readonly mkdirMutex = new Semaphore(1)
	public readonly watcherMutex = new Semaphore(1)
	public watcherInstanceFallbackInterval: ReturnType<typeof setInterval> | undefined = undefined
	public ignoredCache = new Map<string, { ignored: true; reason: LocalTreeIgnoredReason } | { ignored: false }>()

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

	public isPathIgnored(
		relativePath: string,
		absolutePath: string,
		type: "file" | "directory"
	): { ignored: true; reason: LocalTreeIgnoredReason } | { ignored: false } {
		if (this.ignoredCache.get(relativePath)) {
			return this.ignoredCache.get(relativePath)!
		}

		if (isPathOverMaxLength(absolutePath)) {
			this.ignoredCache.set(relativePath, {
				ignored: true,
				reason: "pathLength"
			})

			return {
				ignored: true,
				reason: "pathLength"
			}
		}

		if (isNameOverMaxLength(pathModule.basename(absolutePath))) {
			this.ignoredCache.set(relativePath, {
				ignored: true,
				reason: "nameLength"
			})

			return {
				ignored: true,
				reason: "nameLength"
			}
		}

		if (!isValidPath(absolutePath)) {
			this.ignoredCache.set(relativePath, {
				ignored: true,
				reason: "invalidPath"
			})

			return {
				ignored: true,
				reason: "invalidPath"
			}
		}

		if (isRelativePathIgnoredByDefault(relativePath) || isAbsolutePathIgnoredByDefault(absolutePath)) {
			this.ignoredCache.set(relativePath, {
				ignored: true,
				reason: "defaultIgnore"
			})

			return {
				ignored: true,
				reason: "defaultIgnore"
			}
		}

		if (this.sync.excludeDotFiles && pathIncludesDotFile(relativePath)) {
			this.ignoredCache.set(relativePath, {
				ignored: true,
				reason: "dotFile"
			})

			return {
				ignored: true,
				reason: "dotFile"
			}
		}

		const trailingSlash = type === "directory" ? "/" : ""

		if (this.sync.ignorer.ignores(relativePath + trailingSlash)) {
			this.ignoredCache.set(relativePath, {
				ignored: true,
				reason: "filenIgnore"
			})

			return {
				ignored: true,
				reason: "filenIgnore"
			}
		}

		this.ignoredCache.set(relativePath, {
			ignored: false
		})

		return {
			ignored: false
		}
	}

	public async getDirectoryTree(): Promise<{
		result: LocalTree
		errors: LocalTreeError[]
		ignored: LocalTreeIgnored[]
		changed: boolean
	}> {
		return new Promise<{
			result: LocalTree
			errors: LocalTreeError[]
			ignored: LocalTreeIgnored[]
			changed: boolean
			// eslint-disable-next-line no-async-promise-executor
		}>(async (resolve, reject) => {
			try {
				if (
					this.lastDirectoryChangeTimestamp > 0 &&
					this.getDirectoryTreeCache.timestamp > 0 &&
					this.lastDirectoryChangeTimestamp < this.getDirectoryTreeCache.timestamp
				) {
					resolve({
						result: {
							tree: this.getDirectoryTreeCache.tree,
							inodes: this.getDirectoryTreeCache.inodes,
							size: this.getDirectoryTreeCache.size
						},
						errors: this.getDirectoryTreeCache.errors,
						ignored: this.getDirectoryTreeCache.ignored,
						changed: false
					})

					return
				}

				this.getDirectoryTreeCache.tree = {}
				this.getDirectoryTreeCache.inodes = {}
				this.getDirectoryTreeCache.ignored = []
				this.getDirectoryTreeCache.errors = []
				this.getDirectoryTreeCache.size = 0

				// Stamp the cache as of the moment the walk BEGINS, not when it ends. The freshness check above
				// skips a rescan while `lastDirectoryChangeTimestamp < cache.timestamp`; a file edited DURING
				// this walk (after we lstat it, before the walk returns) fires the watcher with a change time
				// that is earlier than an end-of-walk stamp, so the next cycle would wrongly consider the cache
				// fresh and never re-read the edit — a silently lost update until some later change. Stamping at
				// the start guarantees any change racing with or following the walk has a change time >= this
				// stamp, so the strict `<` fails and the next cycle rescans.
				const scanStartedAt = Date.now()
				const pathsAdded: Record<string, boolean> = {}
				let size = 0
				const entries = await FastGlob.async("**/*", {
					dot: true,
					onlyDirectories: false,
					onlyFiles: false,
					throwErrorOnBrokenSymbolicLink: false,
					cwd: this.sync.syncPair.localPath,
					followSymbolicLinks: false,
					deep: Infinity,
					fs: this.sync.environment.globFs,
					suppressErrors: true,
					stats: false,
					unique: false,
					objectMode: false
				})

				for (let offset = 0; offset < entries.length; offset += LOCAL_SCAN_CONCURRENCY) {
					await Promise.all(entries.slice(offset, offset + LOCAL_SCAN_CONCURRENCY).map(async entry => {
						const entryItem = entry as unknown as string | null

						if (!entryItem) {
							return
						}

						const entryPath = "/" + entryItem

						if (entryPath.includes(LOCAL_TRASH_NAME)) {
							return
						}

						const absolutePath = pathModule.join(this.sync.syncPair.localPath, entryItem)
						const lowercasePath = entryPath.toLowerCase()

						if (pathsAdded[lowercasePath]) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: "duplicate"
							})

							return
						}

						pathsAdded[lowercasePath] = true

						let stats: Stats

						try {
							// lstat (not stat) so a symlink is detected as a link rather than followed to its
							// target — symlinks are skipped structurally below (reason "symlink") instead of being
							// silently dereferenced (which collided on the target's inode and caused churn).
							stats = await this.sync.environment.fs.lstat(absolutePath)
						} catch {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: "permissions"
							})

							return
						}

						const ignored = this.isPathIgnored(entryItem, absolutePath, stats.isFile() ? "file" : "directory")

						if (ignored.ignored) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: ignored.reason
							})

							return
						}

						if (stats.isBlockDevice() || stats.isCharacterDevice() || stats.isFIFO() || stats.isSocket()) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: "invalidType"
							})

							return
						}

						if (stats.isSymbolicLink()) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: "symlink"
							})

							return
						}

						try {
							await this.sync.environment.fs.access(absolutePath, this.sync.environment.fs.constants.R_OK)
						} catch {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: "permissions"
							})

							return
						}

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

						size += 1
					}))
				}

				this.getDirectoryTreeCache.size = size
				this.getDirectoryTreeCache.timestamp = scanStartedAt

				// Clear old local file hashes that are not present anymore
				for (const path in this.sync.localFileHashes) {
					if (!this.getDirectoryTreeCache.tree[path]) {
						delete this.sync.localFileHashes[path]
					}
				}

				resolve({
					result: {
						tree: this.getDirectoryTreeCache.tree,
						inodes: this.getDirectoryTreeCache.inodes,
						size: this.getDirectoryTreeCache.size
					},
					errors: this.getDirectoryTreeCache.errors,
					ignored: this.getDirectoryTreeCache.ignored,
					changed: true
				})
			} catch (e) {
				reject(e)
			}
		})
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

			this.watcherInstance = await this.sync.environment.createWatcher(this.sync.syncPair.localPath, () => {
				this.lastDirectoryChangeTimestamp = Date.now()
			})

			clearInterval(this.watcherInstanceFallbackInterval)
		} catch (e) {
			this.sync.worker.logger.log("error", e, "startDirectoryWatcher")
			this.sync.worker.logger.log("error", e)

			if (e instanceof Error) {
				postMessageToMain({
					type: "localDirectoryWatcherError",
					syncPair: this.sync.syncPair,
					data: {
						error: serializeError(e),
						uuid: uuidv4()
					}
				})
			}

			clearInterval(this.watcherInstanceFallbackInterval)

			this.lastDirectoryChangeTimestamp = Date.now()

			this.watcherInstanceFallbackInterval = setInterval(() => {
				this.lastDirectoryChangeTimestamp = Date.now()
			}, 60000)
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

		clearInterval(this.watcherInstanceFallbackInterval)

		try {
			if (this.watcherInstance) {
				await this.watcherInstance.close()

				this.watcherInstance = null
			}
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
		const waitTimeout = SYNC_INTERVAL

		if (Date.now() > this.lastDirectoryChangeTimestamp + waitTimeout) {
			return
		}

		postMessageToMain({
			type: "cycleWaitingForLocalDirectoryChangesStarted",
			syncPair: this.sync.syncPair
		})

		const maxWaitTimeout = Date.now() + SYNC_INTERVAL * 3

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

		await pipelineAsync(this.sync.environment.fs.createReadStream(localPath), hasher)

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
	 * @returns {Promise<Stats>}
	 */
	public async mkdir({ relativePath }: { relativePath: string }): Promise<Stats> {
		await this.mkdirMutex.acquire()

		try {
			const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)

			await this.sync.environment.fs.ensureDir(localPath)

			const stats = await this.sync.environment.fs.stat(localPath)

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

			try {
				if (!permanent && !this.sync.localTrashDisabled) {
					const localTrashPath = pathModule.join(this.sync.syncPair.localPath, LOCAL_TRASH_NAME)

					await this.sync.environment.fs.ensureDir(localTrashPath)
					await this.sync.environment.fs.move(localPath, pathModule.join(localTrashPath, pathModule.posix.basename(relativePath)), {
						overwrite: true
					})
				} else {
					await this.sync.environment.fs.rm(localPath, {
						force: true,
						maxRetries: 60 * 10,
						recursive: true,
						retryDelay: 100
					})
				}
			} catch (e) {
				// The source vanished between the tree scan and this delete (the same path removed on both sides
				// in one cycle, or an external removal). The intended end state — the path gone — already holds,
				// so fall through to evict the cache entry instead of throwing. Leaving it would persist a
				// PHANTOM entry into the base tree; a later re-creation at that path would then be mis-read as a
				// local deletion to propagate, deleting the freshly re-created file. Only swallow when the source
				// is confirmed gone — any other failure (permissions, destination, disk) still throws. This
				// mirrors the remote unlink, which already cleans its cache entry on file_not_found. (F4)
				if (await this.pathExists(localPath)) {
					throw e
				}
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

	public async rename({ fromRelativePath, toRelativePath }: { fromRelativePath: string; toRelativePath: string }): Promise<Stats> {
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

			await this.sync.environment.fs.ensureDir(toLocalPathParentPath)

			if (
				fromLocalPathParentPath === toLocalPathParentPath ||
				Buffer.from(fromLocalPathParentPath, "utf-8").toString("hex") ===
					Buffer.from(toLocalPathParentPath, "utf-8").toString("hex")
			) {
				await this.sync.environment.fs.rename(fromLocalPath, toLocalPath)
			} else {
				if (toRelativePath.startsWith(fromRelativePath + pathModule.sep)) {
					throw new Error("Invalid paths.")
				}

				await this.sync.environment.fs.move(fromLocalPath, toLocalPath, {
					overwrite: true
				})
			}

			const stats = await this.sync.environment.fs.stat(toLocalPath)

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
	 *
	 * @public
	 * @async
	 * @param {{ relativePath: string, passedMD5Hash?: string }} param0
	 * @param {string} param0.relativePath
	 * @param {string} param0.passedMD5Hash
	 * @returns {Promise<CloudItem>}
	 */
	public async upload({
		relativePath,
		passedMD5Hash
	}: {
		relativePath: string
		passedMD5Hash?: string | undefined
	}): Promise<CloudItem> {
		const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)
		const signalKey = `upload:${relativePath}`
		const stats = await this.sync.environment.fs.stat(localPath)

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

			const md5Hash = passedMD5Hash
				? passedMD5Hash
				: await this.createFileHash({
						relativePath,
						algorithm: "md5"
				  })

			const item = await this.sync.sdk.cloud().uploadLocalFile({
				source: localPath,
				parent: parentUUID,
				name: pathModule.basename(localPath),
				pauseSignal: this.sync.pauseSignals[signalKey]!,
				abortSignal: this.sync.abortControllers[signalKey]!.signal,
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

			// Record the dedup hash only AFTER the upload durably succeeds. Writing it before the await would
			// poison the cache on a failed upload: because the task error gates the cycle and leaves the base
			// unchanged, a later retry (after the host calls resetTaskErrors, which does NOT clear
			// localFileHashes) would recompute the same hash, find it already cached, and SUPPRESS the
			// re-upload — silently dropping the local edit and diverging the sides permanently. (F1)
			this.sync.localFileHashes[relativePath] = md5Hash

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
			await this.sync.environment.fs.access(path, this.sync.environment.fs.constants.W_OK | this.sync.environment.fs.constants.R_OK)

			return true
		} catch {
			return false
		}
	}

	public async isPathReadable(path: string): Promise<boolean> {
		try {
			await this.sync.environment.fs.access(path, this.sync.environment.fs.constants.R_OK)

			return true
		} catch {
			return false
		}
	}

	public async pathExists(path: string): Promise<boolean> {
		try {
			return await this.sync.environment.fs.exists(path)
		} catch {
			return false
		}
	}
}

export default LocalFileSystem
