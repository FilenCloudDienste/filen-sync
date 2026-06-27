import fsExtra from "fs-extra"
import fs from "fs"
import FastGlob from "fast-glob"
import writeFileAtomicReal from "write-file-atomic"

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
}

/**
 * The production environment: real fs-extra, native recursive fs.watch, real write-file-atomic.
 */
export function defaultEnvironment(): SyncEnvironment {
	return {
		fs: fsExtra,
		globFs: fsExtra,
		writeFileAtomic: writeFileAtomicReal,
		createWatcher: async (path: string, onChange: () => void): Promise<SyncWatcher> => {
			let closed = false
			let watcher: fs.FSWatcher | undefined

			const start = (): void => {
				watcher = fs.watch(path, { recursive: true, persistent: true }, () => {
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

			return {
				close: async (): Promise<void> => {
					closed = true

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
