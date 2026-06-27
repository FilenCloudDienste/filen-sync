import fsExtra from "fs-extra"
import FastGlob from "fast-glob"
import writeFileAtomicReal from "write-file-atomic"
import parcelWatcher from "@parcel/watcher"
import process from "process"

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
 * changes. The default uses @parcel/watcher; tests inject a controllable no-op.
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
 * The production environment: real fs-extra, real @parcel/watcher, real write-file-atomic.
 */
export function defaultEnvironment(): SyncEnvironment {
	return {
		fs: fsExtra,
		globFs: fsExtra,
		writeFileAtomic: writeFileAtomicReal,
		createWatcher: async (path: string, onChange: () => void): Promise<SyncWatcher> => {
			const backend =
				process.platform === "win32"
					? "windows"
					: process.platform === "darwin"
					? "fs-events"
					: process.platform === "linux"
					? "inotify"
					: undefined

			const subscription = await parcelWatcher.subscribe(
				path,
				(err, events) => {
					if (!err && events && events.length > 0) {
						onChange()
					}
				},
				backend ? { backend } : {}
			)

			return {
				close: async (): Promise<void> => {
					await subscription.unsubscribe()
				}
			}
		}
	}
}
