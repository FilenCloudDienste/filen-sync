import fsExtra from "fs-extra"
import fs from "fs"
import pathModule from "path"
import FastGlob from "fast-glob"
import writeFileAtomicReal from "write-file-atomic"
import { type SyncDirTreeFetcher, fetchDirTreeMsgpack } from "./filesystems/dirTree"
import { LOCAL_TRASH_NAME } from "../constants"

/**
 * The subset of the fs-extra promise API that the sync engine awaits directly.
 * The real implementation is fs-extra; tests inject an in-memory equivalent.
 */
export type SyncFS = Pick<
	typeof fsExtra,
	| "stat"
	| "lstat"
	| "access"
	| "exists"
	| "pathExists"
	| "ensureDir"
	| "mkdir"
	| "rm"
	| "move"
	| "rename"
	| "createReadStream"
	| "createWriteStream"
	| "readFile"
	| "writeFile"
	| "utimes"
	| "constants"
>

/**
 * Filesystem adapter handed to fast-glob (callback/sync API). fs-extra satisfies this; tests
 * pass an in-memory equivalent backed by the same storage as {@link SyncFS}.
 */
export type SyncGlobFS = Partial<FastGlob.FileSystemAdapter>

/**
 * Atomic file writer. Matches the single call shape the engine uses.
 */
export type SyncWriteFileAtomic = (filename: string, data: string, options: { encoding: BufferEncoding }) => Promise<void>

export type SyncWatcher = {
	close: () => Promise<void>
}

/**
 * Creates a recursive directory watcher that invokes `onChange` whenever something under `path`
 * changes. The default uses the native recursive `fs.watch`; tests inject a controllable no-op.
 */
export type SyncWatcherFactory = (path: string, onChange: () => void) => Promise<SyncWatcher>

/**
 * All external, side-effecting dependencies of the sync engine, gathered behind one injectable
 * object. {@link defaultEnvironment} wires the real implementations; tests pass fakes. Time is NOT
 * here on purpose — tests control it with fake timers.
 */
export type SyncEnvironment = {
	fs: SyncFS
	globFs: SyncGlobFS
	writeFileAtomic: SyncWriteFileAtomic
	createWatcher: SyncWatcherFactory
	/**
	 * Fetches the remote directory tree. Production uses a msgpack reimplementation of `/v3/dir/tree`;
	 * tests inject a fetcher backed by the fake cloud. Swappable so the wire format is not baked in.
	 */
	fetchDirTree: SyncDirTreeFetcher
}

/**
 * Whether a path relative to the sync root is the local trash or inside it. The watcher skips it: the engine never
 * syncs the trash, and downloads stage there (see {@link containRecursiveWatchRace}).
 */
export function isLocalTrashPath(relativePath: string): boolean {
	return (
		relativePath === LOCAL_TRASH_NAME ||
		relativePath.startsWith(LOCAL_TRASH_NAME + pathModule.sep) ||
		relativePath.startsWith(LOCAL_TRASH_NAME + "/")
	)
}

// Linux has no native recursive fs.watch; Node emulates it in JS (node:internal/fs/recursive_watch) with one
// inotify watch per directory.
const EMULATED_RECURSIVE_WATCH = process.platform !== "darwin" && process.platform !== "win32"
const RECURSIVE_WATCH_FRAME = "node:internal/fs/recursive_watch"

/**
 * Whether an uncaught error is the emulated recursive watcher losing a race with the filesystem. Since Node 24.22.0
 * it lstat()s or stat()s a reported path inside its own event callback, outside any try, tolerating only ENOENT:
 * when a watched directory is replaced by a file of the same name, a late event for it throws ENOTDIR there, which
 * nothing can catch and which ends the thread. The watcher's bookkeeping is untouched by the throw (the stat comes
 * first), so dropping that one event and rescanning loses nothing.
 */
export function isRecursiveWatchRace(error: unknown): boolean {
	if (!(error instanceof Error) || typeof error.stack !== "string" || !error.stack.includes(RECURSIVE_WATCH_FRAME)) {
		return false
	}

	const code = (error as NodeJS.ErrnoException).code

	return code === "ENOTDIR" || code === "ENOENT"
}

const raceListeners = new Set<() => void>()

function onUncaughtException(error: unknown): void {
	if (isRecursiveWatchRace(error)) {
		for (const listener of raceListeners) {
			listener()
		}

		return
	}

	// Anything else stays as fatal as it was without this listener: when no other listener handles it, it is
	// thrown again with this one gone.
	if (process.listenerCount("uncaughtException") > 1) {
		return
	}

	process.off("uncaughtException", onUncaughtException)
	process.nextTick(() => {
		throw error
	})
}

/**
 * Keeps the emulated recursive watcher's race (see {@link isRecursiveWatchRace}) from ending the thread while at
 * least one watcher is open; `onRace` runs for each one it contains. Returns the release.
 */
function containRecursiveWatchRace(onRace: () => void): () => void {
	if (raceListeners.size === 0) {
		process.on("uncaughtException", onUncaughtException)
	}

	raceListeners.add(onRace)

	return () => {
		if (!raceListeners.delete(onRace) || raceListeners.size > 0) {
			return
		}

		process.off("uncaughtException", onUncaughtException)
	}
}

/**
 * The production environment: real fs-extra, native recursive fs.watch, real write-file-atomic.
 */
export function defaultEnvironment(): SyncEnvironment {
	return {
		fs: fsExtra,
		globFs: fsExtra,
		writeFileAtomic: writeFileAtomicReal,
		fetchDirTree: (sdk, request) => fetchDirTreeMsgpack(sdk, request),
		createWatcher: async (path: string, onChange: () => void): Promise<SyncWatcher> => {
			let closed = false
			let watcher: fs.FSWatcher | undefined

			const start = (): void => {
				// The trash is never watched: every download stages there as a directory that is removed and
				// replaced by the file (the SDK's downloadFileToLocal), the very race isRecursiveWatchRace contains.
				watcher = fs.watch(path, { recursive: true, persistent: true, ignore: isLocalTrashPath }, () => {
					onChange()
				})

				// fs.watch can emit a runtime "error" (a transient inotify/FSEvents hiccup, or the watched
				// directory being replaced). Tear the dead watcher down and re-establish it shortly after
				// instead of letting the error go unhandled; trigger a scan so nothing is missed in the gap.
				watcher.on("error", () => {
					try {
						watcher?.close()
					} catch {
						// already closed
					}

					if (closed) {
						return
					}

					onChange()

					setTimeout(() => {
						if (closed) {
							return
						}

						try {
							start()
						} catch {
							// startDirectoryWatcher's retry + fallback interval recovers on the next cycle
						}
					}, 1000)
				})
			}

			// A creation failure (e.g. the path is gone) throws here and rejects the factory, so
			// startDirectoryWatcher falls back to its polling interval.
			start()

			const release = EMULATED_RECURSIVE_WATCH ? containRecursiveWatchRace(onChange) : () => undefined

			return {
				close: async (): Promise<void> => {
					closed = true

					release()

					try {
						watcher?.close()
					} catch {
						// already closed
					}
				}
			}
		}
	}
}
