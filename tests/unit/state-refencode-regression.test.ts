import { describe, it, expect } from "vitest"
import { State } from "../../src/lib/state"
import { type LocalItem, type LocalTree } from "../../src/lib/filesystems/local"
import { type RemoteItem, type RemoteTree } from "../../src/lib/filesystems/remote"
import { createVirtualFS, toPosixPath, type VirtualFS } from "../fakes/virtual-fs"
import type Sync from "../../src/lib/sync"

/**
 * Added regression tests for the state index-file optimization: the previousLocalINodes /
 * previousRemoteUUIDs files are now persisted as compact path-REFS (the in-memory indexes are rebuilt
 * from the tree files on load), instead of duplicating every full item. This pins:
 *   (1) the on-disk index files are refs (data = path string), not full items;
 *   (2) a save -> load round-trip reconstructs the inode/uuid indexes exactly;
 *   (3) BACK-COMPAT: an OLD on-disk state whose index files still hold FULL items loads identically
 *       (the index files are ignored on load and rebuilt from the trees), so an upgrade is a no-op.
 *
 * NEW FILE — does not touch tests/unit/state.test.ts.
 */

const DB_ROOT = "/db"

type StateSyncStub = {
	dbPath: string
	syncPair: { uuid: string }
	environment: { fs: VirtualFS["fs"]; globFs: VirtualFS["globFs"] }
	localFileHashes: Record<string, string>
	previousLocalTree: LocalTree
	previousRemoteTree: RemoteTree
	isPreviousSavedTreeStateEmpty: boolean
	removed: boolean
}

function makeSyncStub(vfs: VirtualFS, uuid: string): StateSyncStub {
	return {
		dbPath: DB_ROOT,
		syncPair: { uuid },
		environment: { fs: vfs.fs, globFs: vfs.globFs },
		localFileHashes: {},
		previousLocalTree: { tree: {}, inodes: {}, size: 0 },
		previousRemoteTree: { tree: {}, uuids: {}, size: 0 },
		isPreviousSavedTreeStateEmpty: true,
		removed: false
	}
}

function makeState(stub: StateSyncStub): State {
	return new State(stub as unknown as Sync)
}

function localFile(path: string, inode: number): LocalItem {
	return { type: "file", path, inode, size: 100, lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 }
}

function localDir(path: string, inode: number): LocalItem {
	return { type: "directory", path, inode, size: 0, lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 }
}

function remoteFile(path: string, uuid: string, name: string): RemoteItem {
	return { type: "file", uuid, name, size: 100, mime: "text/plain", lastModified: 1_700_000_000_000, version: 2, chunks: 1, key: `key-${uuid}`, bucket: "b", region: "r", path }
}

function remoteDir(path: string, uuid: string, name: string): RemoteItem {
	return { type: "directory", uuid, name, size: 0, path }
}

function jsonLines(vfs: VirtualFS, filePath: string): { prop: string; data: unknown }[] {
	return (vfs.ifs.readFileSync(toPosixPath(filePath), "utf-8") as string)
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line))
}

function seedTrees(stub: StateSyncStub): { localTree: LocalTree; remoteTree: RemoteTree } {
	const fileA = localFile("/a.txt", 101)
	const dir1 = localDir("/dir", 102)
	const fileB = localFile("/dir/b.txt", 103)
	const localTree: LocalTree = {
		tree: { "/a.txt": fileA, "/dir": dir1, "/dir/b.txt": fileB },
		inodes: { 101: fileA, 102: dir1, 103: fileB },
		size: 3
	}

	const rfileA = remoteFile("/a.txt", "u-a", "a.txt")
	const rdir = remoteDir("/dir", "u-dir", "dir")
	const rfileB = remoteFile("/dir/b.txt", "u-b", "b.txt")
	const remoteTree: RemoteTree = {
		tree: { "/a.txt": rfileA, "/dir": rdir, "/dir/b.txt": rfileB },
		uuids: { "u-a": rfileA, "u-dir": rdir, "u-b": rfileB },
		size: 3
	}

	stub.previousLocalTree = localTree
	stub.previousRemoteTree = remoteTree

	return { localTree, remoteTree }
}

describe("State — index files persisted as path-refs (perf guard)", () => {
	it("writes the inode/uuid index files as path-refs, not full items", async () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "ref-uuid")
		const state = makeState(stub)

		seedTrees(stub)

		await state.savePreviousTrees()

		// Each line's `data` is the item's path (a string), not the full item object.
		for (const line of jsonLines(vfs, state.previousLocalINodesPath)) {
			expect(typeof line.data).toBe("string")
		}

		for (const line of jsonLines(vfs, state.previousRemoteUUIDsPath)) {
			expect(typeof line.data).toBe("string")
		}

		// Props are still the inode / uuid keys (the completeness gate + key layout are preserved).
		expect(jsonLines(vfs, state.previousLocalINodesPath).map(l => l.prop).sort()).toEqual(["101", "102", "103"])
		expect(jsonLines(vfs, state.previousRemoteUUIDsPath).map(l => l.prop).sort()).toEqual(["u-a", "u-b", "u-dir"])

		// The tree files are unchanged: their `data` is the verbatim full item.
		const firstTreeLine = jsonLines(vfs, state.previousLocalTreePath)[0]!

		expect(typeof firstTreeLine.data).toBe("object")
	})

	it("round-trips: save (ref index) then load rebuilds the inode/uuid indexes exactly", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "rt-uuid")
		const { localTree, remoteTree } = seedTrees(source)

		await makeState(source).save()

		const reloaded = makeSyncStub(vfs, "rt-uuid")

		await makeState(reloaded).initialize()

		expect(reloaded.previousLocalTree.tree).toEqual(localTree.tree)
		expect(reloaded.previousLocalTree.inodes).toEqual(localTree.inodes)
		expect(reloaded.previousRemoteTree.tree).toEqual(remoteTree.tree)
		expect(reloaded.previousRemoteTree.uuids).toEqual(remoteTree.uuids)
		// The rebuilt index points at the SAME item objects held in the loaded tree.
		expect(reloaded.previousLocalTree.inodes[101]).toBe(reloaded.previousLocalTree.tree["/a.txt"])
		expect(reloaded.previousRemoteTree.uuids["u-a"]).toBe(reloaded.previousRemoteTree.tree["/a.txt"])
	})

	it("BACK-COMPAT: an old on-disk state with FULL-item index files loads identically", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "legacy-uuid")
		const { localTree, remoteTree } = seedTrees(source)
		const state = makeState(source)

		// Write the trees normally...
		await state.writeLargeRecordSerializedAndAtomically(state.previousLocalTreePath, localTree.tree)
		await state.writeLargeRecordSerializedAndAtomically(state.previousRemoteTreePath, remoteTree.tree)
		// ...but write the index files in the OLD format: FULL items as data (the pre-optimization layout).
		await state.writeLargeRecordSerializedAndAtomically(
			state.previousLocalINodesPath,
			localTree.inodes as unknown as Record<string, LocalItem>
		)
		await state.writeLargeRecordSerializedAndAtomically(
			state.previousRemoteUUIDsPath,
			remoteTree.uuids as unknown as Record<string, RemoteItem>
		)
		await state.saveLocalFileHashes()

		// Confirm the on-disk index really is the legacy full-item format.
		expect(typeof jsonLines(vfs, state.previousLocalINodesPath)[0]!.data).toBe("object")

		const reloaded = makeSyncStub(vfs, "legacy-uuid")

		await makeState(reloaded).loadPreviousTrees()

		// New loader ignores the legacy index files and rebuilds from the trees → identical base.
		expect(reloaded.isPreviousSavedTreeStateEmpty).toBe(false)
		expect(reloaded.previousLocalTree.inodes).toEqual(localTree.inodes)
		expect(reloaded.previousRemoteTree.uuids).toEqual(remoteTree.uuids)
		expect(reloaded.previousLocalTree.size).toBe(3)
		expect(reloaded.previousRemoteTree.size).toBe(3)
	})

	it("still degrades to no-saved-state when an index file is MISSING (gate preserved)", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "gate-uuid")

		seedTrees(source)

		const state = makeState(source)

		await state.save()

		// Remove the (now ref-encoded) inodes file: the completeness gate must still trip.
		vfs.ifs.rmSync(toPosixPath(state.previousLocalINodesPath))

		const reloaded = makeSyncStub(vfs, "gate-uuid")

		await makeState(reloaded).loadPreviousTrees()

		expect(reloaded.isPreviousSavedTreeStateEmpty).toBe(true)
		expect(reloaded.previousLocalTree.tree).toEqual({})
		expect(reloaded.previousLocalTree.inodes).toEqual({})
	})

	it("rebuild handles two paths sharing an inode (hardlink): last in tree order wins, as the scan did", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "hardlink-uuid")

		// Two files share inode 700. The scan inserts tree + inodes in the same order, so the index ends up
		// pointing at whichever comes LAST. Persisting the tree preserves that order; the rebuild must match.
		const first = localFile("/first.txt", 700)
		const second = localFile("/second.txt", 700)

		source.previousLocalTree = { tree: { "/first.txt": first, "/second.txt": second }, inodes: { 700: second }, size: 2 }
		source.previousRemoteTree = { tree: {}, uuids: {}, size: 0 }

		await makeState(source).save()

		const reloaded = makeSyncStub(vfs, "hardlink-uuid")

		await makeState(reloaded).loadPreviousTrees()

		expect(reloaded.previousLocalTree.inodes[700]!.path).toBe("/second.txt")
	})
})
