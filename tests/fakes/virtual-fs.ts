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
		/**
		 * Force `stat`/`lstat` of `path` to report inode `ino`, simulating an OS (ext4) that recycles a
		 * freed inode number for the next-created file. memfs has no native reuse, so this is the only way
		 * to reproduce the inode-reuse rename misdetection deterministically. Use the real posix path the
		 * engine will stat (e.g. "/local/c.txt").
		 */
		setInode(path: string, ino: number): void
		/** Remove a previously forced inode for `path`. */
		clearInode(path: string): void
		/** Whether a path currently exists (no symlink following beyond stat). */
		exists(path: string): boolean
		/** Force the next fs operation that touches `path` to throw `error`. */
		setError(path: string, error: NodeJS.ErrnoException): void
		/** Remove a previously injected error for `path`. */
		clearError(path: string): void
		/** Remove all injected errors. */
		clearAllErrors(): void
		/**
		 * Register a callback invoked synchronously AFTER every `lstat`/`stat` returns, with the posix path
		 * just stat'd. Lets a test edit a file mid-scan (after the engine has already read it) to reproduce a
		 * read-during-scan race deterministically. The callback should gate itself (path match + a one-shot
		 * flag) and is cleared with {@link clearStatHook}. Only one hook is active at a time.
		 */
		onStat(hook: (posixPath: string) => void): void
		/** Remove the {@link onStat} hook. */
		clearStatHook(): void
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
 * Normalize a path the ENGINE produced into the posix form memfs understands.
 *
 * memfs is strictly posix (it rejects backslashes), and the virtual tree is seeded with `/`-paths. But
 * the engine joins local paths with the host's real `path` module, so on a Windows runner it emits
 * backslash separators — and FastGlob/@nodelib may resolve the posix `cwd` to a drive-rooted absolute
 * like `C:\local\...`. Stripping a leading drive letter and converting `\`→`/` lets the in-memory fs
 * accept whatever the host's path module emits, so the identical suite runs on win32/darwin/linux.
 *
 * On posix hosts this is a no-op (no drive letter, no backslashes). Only paths the engine passes in are
 * normalized here; test-side `ifs`/`vol` access stays posix (tests always use `/`).
 */
export function toPosixPath<T>(path: T): T {
	return (typeof path === "string" ? path.replace(/^[a-zA-Z]:(?=[\\/])/, "").replace(/\\/g, "/") : path) as T
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

		ifs.mkdirSync(pathModule.posix.dirname(path), { recursive: true })
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
	// Forced inode numbers (posix path -> ino) so a test can reproduce ext4-style inode reuse, which
	// memfs's allocator does not surface naturally.
	const inodeOverrides = new Map<string, number>()
	// Optional one-shot-friendly hook fired after each lstat/stat returns, so a test can mutate a file
	// mid-scan (after the engine read it) to reproduce a read-during-scan race deterministically.
	let statHook: ((posixPath: string) => void) | null = null
	// `guard` is always called with an already-posix-normalized path (each method normalizes its inputs
	// at entry), so the error map — keyed by the posix paths tests inject — matches on every host.
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
			path = toPosixPath(path)
			guard(path)

			const stats = await promises.stat(path)
			const overriddenInode = inodeOverrides.get(path)

			if (overriddenInode !== undefined) {
				stats.ino = overriddenInode
			}

			if (statHook) {
				statHook(path)
			}

			return stats
		},
		lstat: async (path: string) => {
			path = toPosixPath(path)
			guard(path)

			const stats = await promises.lstat(path)
			const overriddenInode = inodeOverrides.get(path)

			if (overriddenInode !== undefined) {
				stats.ino = overriddenInode
			}

			if (statHook) {
				statHook(path)
			}

			return stats
		},
		access: async (path: string, mode?: number) => {
			path = toPosixPath(path)
			guard(path)

			return await promises.access(path, mode)
		},
		exists: async (path: string): Promise<boolean> => {
			try {
				path = toPosixPath(path)
				guard(path)

				await promises.access(path)

				return true
			} catch {
				return false
			}
		},
		pathExists: async (path: string): Promise<boolean> => {
			try {
				path = toPosixPath(path)
				guard(path)

				await promises.access(path)

				return true
			} catch {
				return false
			}
		},
		ensureDir: async (path: string): Promise<void> => {
			path = toPosixPath(path)
			guard(path)

			await promises.mkdir(path, { recursive: true })
		},
		mkdir: async (path: string, options?: { recursive?: boolean }) => {
			path = toPosixPath(path)
			guard(path)

			return await promises.mkdir(path, options)
		},
		rm: async (
			path: string,
			options?: { force?: boolean; maxRetries?: number; recursive?: boolean; retryDelay?: number }
		): Promise<void> => {
			path = toPosixPath(path)
			guard(path)

			await promises.rm(path, options)
		},
		rename: async (src: string, dest: string): Promise<void> => {
			src = toPosixPath(src)
			dest = toPosixPath(dest)
			guard(src)

			await promises.rename(src, dest)
		},
		move: async (src: string, dest: string, options?: { overwrite?: boolean }): Promise<void> => {
			src = toPosixPath(src)
			dest = toPosixPath(dest)
			guard(src)

			await promises.mkdir(pathModule.posix.dirname(dest), { recursive: true })

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
			path = toPosixPath(path)
			guard(path)

			await promises.utimes(path, atime, mtime)
		},
		readFile: async (path: string, options?: { encoding?: BufferEncoding }) => {
			path = toPosixPath(path)
			guard(path)

			return await promises.readFile(path, options)
		},
		writeFile: async (path: string, data: string | Uint8Array, options?: { encoding?: BufferEncoding }): Promise<void> => {
			path = toPosixPath(path)
			guard(path)

			await promises.writeFile(path, data, options)
		},
		createReadStream: (path: string, options?: Parameters<IFs["createReadStream"]>[1]) => {
			path = toPosixPath(path)
			guard(path)

			return ifs.createReadStream(path, options)
		},
		createWriteStream: (path: string, options?: Parameters<IFs["createWriteStream"]>[1]) => {
			path = toPosixPath(path)
			guard(path)

			return ifs.createWriteStream(path, options)
		}
	}

	// FastGlob walks the tree through this adapter (lstat/stat/readdir + sync variants). On a Windows
	// runner @nodelib builds child paths with the host separator and may resolve the posix `cwd` to a
	// drive-rooted absolute, so every path it hands us is posix-normalized before reaching memfs. The
	// returned glob entries are already forward-slash (fast-glob normalizes its output on all platforms).
	const globFs = {
		lstat: (path: string, ...rest: unknown[]) => (ifs.lstat as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		lstatSync: (path: string, ...rest: unknown[]) => (ifs.lstatSync as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		stat: (path: string, ...rest: unknown[]) => (ifs.stat as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		statSync: (path: string, ...rest: unknown[]) => (ifs.statSync as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		readdir: (path: string, ...rest: unknown[]) => (ifs.readdir as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		readdirSync: (path: string, ...rest: unknown[]) => (ifs.readdirSync as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest)
	}

	const controls: VirtualFS["controls"] = {
		// Every path-keyed control normalizes with toPosixPath, exactly as the fs methods do before they
		// consult these maps. Tests pass either posix literals (a no-op here) or engine-computed paths,
		// which on Windows carry host backslash separators — without this an injected key would never
		// match the posix path the engine actually stats/opens.
		getInode: (path: string): number | null => {
			try {
				return Number(vol.statSync(toPosixPath(path)).ino)
			} catch {
				return null
			}
		},
		exists: (path: string): boolean => {
			try {
				vol.statSync(toPosixPath(path))

				return true
			} catch {
				return false
			}
		},
		setInode: (path: string, ino: number): void => {
			inodeOverrides.set(toPosixPath(path), ino)
		},
		clearInode: (path: string): void => {
			inodeOverrides.delete(toPosixPath(path))
		},
		setError: (path: string, error: NodeJS.ErrnoException): void => {
			errors.set(toPosixPath(path), error)
		},
		clearError: (path: string): void => {
			errors.delete(toPosixPath(path))
		},
		clearAllErrors: (): void => {
			errors.clear()
		},
		onStat: (hook: (posixPath: string) => void): void => {
			statHook = hook
		},
		clearStatHook: (): void => {
			statHook = null
		},
		toJSON: (): Record<string, string | null> => vol.toJSON()
	}

	return {
		fs: fs as unknown as SyncFS,
		globFs: globFs as unknown as SyncGlobFS,
		vol,
		ifs,
		controls
	}
}
