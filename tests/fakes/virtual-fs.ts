import { Volume, createFsFromVolume, type IFs } from "memfs"
import pathModule from "path"
import { type SyncFS, type SyncGlobFS } from "../../src/lib/environment"

/**
 * Declarative description of an initial in-memory tree.
 *
 * Key   = absolute path (e.g. "/local/a.txt").
 * Value = `string`        → a file with that UTF-8 content,
 *         `VfsFileSpec`   → a file with content and/or an explicit mtime,
 *         `null`          → an (empty) directory.
 *
 * Intermediate directories are created automatically.
 */
export type VfsFileSpec = { content?: string; mtimeMs?: number }
export type VfsSpec = Record<string, string | VfsFileSpec | null>

export type VirtualFS = {
	/** The {@link SyncFS} surface to inject into the engine's environment. */
	fs: SyncFS
	/** The fast-glob filesystem adapter to inject as `globFs`. */
	globFs: SyncGlobFS
	/** The underlying memfs volume (for advanced manipulation in tests). */
	vol: InstanceType<typeof Volume>
	/** The memfs fs implementation backing both {@link fs} and {@link globFs}. */
	ifs: IFs
	controls: {
		/** Current inode of a path, or null if it does not exist. */
		getInode(path: string): number | null
		/** Whether a path currently exists (no symlink following beyond stat). */
		exists(path: string): boolean
		/** Force the next fs operation that touches `path` to throw `error`. */
		setError(path: string, error: NodeJS.ErrnoException): void
		/** Remove a previously injected error for `path`. */
		clearError(path: string): void
		/** Remove all injected errors. */
		clearAllErrors(): void
		/** Flat JSON view of the volume (file path → content, dir → null). */
		toJSON(): Record<string, string | null>
	}
}

/**
 * Build a Node `ErrnoException` with a `code` (e.g. "ENOENT", "EACCES").
 */
export function makeErrnoError(code: string, message?: string): NodeJS.ErrnoException {
	const error = new Error(message ?? code) as NodeJS.ErrnoException

	error.code = code

	return error
}

/**
 * Materialize a {@link VfsSpec} into a memfs filesystem.
 */
export function applyVfsSpec(ifs: IFs, spec: VfsSpec): void {
	for (const [path, value] of Object.entries(spec)) {
		if (value === null) {
			ifs.mkdirSync(path, { recursive: true })

			continue
		}

		const content = typeof value === "string" ? value : value.content ?? ""

		ifs.mkdirSync(pathModule.dirname(path), { recursive: true })
		ifs.writeFileSync(path, content)

		const mtimeMs = typeof value === "string" ? undefined : value.mtimeMs

		if (typeof mtimeMs === "number") {
			const seconds = mtimeMs / 1000

			ifs.utimesSync(path, seconds, seconds)
		}
	}
}

/**
 * Create an in-memory filesystem that satisfies the engine's {@link SyncFS} and
 * {@link SyncGlobFS} contracts. Backed by memfs (battle-tested), with the
 * fs-extra conveniences the engine relies on (`ensureDir`, `exists`,
 * `pathExists`, `move`) layered on top, plus a per-path error-injection map for
 * resilience tests.
 */
export function createVirtualFS(initial: VfsSpec = {}): VirtualFS {
	const vol = new Volume()
	const ifs = createFsFromVolume(vol)

	applyVfsSpec(ifs, initial)

	const errors = new Map<string, NodeJS.ErrnoException>()
	const guard = (path: string): void => {
		const error = errors.get(path)

		if (error) {
			throw error
		}
	}

	const promises = ifs.promises

	const fs = {
		constants: ifs.constants,
		stat: async (path: string) => {
			guard(path)

			return await promises.stat(path)
		},
		lstat: async (path: string) => {
			guard(path)

			return await promises.lstat(path)
		},
		access: async (path: string, mode?: number) => {
			guard(path)

			return await promises.access(path, mode)
		},
		exists: async (path: string): Promise<boolean> => {
			try {
				guard(path)

				await promises.access(path)

				return true
			} catch {
				return false
			}
		},
		pathExists: async (path: string): Promise<boolean> => {
			try {
				guard(path)

				await promises.access(path)

				return true
			} catch {
				return false
			}
		},
		ensureDir: async (path: string): Promise<void> => {
			guard(path)

			await promises.mkdir(path, { recursive: true })
		},
		mkdir: async (path: string, options?: { recursive?: boolean }) => {
			guard(path)

			return await promises.mkdir(path, options)
		},
		rm: async (
			path: string,
			options?: { force?: boolean; maxRetries?: number; recursive?: boolean; retryDelay?: number }
		): Promise<void> => {
			guard(path)

			await promises.rm(path, options)
		},
		rename: async (src: string, dest: string): Promise<void> => {
			guard(src)

			await promises.rename(src, dest)
		},
		move: async (src: string, dest: string, options?: { overwrite?: boolean }): Promise<void> => {
			guard(src)

			await promises.mkdir(pathModule.dirname(dest), { recursive: true })

			if (options?.overwrite) {
				try {
					await promises.rm(dest, { recursive: true, force: true })
				} catch {
					// destination did not exist — nothing to overwrite
				}
			}

			await promises.rename(src, dest)
		},
		utimes: async (path: string, atime: number | Date, mtime: number | Date): Promise<void> => {
			guard(path)

			await promises.utimes(path, atime, mtime)
		},
		readFile: async (path: string, options?: { encoding?: BufferEncoding }) => {
			guard(path)

			return await promises.readFile(path, options)
		},
		writeFile: async (path: string, data: string | Uint8Array, options?: { encoding?: BufferEncoding }): Promise<void> => {
			guard(path)

			await promises.writeFile(path, data, options)
		},
		createReadStream: (path: string, options?: Parameters<IFs["createReadStream"]>[1]) => {
			guard(path)

			return ifs.createReadStream(path, options)
		},
		createWriteStream: (path: string, options?: Parameters<IFs["createWriteStream"]>[1]) => {
			guard(path)

			return ifs.createWriteStream(path, options)
		}
	}

	const controls: VirtualFS["controls"] = {
		getInode: (path: string): number | null => {
			try {
				return Number(vol.statSync(path).ino)
			} catch {
				return null
			}
		},
		exists: (path: string): boolean => {
			try {
				vol.statSync(path)

				return true
			} catch {
				return false
			}
		},
		setError: (path: string, error: NodeJS.ErrnoException): void => {
			errors.set(path, error)
		},
		clearError: (path: string): void => {
			errors.delete(path)
		},
		clearAllErrors: (): void => {
			errors.clear()
		},
		toJSON: (): Record<string, string | null> => vol.toJSON()
	}

	return {
		fs: fs as unknown as SyncFS,
		globFs: ifs as unknown as SyncGlobFS,
		vol,
		ifs,
		controls
	}
}
