import { describe, it, expect } from "vitest"
import { createWorld, type World } from "../harness/world"
import { type SyncDirTreeFetcher } from "../../src/lib/filesystems/dirTree"

/**
 * Added regression tests for the order-independent remote tree build. The /v3/dir/tree API can return
 * its files/folders arrays UNORDERED (no guarantee a parent precedes its children, nor that folders[0]
 * is the sync root). The old builder built paths incrementally in array order and required
 * folders[0].parent === "base", so an out-of-order response corrupted child paths or THREW. The fake
 * cloud always emits BFS order, so the mocked suite never exercised this — these tests inject a
 * hand-built response (ordered and shuffled) directly.
 *
 * On the OLD code the shuffled case throws "Invalid base folder parent" (the build rejects → empty
 * changed:true result is never produced) — verified RED by stashing the rewrite. NEW FILE.
 */

type Folder = [string, string, string]
type File = [string, string, string, number, string, string, number, number]

function folderMeta(name: string): string {
	return JSON.stringify({ name })
}

function fileMeta(name: string): string {
	return JSON.stringify({ name, size: 10, mime: "text/plain", key: "k", lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 })
}

/**
 * A small tree:  root / a / b / c.txt , plus root / x.txt . Returns the folder+file tuples in BFS
 * (parent-first) order; the caller can shuffle them.
 */
function buildTuples(rootUUID: string): { folders: Folder[]; files: File[] } {
	const folders: Folder[] = [
		[rootUUID, folderMeta("Sync"), "base"],
		["uuid-a", folderMeta("a"), rootUUID],
		["uuid-b", folderMeta("b"), "uuid-a"]
	]
	const files: File[] = [
		["uuid-c", "bucket", "region", 1, "uuid-b", fileMeta("c.txt"), 2, 1_700_000_000_000],
		["uuid-x", "bucket", "region", 1, rootUUID, fileMeta("x.txt"), 2, 1_700_000_000_000]
	]

	return { folders, files }
}

function inject(world: World, folders: Folder[], files: File[]): void {
	const fetcher: SyncDirTreeFetcher = async () => ({ files, folders, raw: "" }) as unknown as Awaited<ReturnType<SyncDirTreeFetcher>>

	world.sync.environment.fetchDirTree = fetcher
}

describe("RemoteFileSystem.getDirectoryTree — order-independent build", () => {
	it("builds the correct tree from an ORDERED response (baseline)", async () => {
		const world = await createWorld({ mode: "twoWay" })
		const { folders, files } = buildTuples(world.cloud.controls.rootUUID)

		inject(world, folders, files)

		const result = await world.sync.remoteFileSystem.getDirectoryTree(true)

		expect(result.result.tree["/a"]).toMatchObject({ type: "directory", path: "/a" })
		expect(result.result.tree["/a/b"]).toMatchObject({ type: "directory", path: "/a/b" })
		expect(result.result.tree["/a/b/c.txt"]).toMatchObject({ type: "file", path: "/a/b/c.txt" })
		expect(result.result.tree["/x.txt"]).toMatchObject({ type: "file", path: "/x.txt" })
		expect(result.result.size).toBe(4)
	})

	it("builds the SAME tree from a SHUFFLED response (child before parent, root not first)", async () => {
		const world = await createWorld({ mode: "twoWay" })
		const { folders, files } = buildTuples(world.cloud.controls.rootUUID)

		// Reverse the folders so a child (b) precedes its parent (a) and the root is LAST — the exact shape
		// that made the old builder throw / mis-path.
		const shuffledFolders: Folder[] = [folders[2]!, folders[1]!, folders[0]!]
		const shuffledFiles: File[] = [files[1]!, files[0]!]

		inject(world, shuffledFolders, shuffledFiles)

		const result = await world.sync.remoteFileSystem.getDirectoryTree(true)

		// Despite the scrambled input, every path resolves correctly via the parent-chain walk.
		expect(result.result.tree["/a"]).toMatchObject({ type: "directory", path: "/a" })
		expect(result.result.tree["/a/b"]).toMatchObject({ type: "directory", path: "/a/b" })
		expect(result.result.tree["/a/b/c.txt"]).toMatchObject({ type: "file", path: "/a/b/c.txt" })
		expect(result.result.tree["/x.txt"]).toMatchObject({ type: "file", path: "/x.txt" })
		expect(result.result.size).toBe(4)
		expect(result.result.uuids["uuid-c"]).toMatchObject({ path: "/a/b/c.txt" })
	})

	it("still throws on a malformed response with NO sync-root folder (not treated as empty)", async () => {
		const world = await createWorld({ mode: "twoWay" })

		// No folder has parent "base" — a malformed response. Must throw rather than yield an empty tree
		// (which would look like every remote node was deleted).
		const folders: Folder[] = [["uuid-a", folderMeta("a"), "uuid-missing"]]

		inject(world, folders, [])

		await expect(world.sync.remoteFileSystem.getDirectoryTree(true)).rejects.toThrow()
	})
})
