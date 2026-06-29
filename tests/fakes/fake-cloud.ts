import {
	APIError,
	type CloudItem,
	type FileMetadata,
	type FolderMetadata,
	type FileEncryptionVersion,
	type FilenSDK
} from "@filen/sdk"
import { v4 as uuidv4 } from "uuid"
import crypto from "crypto"
import pathModule from "path"
import { type SyncFS } from "../../src/lib/environment"

/**
 * A stateful, in-memory fake of the exact `@filen/sdk` surface the sync engine consumes,
 * built to be a 1:1 behavioral match of the real SDK + backend (verified against the SDK
 * source in node_modules and confirmed backend semantics):
 *
 * - `api(3).dir().tree()` returns the full tree on the first call for a deviceId and an empty
 *   `{files:[],folders:[]}` "unchanged" response on subsequent calls when nothing changed since
 *   that deviceId last fetched; `skipCache:true` always returns the full tree.
 * - `api(3).dir().present()` reports trashed nodes as `{present:true,trash:true}` and permanently
 *   deleted nodes as `{present:false}`.
 * - Names are unique per parent **case-insensitively**. A file/folder type clash errors. Uploading
 *   a file over an existing file versions it: a fresh uuid supersedes, the old uuid leaves the tree.
 * - `cloud()` mutations mirror the SDK: `overwriteIfExists` trashes the occupant, `renameFile`/
 *   `moveFile` no-op when the target is the same uuid, and gone uuids raise
 *   `APIError{file_not_found|folder_not_found}`.
 * - Encryption is identity: metadata is `JSON.stringify(...)`, `decrypt()` is `JSON.parse(...)`.
 * - Resource locks are an in-memory map; uncontended acquire resolves immediately, while a contended one
 *   retries up to `maxTries` times with `tryTimeout` between tries (blocking until released for
 *   maxTries:Infinity, which the engine always uses) before throwing — the real SDK's acquire-with-retry.
 */

const FILE_ENCRYPTION_VERSION: FileEncryptionVersion = 2
const DEFAULT_UPLOAD_BUCKET = "filen-1"
const DEFAULT_UPLOAD_REGION = "de-1"
const UPLOAD_CHUNK_SIZE = 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
	".txt": "text/plain",
	".json": "application/json",
	".md": "text/markdown",
	".png": "image/png",
	".jpg": "image/jpeg",
	".pdf": "application/pdf"
}

function mimeForName(name: string): string {
	return MIME_BY_EXTENSION[pathModule.posix.extname(name).toLowerCase()] ?? "application/octet-stream"
}

function sha512Hex(data: Buffer): string {
	return crypto.createHash("sha512").update(Uint8Array.from(data)).digest("hex")
}

function randomHex(bytes: number): string {
	return crypto.randomBytes(bytes).toString("hex")
}

type FileNode = {
	type: "file"
	uuid: string
	parent: string
	name: string
	size: number
	mime: string
	key: string
	bucket: string
	region: string
	version: FileEncryptionVersion
	chunks: number
	lastModified: number
	creation: number
	hash: string
	timestamp: number
	favorited: boolean
	rm: string
	content: Buffer
	state: "live" | "trashed"
}

type DirNode = {
	type: "directory"
	uuid: string
	parent: string
	name: string
	timestamp: number
	favorited: boolean
	state: "live" | "trashed"
}

type Node = FileNode | DirNode

export type DirTreeFile = [string, string, string, number, string, string, FileEncryptionVersion, number]
export type DirTreeFolder = [string, string, string]
export type DirTreeResponse = { files: DirTreeFile[]; folders: DirTreeFolder[]; raw: string }

/**
 * Declarative initial remote state. Key = absolute POSIX path under the sync root
 * (e.g. "/a.txt", "/dir/b.txt"); value = file content / spec, or `null` for a directory.
 */
export type CloudFileSpec = { content?: string; mtimeMs?: number; creationMs?: number }
export type CloudSpec = Record<string, string | CloudFileSpec | null>

export type RemoteSnapshotEntry = { type: "file" | "directory"; size: number; mtimeSec: number; contentHash: string }
export type RemoteSnapshot = Record<string, RemoteSnapshotEntry>

export type FakeCloudControls = {
	/** The sync root's uuid (use as `remoteParentUUID`). */
	rootUUID: string
	/** Current full tree (bypasses the deviceId cache) — for assertions. */
	tree(): { files: DirTreeFile[]; folders: DirTreeFolder[] }
	/** Normalized snapshot of live nodes keyed by path — for harness assertions. */
	snapshot(): RemoteSnapshot
	/** Look up a live node by its path. */
	getByPath(path: string): Node | undefined
	/** Monotonic revision counter; bumps on every mutation. */
	revision(): number
	/** Make the next call to `method` (e.g. "tree", "uploadLocalFile") throw `error`. */
	setError(method: string, error: Error): void
	clearError(method: string): void
	clearAllErrors(): void
	/**
	 * Make the next `downloadFileToLocal` for the file at `path` write an INCOMPLETE (0-byte) staged file
	 * and RESOLVE (calling onError but not throwing) — reproducing the real SDK, whose aborted download
	 * ends the read stream cleanly so the pipeline reports no error. One-shot; the engine's integrity guard
	 * must discard the short file rather than commit it.
	 */
	simulateIncompleteDownload(path: string): void
	/** Block lock acquisition for `resource` to simulate another device holding it. */
	contendLock(resource: string): void
	releaseLockContention(resource: string): void
	/** External mutations (as if another device changed the cloud) between cycles. */
	addDir(path: string): string
	addFile(path: string, content: string, options?: { mtimeMs?: number; creationMs?: number }): string
	updateFile(path: string, content: string, options?: { mtimeMs?: number }): string
	/** Change a file's mtime WITHOUT assigning a new uuid (metadata-only touch). */
	touchRemote(path: string, mtimeMs: number): void
	trashPath(path: string): void
	deletePath(path: string): void
	movePath(fromPath: string, toPath: string): void
}

export type FakeCloud = {
	sdk: FilenSDK
	controls: FakeCloudControls
}

export function createFakeCloud(initial: CloudSpec = {}, deps: { localFs: SyncFS; rootName?: string; rootUUID?: string }): FakeCloud {
	const nodes = new Map<string, Node>()
	const deviceSeen = new Map<string, number>()
	const locks = new Map<string, string>()
	const contendedLocks = new Set<string>()
	const errors = new Map<string, Error>()
	const incompleteDownloads = new Set<string>()
	const rootUUID = deps.rootUUID ?? uuidv4()
	let revision = 0

	const now = (): number => Date.now()

	nodes.set(rootUUID, {
		type: "directory",
		uuid: rootUUID,
		parent: "base",
		name: deps.rootName ?? "Sync",
		timestamp: now(),
		favorited: false,
		state: "live"
	})

	const bump = (): void => {
		revision += 1
	}

	const guard = (method: string): void => {
		const error = errors.get(method)

		if (error) {
			throw error
		}
	}

	const liveChildren = (parentUUID: string): Node[] => {
		const result: Node[] = []

		for (const node of nodes.values()) {
			if (node.parent === parentUUID && node.state === "live") {
				result.push(node)
			}
		}

		return result
	}

	const findLiveByName = (parentUUID: string, name: string): Node | undefined => {
		const lowercased = name.toLowerCase()

		return liveChildren(parentUUID).find(node => node.name.toLowerCase() === lowercased)
	}

	const pathOf = (node: Node): string => {
		const parts: string[] = []
		let current: Node | undefined = node

		while (current && current.uuid !== rootUUID) {
			parts.unshift(current.name)

			current = nodes.get(current.parent)
		}

		return "/" + parts.join("/")
	}

	const removeSubtree = (uuid: string): void => {
		for (const child of [...liveChildren(uuid), ...nodes.values()].filter(n => n.parent === uuid)) {
			if (child.type === "directory") {
				removeSubtree(child.uuid)
			}

			nodes.delete(child.uuid)
		}

		nodes.delete(uuid)
	}

	const trashSubtree = (uuid: string): void => {
		const node = nodes.get(uuid)

		if (!node) {
			return
		}

		node.state = "trashed"

		for (const child of nodes.values()) {
			if (child.parent === uuid) {
				if (child.type === "directory") {
					trashSubtree(child.uuid)
				} else {
					child.state = "trashed"
				}
			}
		}
	}

	const encodeFileMetadata = (node: FileNode): string =>
		JSON.stringify({
			name: node.name,
			size: node.size,
			mime: node.mime,
			key: node.key,
			lastModified: node.lastModified,
			creation: node.creation,
			hash: node.hash
		})

	const encodeFolderMetadata = (node: DirNode): string => JSON.stringify({ name: node.name })

	const buildFullTree = (): { files: DirTreeFile[]; folders: DirTreeFolder[] } => {
		const folders: DirTreeFolder[] = []
		const files: DirTreeFile[] = []
		const queue: DirNode[] = []
		const root = nodes.get(rootUUID)

		if (root && root.type === "directory") {
			queue.push(root)
		}

		// Breadth-first so parents always precede children (the engine's decode relies on it).
		while (queue.length > 0) {
			const dir = queue.shift()!

			folders.push([dir.uuid, encodeFolderMetadata(dir), dir.parent])

			for (const child of liveChildren(dir.uuid)) {
				if (child.type === "directory") {
					queue.push(child)
				}
			}
		}

		for (const node of nodes.values()) {
			if (node.type === "file" && node.state === "live") {
				files.push([node.uuid, node.bucket, node.region, node.chunks, node.parent, encodeFileMetadata(node), node.version, node.timestamp])
			}
		}

		return { files, folders }
	}

	const ensureDirByPath = (posixPath: string): string => {
		if (posixPath === "/" || posixPath === "" || posixPath === ".") {
			return rootUUID
		}

		const segments = posixPath.split("/").filter(segment => segment.length > 0)
		let parentUUID = rootUUID

		for (const segment of segments) {
			const existing = findLiveByName(parentUUID, segment)

			if (existing) {
				if (existing.type === "file") {
					throw new Error(`Cannot create directory "${segment}": a file with that name exists.`)
				}

				parentUUID = existing.uuid

				continue
			}

			const uuid = uuidv4()

			nodes.set(uuid, {
				type: "directory",
				uuid,
				parent: parentUUID,
				name: segment,
				timestamp: now(),
				favorited: false,
				state: "live"
			})

			parentUUID = uuid
		}

		return parentUUID
	}

	const createFileNode = (
		parentUUID: string,
		name: string,
		content: Buffer,
		options?: { mtimeMs?: number | undefined; creationMs?: number | undefined }
	): string => {
		const existing = findLiveByName(parentUUID, name)

		if (existing) {
			if (existing.type === "directory") {
				throw new Error(`Cannot create file "${name}": a directory with that name exists.`)
			}

			// Same-name file → versioned: the old uuid leaves the live tree.
			nodes.delete(existing.uuid)
		}

		const uuid = uuidv4()
		const size = content.length
		const stamp = now()

		nodes.set(uuid, {
			type: "file",
			uuid,
			parent: parentUUID,
			name,
			size,
			mime: mimeForName(name),
			key: randomHex(16),
			bucket: DEFAULT_UPLOAD_BUCKET,
			region: DEFAULT_UPLOAD_REGION,
			version: FILE_ENCRYPTION_VERSION,
			chunks: size > 0 ? Math.ceil(size / UPLOAD_CHUNK_SIZE) : 1,
			lastModified: options?.mtimeMs ?? stamp,
			creation: options?.creationMs ?? stamp,
			hash: sha512Hex(content),
			timestamp: stamp,
			favorited: false,
			rm: randomHex(16),
			content,
			state: "live"
		})

		return uuid
	}

	// Materialize the initial spec.
	for (const [rawPath, value] of Object.entries(initial)) {
		if (value === null) {
			ensureDirByPath(rawPath)

			continue
		}

		const parentUUID = ensureDirByPath(pathModule.posix.dirname(rawPath))
		const content = typeof value === "string" ? value : value.content ?? ""
		const options = typeof value === "string" ? undefined : { mtimeMs: value.mtimeMs, creationMs: value.creationMs }

		createFileNode(parentUUID, pathModule.posix.basename(rawPath), Buffer.from(content, "utf-8"), options)
	}

	const trashFileInternal = (uuid: string): void => {
		const node = nodes.get(uuid)

		if (!node) {
			throw new APIError({ code: "file_not_found", message: "File not found." })
		}

		node.state = "trashed"

		bump()
	}

	const trashDirectoryInternal = (uuid: string): void => {
		if (!nodes.get(uuid)) {
			throw new APIError({ code: "folder_not_found", message: "Folder not found." })
		}

		trashSubtree(uuid)

		bump()
	}

	const sdk = {
		api: (_version: number) => ({
			dir: () => ({
				tree: async ({
					uuid: _uuid,
					deviceId,
					skipCache = false
				}: {
					uuid: string
					deviceId: string
					skipCache?: boolean
					includeRaw?: boolean
				}): Promise<DirTreeResponse> => {
					guard("tree")

					if (!skipCache && deviceSeen.get(deviceId) === revision) {
						return { files: [], folders: [], raw: "" }
					}

					deviceSeen.set(deviceId, revision)

					const { files, folders } = buildFullTree()

					return { files, folders, raw: "" }
				},
				present: async ({ uuid }: { uuid: string }): Promise<{ present: boolean; trash: boolean }> => {
					guard("present")

					const node = nodes.get(uuid)

					if (!node) {
						return { present: false, trash: false }
					}

					return { present: true, trash: node.state === "trashed" }
				}
			})
		}),
		cloud: () => ({
			createDirectory: async ({
				uuid,
				name,
				parent,
				renameIfExists: _renameIfExists = false
			}: {
				uuid?: string
				name: string
				parent: string
				renameIfExists?: boolean
			}): Promise<string> => {
				guard("createDirectory")

				const existing = findLiveByName(parent, name)

				if (existing) {
					if (existing.type === "file") {
						throw new Error(`Cannot create directory "${name}": a file with that name exists.`)
					}

					return existing.uuid
				}

				const newUUID = uuid ?? uuidv4()

				nodes.set(newUUID, {
					type: "directory",
					uuid: newUUID,
					parent,
					name,
					timestamp: now(),
					favorited: false,
					state: "live"
				})

				bump()

				return newUUID
			},
			uploadLocalFile: async ({
				source,
				parent,
				name,
				abortSignal,
				onProgress,
				onStarted,
				onError,
				onUploaded,
				onFinished,
				uuid,
				encryptionKey
			}: {
				source: string
				parent: string
				name?: string
				pauseSignal?: { isPaused: () => boolean }
				abortSignal?: AbortSignal
				onProgress?: (bytes: number) => void
				onStarted?: () => void
				onError?: (error: Error) => void
				onUploaded?: (item: CloudItem) => void | Promise<void>
				onFinished?: () => void
				uuid?: string
				encryptionKey?: string
			}): Promise<CloudItem> => {
				try {
					guard("uploadLocalFile")

					if (abortSignal?.aborted) {
						throw new Error("Aborted")
					}

					if (onStarted) {
						onStarted()
					}

					const fileName = name ?? pathModule.basename(source)
					const stats = await deps.localFs.stat(source)
					const content = (await deps.localFs.readFile(source)) as unknown as Buffer
					const size = stats.size
					const lastModified = parseInt(stats.mtimeMs.toString())
					const creation = parseInt(stats.birthtimeMs.toString())

					if (onProgress) {
						onProgress(size)
					}

					const existing = findLiveByName(parent, fileName)

					if (existing && existing.type === "directory") {
						throw new Error(`Cannot upload "${fileName}": a directory with that name exists.`)
					}

					if (existing) {
						// Same-name file → versioned: old uuid leaves the live tree.
						nodes.delete(existing.uuid)
					}

					const newUUID = uuid ?? uuidv4()
					const key = encryptionKey ?? randomHex(16)
					const chunks = size > 0 ? Math.ceil(size / UPLOAD_CHUNK_SIZE) : 1
					const stamp = now()
					const node: FileNode = {
						type: "file",
						uuid: newUUID,
						parent,
						name: fileName,
						size,
						mime: mimeForName(fileName),
						key,
						bucket: DEFAULT_UPLOAD_BUCKET,
						region: DEFAULT_UPLOAD_REGION,
						version: FILE_ENCRYPTION_VERSION,
						chunks,
						lastModified,
						creation,
						hash: sha512Hex(content),
						timestamp: stamp,
						favorited: false,
						rm: randomHex(16),
						content,
						state: "live"
					}

					nodes.set(newUUID, node)

					bump()

					const item: CloudItem = {
						type: "file",
						uuid: newUUID,
						name: fileName,
						size,
						mime: node.mime,
						lastModified,
						timestamp: stamp,
						parent,
						rm: node.rm,
						version: FILE_ENCRYPTION_VERSION,
						chunks,
						favorited: false,
						key,
						bucket: DEFAULT_UPLOAD_BUCKET,
						region: DEFAULT_UPLOAD_REGION,
						creation
					}

					if (onUploaded) {
						await onUploaded(item)
					}

					if (onFinished) {
						onFinished()
					}

					return item
				} catch (e) {
					if (onError) {
						onError(e as Error)
					}

					throw e
				}
			},
			downloadFileToLocal: async ({
				uuid,
				to,
				size,
				abortSignal,
				onProgress,
				onStarted,
				onError,
				onFinished
			}: {
				uuid: string
				bucket: string
				region: string
				chunks: number
				version: FileEncryptionVersion
				key: string
				to: string
				size: number
				pauseSignal?: { isPaused: () => boolean }
				abortSignal?: AbortSignal
				onProgress?: (bytes: number) => void
				onStarted?: () => void
				onError?: (error: Error) => void
				onFinished?: () => void
			}): Promise<string> => {
				try {
					guard("downloadFileToLocal")

					if (abortSignal?.aborted) {
						throw new Error("Aborted")
					}

					const node = nodes.get(uuid)

					if (!node || node.type !== "file") {
						throw new APIError({ code: "file_not_found", message: "File not found." })
					}

					await deps.localFs.ensureDir(pathModule.dirname(to))

					try {
						await deps.localFs.rm(to, { force: true, recursive: true })
					} catch {
						// nothing to clear
					}

					if (incompleteDownloads.has(uuid)) {
						// Reproduce the real SDK's aborted-download behavior: a 0-byte staged file, an onError
						// notification, but a RESOLVED promise (no throw). The engine's integrity guard must catch
						// the size mismatch and refuse to commit it. One-shot.
						incompleteDownloads.delete(uuid)

						await deps.localFs.writeFile(to, new Uint8Array(0))

						if (onError) {
							onError(new Error("Aborted"))
						}

						return to
					}

					if (size > 0) {
						if (onStarted) {
							onStarted()
						}

						if (onProgress) {
							onProgress(node.content.length)
						}

						await deps.localFs.writeFile(to, Uint8Array.from(node.content))

						if (onFinished) {
							onFinished()
						}
					} else {
						await deps.localFs.writeFile(to, new Uint8Array(0))
					}

					return to
				} catch (e) {
					if (onError) {
						onError(e as Error)
					}

					throw e
				}
			},
			renameFile: async ({
				uuid,
				name,
				overwriteIfExists = false
			}: {
				uuid: string
				metadata: FileMetadata
				name: string
				overwriteIfExists?: boolean
			}): Promise<void> => {
				guard("renameFile")

				const node = nodes.get(uuid)

				if (!node || node.state !== "live") {
					return
				}

				const existing = findLiveByName(node.parent, name)

				if (existing && existing.uuid !== uuid) {
					if (existing.type !== "file") {
						// The backend cannot overwrite a DIRECTORY with a file via rename (even with
						// overwriteIfExists) — it rejects rather than replacing across types. Modeling this is what
						// lets the mocked suite catch a cross-type rename the engine should never emit (file↔dir
						// name swap); the engine resolves such cases via delete+recreate instead.
						throw new Error("Cannot rename a file onto an existing directory.")
					}

					if (overwriteIfExists) {
						trashFileInternal(existing.uuid)
					} else {
						throw new Error("A file with the same name already exists in this directory.")
					}
				}

				node.name = name

				bump()
			},
			renameDirectory: async ({
				uuid,
				name,
				overwriteIfExists = false
			}: {
				uuid: string
				name: string
				overwriteIfExists?: boolean
			}): Promise<void> => {
				guard("renameDirectory")

				const node = nodes.get(uuid)

				if (!node || node.state !== "live") {
					return
				}

				const existing = findLiveByName(node.parent, name)

				if (existing && existing.uuid !== uuid) {
					if (existing.type !== "directory") {
						// Symmetric to renameFile: the backend will not overwrite a FILE with a directory via
						// rename. The engine must delete+recreate across types rather than rename.
						throw new Error("Cannot rename a directory onto an existing file.")
					}

					if (overwriteIfExists) {
						trashDirectoryInternal(existing.uuid)
					} else {
						throw new Error("A directory with the same name already exists in this directory.")
					}
				}

				node.name = name

				bump()
			},
			moveFile: async ({
				uuid,
				to,
				metadata,
				overwriteIfExists = false
			}: {
				uuid: string
				to: string
				metadata: FileMetadata
				overwriteIfExists?: boolean
			}): Promise<void> => {
				guard("moveFile")

				const node = nodes.get(uuid)

				if (!node || node.state !== "live") {
					return
				}

				const existing = findLiveByName(to, metadata.name)

				if (existing) {
					if (existing.uuid === uuid) {
						return
					}

					if (existing.type !== "file") {
						// Cross-type: cannot move a file onto an existing directory (matches the backend).
						throw new Error("Cannot move a file onto an existing directory.")
					}

					if (overwriteIfExists) {
						trashFileInternal(existing.uuid)
					}
				}

				node.parent = to

				bump()
			},
			moveDirectory: async ({
				uuid,
				to,
				metadata,
				overwriteIfExists = false
			}: {
				uuid: string
				to: string
				metadata: FolderMetadata
				overwriteIfExists?: boolean
			}): Promise<void> => {
				guard("moveDirectory")

				const node = nodes.get(uuid)

				if (!node || node.state !== "live") {
					return
				}

				const existing = findLiveByName(to, metadata.name)

				if (existing) {
					if (existing.uuid === uuid) {
						return
					}

					if (existing.type !== "directory") {
						// Cross-type: cannot move a directory onto an existing file (matches the backend).
						throw new Error("Cannot move a directory onto an existing file.")
					}

					if (overwriteIfExists) {
						trashDirectoryInternal(existing.uuid)
					}
				}

				node.parent = to

				bump()
			},
			trashFile: async ({ uuid }: { uuid: string }): Promise<void> => {
				guard("trashFile")

				trashFileInternal(uuid)
			},
			trashDirectory: async ({ uuid }: { uuid: string }): Promise<void> => {
				guard("trashDirectory")

				trashDirectoryInternal(uuid)
			},
			deleteFile: async ({ uuid }: { uuid: string }): Promise<void> => {
				guard("deleteFile")

				if (!nodes.get(uuid)) {
					throw new APIError({ code: "file_not_found", message: "File not found." })
				}

				nodes.delete(uuid)

				bump()
			},
			deleteDirectory: async ({ uuid }: { uuid: string }): Promise<void> => {
				guard("deleteDirectory")

				if (!nodes.get(uuid)) {
					throw new APIError({ code: "folder_not_found", message: "Folder not found." })
				}

				removeSubtree(uuid)

				bump()
			},
			fileExists: async ({ name, parent }: { name: string; parent: string }): Promise<{ exists: boolean; uuid?: string }> => {
				guard("fileExists")

				const existing = findLiveByName(parent, name)

				if (existing && existing.type === "file") {
					return { exists: true, uuid: existing.uuid }
				}

				return { exists: false }
			}
		}),
		crypto: () => ({
			decrypt: () => ({
				fileMetadata: async ({ metadata }: { metadata: string; key?: string }): Promise<FileMetadata> => {
					guard("fileMetadata")

					return JSON.parse(metadata) as FileMetadata
				},
				folderMetadata: async ({ metadata }: { metadata: string; key?: string }): Promise<FolderMetadata> => {
					guard("folderMetadata")

					if (metadata === "default") {
						return { name: "Default" }
					}

					return JSON.parse(metadata) as FolderMetadata
				}
			})
		}),
		user: () => ({
			acquireResourceLock: async ({
				resource,
				lockUUID,
				maxTries = 1,
				tryTimeout = 1000
			}: {
				resource: string
				lockUUID: string
				maxTries?: number
				tryTimeout?: number
			}): Promise<void> => {
				guard("acquireResourceLock")

				// Faithfully model the real SDK's retry-on-contention: a lock held by ANOTHER holder (or a
				// test-forced contention) is polled up to `maxTries` times with `tryTimeout` between tries
				// instead of failing on the first attempt. The engine acquires with maxTries:Infinity, so a
				// contended lock makes acquire BLOCK until the holder releases — exactly the production
				// behavior. A finite maxTries throws once exhausted. (An injected error via guard() above is a
				// hard, non-retryable failure and still throws immediately.)
				const isContended = (): boolean => {
					const holder = locks.get(resource)

					return (contendedLocks.has(resource) && holder !== lockUUID) || (holder !== undefined && holder !== lockUUID)
				}

				let tries = 0

				while (isContended()) {
					tries++

					if (tries >= maxTries) {
						throw new Error(`Could not acquire lock for resource ${resource}.`)
					}

					await new Promise<void>(resolve => setTimeout(resolve, tryTimeout))
				}

				locks.set(resource, lockUUID)
			},
			refreshResourceLock: async ({ resource, lockUUID }: { resource: string; lockUUID: string }): Promise<void> => {
				guard("refreshResourceLock")

				if (locks.get(resource) !== lockUUID) {
					throw new Error(`Could not refresh lock for resource ${resource}.`)
				}
			},
			releaseResourceLock: async ({ resource, lockUUID }: { resource: string; lockUUID: string }): Promise<void> => {
				guard("releaseResourceLock")

				if (locks.get(resource) === lockUUID) {
					locks.delete(resource)
				}
			}
		})
	}

	const getByPath = (path: string): Node | undefined => {
		for (const node of nodes.values()) {
			if (node.state === "live" && node.uuid !== rootUUID && pathOf(node) === path) {
				return node
			}
		}

		return undefined
	}

	const controls: FakeCloudControls = {
		rootUUID,
		tree: () => buildFullTree(),
		snapshot: (): RemoteSnapshot => {
			const result: RemoteSnapshot = {}

			for (const node of nodes.values()) {
				if (node.state !== "live" || node.uuid === rootUUID) {
					continue
				}

				const path = pathOf(node)

				if (node.type === "file") {
					result[path] = {
						type: "file",
						size: node.size,
						mtimeSec: Math.floor(node.lastModified / 1000),
						contentHash: sha512Hex(node.content)
					}
				} else {
					result[path] = { type: "directory", size: 0, mtimeSec: 0, contentHash: "" }
				}
			}

			return result
		},
		getByPath,
		revision: () => revision,
		setError: (method, error) => errors.set(method, error),
		clearError: method => errors.delete(method),
		clearAllErrors: () => errors.clear(),
		simulateIncompleteDownload: (path: string): void => {
			const node = getByPath(path)

			if (!node) {
				throw new Error(`simulateIncompleteDownload: no node at ${path}`)
			}

			incompleteDownloads.add(node.uuid)
		},
		contendLock: resource => contendedLocks.add(resource),
		releaseLockContention: resource => contendedLocks.delete(resource),
		addDir: (path: string): string => {
			const uuid = ensureDirByPath(path)

			bump()

			return uuid
		},
		addFile: (path, content, options): string => {
			const parentUUID = ensureDirByPath(pathModule.posix.dirname(path))
			const uuid = createFileNode(parentUUID, pathModule.posix.basename(path), Buffer.from(content, "utf-8"), options)

			bump()

			return uuid
		},
		updateFile: (path, content, options): string => {
			const parentUUID = ensureDirByPath(pathModule.posix.dirname(path))
			const uuid = createFileNode(parentUUID, pathModule.posix.basename(path), Buffer.from(content, "utf-8"), options)

			bump()

			return uuid
		},
		touchRemote: (path: string, mtimeMs: number): void => {
			const node = getByPath(path)

			if (!node || node.type !== "file") {
				return
			}

			node.lastModified = mtimeMs

			bump()
		},
		trashPath: (path: string): void => {
			const node = getByPath(path)

			if (!node) {
				return
			}

			if (node.type === "directory") {
				trashSubtree(node.uuid)
			} else {
				node.state = "trashed"
			}

			bump()
		},
		deletePath: (path: string): void => {
			const node = getByPath(path)

			if (!node) {
				return
			}

			if (node.type === "directory") {
				removeSubtree(node.uuid)
			} else {
				nodes.delete(node.uuid)
			}

			bump()
		},
		movePath: (fromPath: string, toPath: string): void => {
			const node = getByPath(fromPath)

			if (!node) {
				return
			}

			const parentUUID = ensureDirByPath(pathModule.posix.dirname(toPath))
			const newName = pathModule.posix.basename(toPath)

			// Per-parent name uniqueness is REAL on the backend (case-insensitive, no two live siblings share a
			// name). A peer-device move/rename onto an OCCUPIED name therefore cannot leave both — the backend
			// trashes the occupant (overwrite), exactly as the SDK moveFile/moveDirectory above already do. The
			// raw test control used to just reassign parent+name, spawning an impossible DUPLICATE sibling that
			// the real backend never produces (a false-green: a cross-side chain/swap whose destination is taken
			// resolved differently in the mock than live). Mirror the SDK's collision handling here so the fake
			// stays faithful: a same-type occupant is trashed, a cross-type collision is rejected.
			const existing = findLiveByName(parentUUID, newName)

			if (existing && existing.uuid !== node.uuid) {
				if (existing.type !== node.type) {
					throw new Error(`movePath: cannot move a ${node.type} onto an existing ${existing.type} at ${toPath}`)
				}

				if (existing.type === "file") {
					trashFileInternal(existing.uuid)
				} else {
					trashDirectoryInternal(existing.uuid)
				}
			}

			node.parent = parentUUID
			node.name = newName

			bump()
		}
	}

	return {
		sdk: sdk as unknown as FilenSDK,
		controls
	}
}
