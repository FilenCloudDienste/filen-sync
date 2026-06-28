import { type LocalTree, type LocalItem } from "../../../src/lib/filesystems/local"
import { type RemoteTree, type RemoteItem } from "../../../src/lib/filesystems/remote"

/**
 * A scene is an ordered (parents-before-children) list of nodes WITH stable identity (inode + uuid),
 * from which a matching {@link LocalTree} and {@link RemoteTree} can be built. Identity is what lets a
 * "current" scene derived from a "previous" one be recognised by the delta engine as a rename/modify
 * (same inode/uuid, changed path/size) rather than an unrelated add+delete.
 *
 * Local identity (inode) and remote identity (uuid) are independent per node, exactly as the engine
 * treats them — there is no cross-requirement between a path's inode and its uuid.
 */
export type GenNode = {
	path: string
	type: "file" | "directory"
	inode: number
	uuid: string
	size: number
	mtime: number
	creation: number
}

export type Scene = GenNode[]

const BASE_MTIME = new Date("2024-06-01T00:00:00.000Z").getTime()

let inodeCounter = 1
let uuidCounter = 1

function nextInode(): number {
	return inodeCounter++
}

function nextUUID(): string {
	// Deterministic, cheap, uuid-shaped enough for the engine (it only uses uuids as map keys / identity).
	const n = uuidCounter++

	return `uuid-${n.toString(16).padStart(12, "0")}`
}

/** Reset the identity counters so independent benchmarks start from a clean, deterministic space. */
export function resetIdentity(): void {
	inodeCounter = 1
	uuidCounter = 1
}

function fileNode(path: string, size = 64): GenNode {
	return { path, type: "file", inode: nextInode(), uuid: nextUUID(), size, mtime: BASE_MTIME, creation: BASE_MTIME }
}

function dirNode(path: string): GenNode {
	return { path, type: "directory", inode: nextInode(), uuid: nextUUID(), size: 0, mtime: BASE_MTIME, creation: BASE_MTIME }
}

// ---- shape generators (return ordered, parents-first scenes) -------------------------------------

/** All `fileCount` files in the sync root (worst case for one flat directory). */
export function genFlatScene(fileCount: number): Scene {
	const scene: Scene = []

	for (let i = 0; i < fileCount; i++) {
		scene.push(fileNode(`/file-${i}.txt`))
	}

	return scene
}

/** `dirCount` directories each holding `filesPerDir` files (a wide, shallow tree). */
export function genWideScene(dirCount: number, filesPerDir: number): Scene {
	const scene: Scene = []

	for (let d = 0; d < dirCount; d++) {
		const dirPath = `/dir-${d}`

		scene.push(dirNode(dirPath))

		for (let f = 0; f < filesPerDir; f++) {
			scene.push(fileNode(`${dirPath}/file-${f}.txt`))
		}
	}

	return scene
}

/** A single chain `/d0/d1/.../d{depth-1}/leaf.txt` (deep nesting). */
export function genDeepScene(depth: number): Scene {
	const scene: Scene = []
	let prefix = ""

	for (let level = 0; level < depth; level++) {
		prefix += `/d${level}`

		scene.push(dirNode(prefix))
	}

	scene.push(fileNode(`${prefix}/leaf.txt`))

	return scene
}

/**
 * A balanced tree: each directory has `fanout` subdirectories down to `depth`, and every directory
 * holds `filesPerDir` files. Realistic mix of files and directories. Ordered parents-first (BFS).
 */
export function genBalancedScene(options: { fanout: number; depth: number; filesPerDir: number }): Scene {
	const { fanout, depth, filesPerDir } = options
	const scene: Scene = []
	const queue: { path: string; level: number }[] = [{ path: "", level: 0 }]

	while (queue.length > 0) {
		const { path, level } = queue.shift()!

		for (let f = 0; f < filesPerDir; f++) {
			scene.push(fileNode(`${path}/file-${f}.txt`))
		}

		if (level < depth) {
			for (let c = 0; c < fanout; c++) {
				const childPath = `${path}/dir-${level}-${c}`

				scene.push(dirNode(childPath))
				queue.push({ path: childPath, level: level + 1 })
			}
		}
	}

	// Drop a possible leading "/file..." with empty path → ensure all paths start with "/".
	return scene
}

/** Generate a wide scene that targets roughly `targetNodes` total nodes. */
export function genSceneOfSize(targetNodes: number, filesPerDir = 100): Scene {
	const dirCount = Math.max(1, Math.round(targetNodes / (filesPerDir + 1)))

	return genWideScene(dirCount, filesPerDir)
}

// ---- scene → engine tree builders ----------------------------------------------------------------

export function buildLocalTree(scene: Scene): LocalTree {
	const tree: Record<string, LocalItem> = {}
	const inodes: Record<number, LocalItem> = {}

	for (const node of scene) {
		const item: LocalItem = {
			lastModified: node.mtime,
			type: node.type,
			path: node.path,
			size: node.size,
			creation: node.creation,
			inode: node.inode
		}

		tree[node.path] = item
		inodes[node.inode] = item
	}

	return { tree, inodes, size: scene.length }
}

export function buildRemoteTree(scene: Scene): RemoteTree {
	const tree: Record<string, RemoteItem> = {}
	const uuids: Record<string, RemoteItem> = {}

	for (const node of scene) {
		const item: RemoteItem =
			node.type === "directory"
				? { type: "directory", uuid: node.uuid, name: basename(node.path), size: 0, path: node.path }
				: {
						type: "file",
						uuid: node.uuid,
						name: basename(node.path),
						size: node.size,
						mime: "application/octet-stream",
						lastModified: node.mtime,
						version: 2,
						chunks: 1,
						key: "k",
						bucket: "filen-1",
						region: "de-1",
						creation: node.creation,
						path: node.path
				  }

		tree[node.path] = item
		uuids[node.uuid] = item
	}

	return { tree, uuids, size: scene.length }
}

function basename(path: string): string {
	const i = path.lastIndexOf("/")

	return i === -1 ? path : path.slice(i + 1)
}

// ---- mutators (return a NEW scene = the "current" side; never mutate the input) -------------------

export function cloneScene(scene: Scene): Scene {
	return scene.map(n => ({ ...n }))
}

/** Append `k` brand-new files (fresh identity) under `parent` (default sync root). */
export function addFiles(scene: Scene, k: number, parent = ""): Scene {
	const next = cloneScene(scene)

	for (let i = 0; i < k; i++) {
		next.push(fileNode(`${parent}/added-${i}-${nextInode()}.txt`))
	}

	return next
}

/** Remove the last `k` FILE nodes (keeps directories so the tree stays valid). */
export function deleteFiles(scene: Scene, k: number): Scene {
	const next = cloneScene(scene)
	let removed = 0

	for (let i = next.length - 1; i >= 0 && removed < k; i--) {
		if (next[i]!.type === "file") {
			next.splice(i, 1)

			removed++
		}
	}

	return next
}

/**
 * Modify the first `k` files. `side: "local"` keeps inode (a real local edit), `side: "remote"` mints a
 * new uuid (a real remote re-upload). Both bump size + mtime so the change is detected against the base.
 */
export function modifyFiles(scene: Scene, k: number, side: "local" | "remote"): Scene {
	const next = cloneScene(scene)
	let changed = 0

	for (const node of next) {
		if (changed >= k) {
			break
		}

		if (node.type === "file") {
			node.size += 1000
			node.mtime += 60_000

			if (side === "remote") {
				node.uuid = nextUUID()
			}

			changed++
		}
	}

	return next
}

/**
 * Rename a top-level directory (and rebase every descendant) while preserving identity, so the delta
 * engine sees a single directory rename carrying the subtree.
 */
export function renameTopDir(scene: Scene, fromPath: string, toPath: string): Scene {
	const next = cloneScene(scene)

	for (const node of next) {
		if (node.path === fromPath) {
			node.path = toPath
		} else if (node.path.startsWith(`${fromPath}/`)) {
			node.path = toPath + node.path.slice(fromPath.length)
		}
	}

	return next
}
