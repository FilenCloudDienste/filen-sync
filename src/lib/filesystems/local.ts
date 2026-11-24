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
	isValidPath,
	isSyncedIgnoreFile,
	caseCollisionIncumbentWins,
	assertPathWithinSyncRoot
} from "../../utils"
import pathModule from "path"
import type Sync from "../sync"
import { SYNC_INTERVAL, LOCAL_TRASH_NAME, LOCAL_RESCAN_SAFETY_INTERVAL } from "../../constants"
import crypto from "crypto"
import { pipeline } from "stream"
import { promisify } from "util"
import { type CloudItem, PauseSignal } from "@filen/sdk"
import { postMessageToMain } from "../ipc"
import { Semaphore } from "../../semaphore"
import { v4 as uuidv4 } from "uuid"
import { type SyncWatcher, type SyncGlobFS } from "../environment"
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
 * are queued. Batches run sequentially; case-collision winners are resolved up front (see computeLocalCaseWinners),
 * independent of batch order.
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

/**
 * Decide the deterministic winner for each case-insensitive path collision among the raw fast-glob entries
 * (markDirectories form: a trailing "/" marks a directory), returning the SET of winning raw entries. Pure and
 * order-independent (exported for testing): feeding the same entries in any order yields the same winners, so the local
 * tree does not flip between scans and cause churn. The scan gate then keeps an entry iff the set contains it — matching
 * by the raw entry so the main loop needs no second lowercasing. See {@link caseCollisionIncumbentWins}.
 *
 * @param {readonly (string | null)[]} entries The raw fast-glob entries (with markDirectories trailing slash).
 * @returns {Set<string>} the winning raw entries.
 */
export function computeLocalCaseWinners(entries: readonly (string | null)[]): Set<string> {
	const winnerByLowercase = new Map<string, string>()

	for (const rawEntry of entries) {
		if (typeof rawEntry !== "string") {
			continue
		}

		const isDirectory = rawEntry.endsWith("/")
		const entryItem = isDirectory ? rawEntry.slice(0, -1) : rawEntry

		if (entryItem.length === 0) {
			continue
		}

		// Per-entry cost is one toLowerCase (no path allocation); the "/"-rooted paths the comparator expects are only
		// materialised on an actual collision (rare). A shared leading "/" cannot change two names' relative order, so the
		// lowercased bare item is a sound collision key.
		const lowercase = entryItem.toLowerCase()
		const incumbentEntry = winnerByLowercase.get(lowercase)

		if (incumbentEntry === undefined) {
			winnerByLowercase.set(lowercase, rawEntry)

			continue
		}

		const incumbentIsDirectory = incumbentEntry.endsWith("/")
		const incumbentItem = incumbentIsDirectory ? incumbentEntry.slice(0, -1) : incumbentEntry

		if (!caseCollisionIncumbentWins({ path: "/" + incumbentItem, isDirectory: incumbentIsDirectory }, "/" + entryItem, isDirectory)) {
			winnerByLowercase.set(lowercase, rawEntry)
		}
	}

	return new Set(winnerByLowercase.values())
}

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
		// How many directory enumerations (readdir) FAILED during the scan. >0 means the walk is INCOMPLETE:
		// a subtree was silently omitted (FastGlob's suppressErrors swallows the error), which the caller must
		// NOT mistake for a deletion. Mirrors remote.ts's decryptErrors; sync.ts carries the base forward.
		scanIncomplete: number
	} = {
		timestamp: 0,
		tree: {},
		inodes: {},
		ignored: [],
		errors: [],
		size: 0,
		scanIncomplete: 0
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
		// Key the cache by path AND type: the .filenignore verdict is type-dependent (a dir-only rule like
		// `build/` ignores `build` as a DIRECTORY but not as a FILE), so a bare-path key returned the stale
		// directory verdict after a `build` dir was replaced by a same-named file — the file was then silently
		// never backed up for the whole session (re-opened BUG-005). Matches remote.ts's `path + ":" + type`.
		const key = relativePath + ":" + type
		// One cache lookup, not two — this runs per file on every scan (a cache hit for every unchanged
		// path now that the cache survives a cycle), so the second redundant get() was pure overhead.
		const cached = this.ignoredCache.get(key)

		if (cached) {
			return cached
		}

		if (isPathOverMaxLength(absolutePath)) {
			this.ignoredCache.set(key, {
				ignored: true,
				reason: "pathLength"
			})

			return {
				ignored: true,
				reason: "pathLength"
			}
		}

		if (isNameOverMaxLength(pathModule.basename(absolutePath))) {
			this.ignoredCache.set(key, {
				ignored: true,
				reason: "nameLength"
			})

			return {
				ignored: true,
				reason: "nameLength"
			}
		}

		if (!isValidPath(absolutePath)) {
			this.ignoredCache.set(key, {
				ignored: true,
				reason: "invalidPath"
			})

			return {
				ignored: true,
				reason: "invalidPath"
			}
		}

		if (isRelativePathIgnoredByDefault(relativePath) || isAbsolutePathIgnoredByDefault(absolutePath)) {
			this.ignoredCache.set(key, {
				ignored: true,
				reason: "defaultIgnore"
			})

			return {
				ignored: true,
				reason: "defaultIgnore"
			}
		}

		// The root .filenignore is exempt from the dotfile filter so the shared ignore-config syncs even when
		// excludeDotFiles is on; an explicit .filenignore rule below can still exclude it. (see isSyncedIgnoreFile)
		if (this.sync.excludeDotFiles && pathIncludesDotFile(relativePath) && !isSyncedIgnoreFile(relativePath)) {
			this.ignoredCache.set(key, {
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
			this.ignoredCache.set(key, {
				ignored: true,
				reason: "filenIgnore"
			})

			return {
				ignored: true,
				reason: "filenIgnore"
			}
		}

		this.ignoredCache.set(key, {
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
		scanIncomplete: number
	}> {
		return new Promise<{
			result: LocalTree
			errors: LocalTreeError[]
			ignored: LocalTreeIgnored[]
			changed: boolean
			scanIncomplete: number
			// eslint-disable-next-line no-async-promise-executor
		}>(async (resolve, reject) => {
			try {
				if (
					this.lastDirectoryChangeTimestamp > 0 &&
					this.getDirectoryTreeCache.timestamp > 0 &&
					this.lastDirectoryChangeTimestamp < this.getDirectoryTreeCache.timestamp &&
					// SAFETY RESCAN (#16): only serve the cache while it is still FRESH. fs.watch on SMB/NFS (and some
					// FUSE mounts) can silently DROP a change notification, so lastDirectoryChangeTimestamp never moves
					// and this gate would otherwise serve the stale tree FOREVER — the change never syncs. Once the
					// cache ages past LOCAL_RESCAN_SAFETY_INTERVAL, fall through to a full re-enumeration regardless.
					// This is a per-call check, NOT a recurring timer, so it costs a rescan at most once per interval
					// (the watcher still handles the common fast path) and never leaves a timer running.
					Date.now() - this.getDirectoryTreeCache.timestamp < LOCAL_RESCAN_SAFETY_INTERVAL
				) {
					resolve({
						result: {
							tree: this.getDirectoryTreeCache.tree,
							inodes: this.getDirectoryTreeCache.inodes,
							size: this.getDirectoryTreeCache.size
						},
						errors: this.getDirectoryTreeCache.errors,
						ignored: this.getDirectoryTreeCache.ignored,
						changed: false,
						scanIncomplete: this.getDirectoryTreeCache.scanIncomplete
					})

					return
				}

				this.getDirectoryTreeCache.tree = {}
				this.getDirectoryTreeCache.inodes = {}
				this.getDirectoryTreeCache.ignored = []
				this.getDirectoryTreeCache.errors = []
				this.getDirectoryTreeCache.size = 0
				this.getDirectoryTreeCache.scanIncomplete = 0

				// Stamp the cache as of the moment the walk BEGINS, not when it ends. The freshness check above
				// skips a rescan while `lastDirectoryChangeTimestamp < cache.timestamp`; a file edited DURING
				// this walk (after we lstat it, before the walk returns) fires the watcher with a change time
				// that is earlier than an end-of-walk stamp, so the next cycle would wrongly consider the cache
				// fresh and never re-read the edit — a silently lost update until some later change. Stamping at
				// the start guarantees any change racing with or following the walk has a change time >= this
				// stamp, so the strict `<` fails and the next cycle rescans.
				const scanStartedAt = Date.now()
				let size = 0
				// Prune provably-.filenignore'd subtrees from the walk ITSELF, so the scan never descends into,
				// stats, or even enumerates an ignored directory (e.g. node_modules) — and mark directories so an
				// entry's type is known from the glob WITHOUT an lstat. The prune globs are a strict subset of the
				// ignore matcher's set (Ignorer.globIgnorePatternsForTraversal), so they can never drop a path the
				// matcher keeps; anything they miss is still caught by the per-entry filter below.
				const traversalIgnoreGlobs = this.sync.ignorer.globIgnorePatternsForTraversal()
				// Count directory-enumeration (readdir) failures so an INCOMPLETE walk is not read as a mass
				// deletion. FastGlob's suppressErrors swallows a failing readdir and silently drops that whole
				// subtree; a transient EIO/EACCES on a network share would otherwise make every file under the
				// un-enumerable directory look deleted. We wrap only readdir (the enumeration) — per-entry lstat/
				// access failures are already recorded as `ignored` below. The wrapper adds one predicate per
				// readdir call (a handful per directory), never a per-file cost.
				let scanIncomplete = 0
				const globFs = this.sync.environment.globFs
				const baseReaddir = globFs.readdir as ((...args: unknown[]) => unknown) | undefined
				const baseReaddirSync = globFs.readdirSync as ((...args: unknown[]) => unknown) | undefined
				const countingGlobFs = {
					...globFs,
					...(baseReaddir
						? {
								readdir: ((path: string, ...rest: unknown[]): unknown => {
									const callback = rest[rest.length - 1]

									if (typeof callback === "function") {
										const wrapped = (error: NodeJS.ErrnoException | null, ...results: unknown[]): void => {
											if (error) {
												scanIncomplete++
											}

											;(callback as (error: NodeJS.ErrnoException | null, ...results: unknown[]) => void)(error, ...results)
										}

										return baseReaddir(path, ...rest.slice(0, -1), wrapped)
									}

									return baseReaddir(path, ...rest)
								}) as SyncGlobFS["readdir"]
						  }
						: {}),
					...(baseReaddirSync
						? {
								readdirSync: ((path: string, ...rest: unknown[]): unknown => {
									try {
										return baseReaddirSync(path, ...rest)
									} catch (e) {
										scanIncomplete++

										throw e
									}
								}) as SyncGlobFS["readdirSync"]
						  }
						: {})
				} as SyncGlobFS

				const entries = await FastGlob.async("**/*", {
					dot: true,
					onlyDirectories: false,
					onlyFiles: false,
					throwErrorOnBrokenSymbolicLink: false,
					cwd: this.sync.syncPair.localPath,
					followSymbolicLinks: false,
					deep: Infinity,
					fs: countingGlobFs,
					suppressErrors: true,
					stats: false,
					unique: false,
					objectMode: false,
					markDirectories: true,
					...(traversalIgnoreGlobs.length > 0 ? { ignore: traversalIgnoreGlobs } : {})
				})

				// Resolve case-insensitive collisions deterministically up front (order-independent), so the surviving
				// variant is stable across scans regardless of the filesystem's traversal order — otherwise it could flip
				// between runs and churn. Cheap synchronous string pass; the lstat/add below still runs only for winners.
				const caseWinners = computeLocalCaseWinners(entries as unknown as (string | null)[])

				for (let offset = 0; offset < entries.length; offset += LOCAL_SCAN_CONCURRENCY) {
					await Promise.all(entries.slice(offset, offset + LOCAL_SCAN_CONCURRENCY).map(async rawEntry => {
						const markedEntry = rawEntry as unknown as string | null

						if (!markedEntry) {
							return
						}

						// markDirectories appends a trailing "/" to a directory — this gives us the entry's type for
						// the ignore check below WITHOUT an lstat. Strip it for the path/key (tree keys never carry it).
						const isDirectoryEntry = markedEntry.endsWith("/")
						const entryItem = isDirectoryEntry ? markedEntry.slice(0, -1) : markedEntry

						if (entryItem.length === 0) {
							return
						}

						const entryPath = "/" + entryItem

						// Skip the local trash directory's contents, matching the REMOTE build's BOUNDARY semantics
						// (name.startsWith), NOT a substring match. `includes` dropped any user path merely CONTAINING
						// ".filen.trash.local" mid-name (e.g. /notes/x.filen.trash.local.txt) — which the remote keeps — so
						// cloudToLocal re-downloaded it forever and the pair never converged. Skip only an entry whose
						// BASENAME starts with the trash prefix (the trash dir itself + a peer's same-named file, as the
						// remote does) or a descendant of the actual trash root. (#15)
						if (
							pathModule.posix.basename(entryItem).startsWith(LOCAL_TRASH_NAME) ||
							entryPath.startsWith("/" + LOCAL_TRASH_NAME + "/")
						) {
							return
						}

						const absolutePath = pathModule.join(this.sync.syncPair.localPath, entryItem)
						// A case-insensitive path can appear more than once (e.g. "Foo"/"foo" on a case-sensitive filesystem).
						// computeLocalCaseWinners already picked the deterministic winner (order-independent, matched by the raw
						// glob entry so no second lowercasing is needed here); keep only that exact entry, ignore the others.
						if (!caseWinners.has(markedEntry)) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: "duplicate"
							})

							return
						}

						// Filter BEFORE the lstat: every isPathIgnored check is path/name-string based and needs only
						// the entry type (which markDirectories already gave us), so an ignored entry costs no lstat or
						// access syscall. Glob-level pruning above already removed most .filenignore'd paths; this still
						// catches everything not safely prunable at the glob (nameLength/pathLength/invalidPath/
						// defaultIgnore/dotFile + glob/negation .filenignore rules + case-duplicates).
						const ignored = this.isPathIgnored(entryItem, absolutePath, isDirectoryEntry ? "directory" : "file")

						if (ignored.ignored) {
							this.getDirectoryTreeCache.ignored.push({
								localPath: absolutePath,
								relativePath: entryPath,
								reason: ignored.reason
							})

							return
						}

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
				this.getDirectoryTreeCache.scanIncomplete = scanIncomplete

				// Clear old local file hashes that are not present anymore. Skip this entirely when the scan was
				// INCOMPLETE: a hash whose path was merely omitted by a failed enumeration must survive (dropping
				// it would poison the md5 dedup and cause a spurious re-upload once the subtree re-appears).
				if (scanIncomplete === 0) {
					for (const path in this.sync.localFileHashes) {
						if (!this.getDirectoryTreeCache.tree[path]) {
							delete this.sync.localFileHashes[path]
						}
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
					changed: true,
					scanIncomplete
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
			}, LOCAL_RESCAN_SAFETY_INTERVAL)
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

		// Sink guard: never read outside the sync root (uniform with the write sinks).
		assertPathWithinSyncRoot(this.sync.syncPair.localPath, localPath)

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

			// Sink guard: a malicious `..` remote name must never create a directory outside the sync root.
			assertPathWithinSyncRoot(this.sync.syncPair.localPath, localPath)

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

	/**
	 * Return a path inside the local trash that doesn't exist yet: `<name>` if free, otherwise
	 * `<stem> (n)<ext>` (files) or `<name> (n)` (directories).
	 */
	private async uniqueLocalTrashPath(localTrashPath: string, name: string, isDirectory: boolean): Promise<string> {
		const first = pathModule.join(localTrashPath, name)

		if (!(await this.sync.environment.fs.exists(first))) {
			return first
		}

		const ext = isDirectory ? "" : pathModule.extname(name)
		const stem = ext.length > 0 ? name.slice(0, -ext.length) : name

		for (let i = 1; i <= 10000; i++) {
			const candidate = pathModule.join(localTrashPath, `${stem} (${i})${ext}`)

			if (!(await this.sync.environment.fs.exists(candidate))) {
				return candidate
			}
		}

		return pathModule.join(localTrashPath, `${stem} (${Date.now()})${ext}`)
	}

	public async unlink({ relativePath, permanent = false }: { relativePath: string; permanent?: boolean }): Promise<void> {
		await this.mutex.acquire()

		try {
			const item = this.getDirectoryTreeCache.tree[relativePath]

			if (!item) {
				return
			}

			const localPath = pathModule.join(this.sync.syncPair.localPath, relativePath)

			// Sink guard: a delete/trash-move must never target a path outside the sync root (a malicious `..`
			// name could otherwise delete arbitrary user data). The tree-membership check above already blocks it.
			assertPathWithinSyncRoot(this.sync.syncPair.localPath, localPath)

			try {
				if (!permanent && !this.sync.localTrashDisabled) {
					const localTrashPath = pathModule.join(this.sync.syncPair.localPath, LOCAL_TRASH_NAME)

					await this.sync.environment.fs.ensureDir(localTrashPath)

					// The trash is flat (keyed by basename), so deleting `/a/report.txt` and later `/b/report.txt`
					// would otherwise overwrite the first file's only local recovery copy. Pick a free name instead.
					const trashDestination = await this.uniqueLocalTrashPath(
						localTrashPath,
						pathModule.posix.basename(relativePath),
						item.type === "directory"
					)

					await this.sync.environment.fs.move(localPath, trashDestination, {
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

			// Only a DIRECTORY has descendants to evict. Scanning the whole tree for children of a FILE finds
			// nothing (a file has none) — and running that O(tree) scan on every unlink made a bulk deletion
			// O(N²): deleting a large flat folder appeared to hang for minutes. A file is removed by the three
			// direct deletes above; skip the subtree walk for it entirely. (#9)
			if (item.type === "directory") {
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

			// Sink guard (defense in depth): a rename/move must never target the sync root or escape it - fs-extra
			// move overwrites and, for a cross-directory move, removes the destination first, so an out-of-root
			// target (a malicious `..` name) could delete data outside the pair. Both endpoints must stay strictly
			// inside the root.
			assertPathWithinSyncRoot(this.sync.syncPair.localPath, fromLocalPath)
			assertPathWithinSyncRoot(this.sync.syncPair.localPath, toLocalPath)

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

		// Sink guard: never read/upload a file from outside the sync root (uniform with the write sinks).
		assertPathWithinSyncRoot(this.sync.syncPair.localPath, localPath)

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
