import { createWorld, type World, LOCAL_ROOT } from "../../harness/world"
import { type SyncMode } from "../../../src/types"
import { type VfsSpec } from "../../fakes/virtual-fs"
import { type CloudSpec } from "../../fakes/fake-cloud"
import { type SyncDirTreeFetcher, type DirTreeResponse } from "../../../src/lib/filesystems/dirTree"
import { type Scene } from "./trees"

/**
 * Build a memfs {@link VfsSpec} (keys under the local root) from a scene. Files get tiny deterministic
 * content; directories are explicit nulls so empty dirs still materialise.
 */
export function sceneToVfsSpec(scene: Scene, contentByte = "x"): VfsSpec {
	const spec: VfsSpec = {}

	for (const node of scene) {
		if (node.type === "directory") {
			spec[`${LOCAL_ROOT}${node.path}`] = null
		} else {
			spec[`${LOCAL_ROOT}${node.path}`] = contentByte.repeat(node.size)
		}
	}

	return spec
}

/** Build a fake-cloud {@link CloudSpec} (keys are sync-root-absolute paths) from a scene. */
export function sceneToCloudSpec(scene: Scene, contentByte = "x"): CloudSpec {
	const spec: CloudSpec = {}

	for (const node of scene) {
		if (node.type === "directory") {
			spec[node.path] = null
		} else {
			spec[node.path] = contentByte.repeat(node.size)
		}
	}

	return spec
}

/**
 * Create a wired in-memory world at scale and neutralise the background trash-cleanup interval so it
 * cannot fire mid-benchmark. Runs under REAL timers (the bench measures wall time) — safe because the
 * methods we benchmark (getDirectoryTree, runCycle with the debounce/timestamp pre-set) never await a
 * scheduled timer in the uncontended in-memory path.
 */
export async function makeScaleWorld(options: {
	mode: SyncMode
	initialLocal?: VfsSpec
	initialRemote?: CloudSpec
}): Promise<World> {
	const world = await createWorld(options)

	if (world.sync.cleanupLocalTrashInterval) {
		clearInterval(world.sync.cleanupLocalTrashInterval)

		world.sync.cleanupLocalTrashInterval = undefined
	}

	return world
}

/** Reset the local directory-tree cache so the next getDirectoryTree() does a full rescan. */
export function forceLocalRescan(world: World): void {
	world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now()
	world.sync.localFileSystem.getDirectoryTreeCache = {
		timestamp: 0,
		tree: {},
		inodes: {},
		ignored: [],
		errors: [],
		size: 0
	}
}

function basename(path: string): string {
	const i = path.lastIndexOf("/")

	return i === -1 ? path : path.slice(i + 1)
}

function parentPath(path: string): string {
	const i = path.lastIndexOf("/")

	return i <= 0 ? "" : path.slice(0, i)
}

/**
 * Synthesize the exact `/v3/dir/tree` response (files/folders tuple arrays with JSON metadata — the fake
 * cloud's decrypt is JSON.parse) directly from a scene, so the remote-build benchmark can feed it into
 * the ENGINE's tree-build loop WITHOUT going through the fake cloud's O(N²) `buildFullTree`. Ordered
 * parents-before-children (root first) by default — matching the order the engine's loop relies on.
 * `shuffle` produces an out-of-order response to exercise the order-independence target T2.
 */
export function sceneToDirTreeResponse(scene: Scene, rootUUID: string, options?: { shuffle?: () => void; rootName?: string }): DirTreeResponse {
	const uuidByPath = new Map<string, string>()

	for (const node of scene) {
		if (node.type === "directory") {
			uuidByPath.set(node.path, node.uuid)
		}
	}

	const parentUUIDOf = (path: string): string => {
		const parent = parentPath(path)

		return parent.length === 0 ? rootUUID : uuidByPath.get(parent) ?? rootUUID
	}

	const folders: unknown[] = [[rootUUID, JSON.stringify({ name: options?.rootName ?? "Sync" }), "base"]]
	const files: unknown[] = []

	for (const node of scene) {
		if (node.type === "directory") {
			folders.push([node.uuid, JSON.stringify({ name: basename(node.path) }), parentUUIDOf(node.path)])
		} else {
			files.push([
				node.uuid,
				"filen-1",
				"de-1",
				1,
				parentUUIDOf(node.path),
				JSON.stringify({
					name: basename(node.path),
					size: node.size,
					mime: "application/octet-stream",
					key: "k",
					lastModified: node.mtime,
					creation: node.creation,
					hash: undefined
				}),
				2,
				node.mtime
			])
		}
	}

	return { files, folders, raw: "" } as unknown as DirTreeResponse
}

/**
 * Replace a world's remote tree fetcher with one that returns a fixed, pre-built response — so the timed
 * `getDirectoryTree` measures ONLY the engine's build loop, not the fake cloud's response construction.
 */
export function injectDirTreeResponse(world: World, response: DirTreeResponse): void {
	const fetcher: SyncDirTreeFetcher = async () => response

	world.sync.environment.fetchDirTree = fetcher
}

/** Reset the remote directory-tree cache so the next getDirectoryTree() rebuilds fully. */
export function forceRemoteRebuild(world: World): void {
	world.sync.remoteFileSystem.getDirectoryTreeCache = {
		timestamp: 0,
		tree: {},
		uuids: {},
		ignored: [],
		size: 0
	}
}
