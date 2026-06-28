import { describe, it, expect } from "vitest"
import pathModule from "path"
import { type Stats } from "fs-extra"
import { State } from "../../src/lib/state"
import { type LocalItem, type LocalTree } from "../../src/lib/filesystems/local"
import { type RemoteItem, type RemoteTree } from "../../src/lib/filesystems/remote"
import { type DoneTask } from "../../src/lib/tasks"
import { createVirtualFS, toPosixPath, type VirtualFS } from "../fakes/virtual-fs"
import type Sync from "../../src/lib/sync"

/**
 * Unit coverage for `src/lib/state.ts` — the durability layer that persists the engine's previous
 * trees and `localFileHashes` as line-delimited JSON under `<dbPath>/state/v2/<pairUUID>/`.
 *
 * This complements the scenario-level Category J (`tests/scenarios/j-state-cache.test.ts`, which
 * drives restart/round-trip/corruption through full cycles) by exercising the {@link State} class's
 * own methods and branches directly: the path getters, the
 * `writeLargeRecordSerializedAndAtomically`/`readLargeRecordFromLineStream` serializer pair (line
 * format, streaming-per-entry, corrupt-line recovery), the save/initialize/clear lifecycle and its
 * empty/missing/partial edge branches, and `applyDoneTasksToState` (dead code in the live cycle but
 * a large, branch-dense part of the file that the scenarios never reach).
 *
 * {@link State} only touches a handful of `Sync` fields, so a minimal cast stand-in (mirroring the
 * `Sync` stub used in `ipc-lock.test.ts`) keeps these tests at the unit level with no fake cloud,
 * fake timers, or scheduling loop. Every expectation was verified against the real implementation.
 */

const DB_ROOT = "/db"

/** The exact subset of {@link Sync} that {@link State} reads or writes. */
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

function localFile(path: string, inode: number, opts?: { size?: number; lastModified?: number; creation?: number }): LocalItem {
	return {
		type: "file",
		path,
		inode,
		size: opts?.size ?? 100,
		lastModified: opts?.lastModified ?? 1_700_000_000_000,
		creation: opts?.creation ?? 1_690_000_000_000
	}
}

function localDir(path: string, inode: number): LocalItem {
	return {
		type: "directory",
		path,
		inode,
		size: 0,
		lastModified: 1_700_000_000_000,
		creation: 1_690_000_000_000
	}
}

function remoteFile(path: string, uuid: string, name: string): RemoteItem {
	return {
		type: "file",
		uuid,
		name,
		size: 100,
		mime: "text/plain",
		lastModified: 1_700_000_000_000,
		version: 2,
		chunks: 1,
		key: `key-${uuid}`,
		bucket: "bucket",
		region: "region",
		path
	}
}

function remoteDir(path: string, uuid: string, name: string): RemoteItem {
	return {
		type: "directory",
		uuid,
		name,
		size: 0,
		path
	}
}

/** A throwaway `Stats` carrying only the four fields the create/upload/download cases read. */
function makeStats(values: { mtimeMs: number; birthtimeMs: number; size: number; ino: number }): Stats {
	return values as unknown as Stats
}

// `filePath` is built with the engine's platform `pathModule.join`, so on a Windows runner it carries
// backslashes / a drive letter. The engine persists through the wrapped fs (which posix-normalizes at
// the memfs boundary), so raw `ifs` access here must normalize too or it would miss the stored key.

/** Plant a raw file (creating parents) so loader/reader branches can be driven over exact bytes. */
function writeRaw(vfs: VirtualFS, filePath: string, content: string): void {
	const posixPath = toPosixPath(filePath)

	vfs.ifs.mkdirSync(pathModule.posix.dirname(posixPath), { recursive: true })
	vfs.ifs.writeFileSync(posixPath, content)
}

/** Read a written file back as text (the engine always writes utf-8). */
function readRaw(vfs: VirtualFS, filePath: string): string {
	return vfs.ifs.readFileSync(toPosixPath(filePath), "utf-8") as string
}

/** Split a written line-delimited file into its non-empty JSON lines. */
function jsonLines(raw: string): string[] {
	return raw.split("\n").filter(line => line.length > 0)
}

describe("State — path getters", () => {
	it("derives every persisted path from the documented state/v2/<uuid> layout", () => {
		const uuid = "pair-uuid-123"
		const state = makeState(makeSyncStub(createVirtualFS(), uuid))
		const base = pathModule.join(DB_ROOT, "state", "v2", uuid)

		expect(state.statePath).toBe(base)
		expect(state.previousLocalTreePath).toBe(pathModule.join(base, "previousLocalTree"))
		expect(state.previousLocalINodesPath).toBe(pathModule.join(base, "previousLocalINodes"))
		expect(state.previousRemoteTreePath).toBe(pathModule.join(base, "previousRemoteTree"))
		expect(state.previousRemoteUUIDsPath).toBe(pathModule.join(base, "previousRemoteUUIDs"))
		expect(state.localFileHashesPath).toBe(pathModule.join(base, "localFileHashes"))

		// The version segment is pinned at v2 (STATE_VERSION) between "state" and the pair uuid.
		expect(state.statePath.includes(pathModule.join("state", "v2", uuid))).toBe(true)
	})
})

describe("State — line-delimited serializer/reader", () => {
	it("writes one {prop,data} JSON line per entry and round-trips it back", async () => {
		const vfs = createVirtualFS()
		const state = makeState(makeSyncStub(vfs, "fmt-uuid"))
		const record = { "/a.txt": "hash-a", "/b.txt": "hash-b" }
		const dest = pathModule.join(state.statePath, "fmtRecord")

		await state.writeLargeRecordSerializedAndAtomically(dest, record)

		const lines = jsonLines(readRaw(vfs, dest))

		expect(lines.length).toBe(2)
		expect(JSON.parse(lines[0]!)).toEqual({ prop: "/a.txt", data: "hash-a" })
		expect(JSON.parse(lines[1]!)).toEqual({ prop: "/b.txt", data: "hash-b" })

		expect(await state.readLargeRecordFromLineStream<string>(dest)).toEqual(record)
	})

	it("streams large maps entry-by-entry (one line each, surviving stream backpressure)", async () => {
		const vfs = createVirtualFS()
		const state = makeState(makeSyncStub(vfs, "large-uuid"))
		const record: Record<string, string> = {}

		// ~300KB total comfortably exceeds the write stream's highWaterMark, forcing the drain path.
		for (let index = 0; index < 200; index++) {
			record[`/path/file-${index}.txt`] = `${index}:${"x".repeat(1500)}`
		}

		const dest = pathModule.join(state.statePath, "largeRecord")

		await state.writeLargeRecordSerializedAndAtomically(dest, record)

		const lines = jsonLines(readRaw(vfs, dest))

		// Exactly one self-contained JSON line per entry — proves it streams rather than emitting a
		// single giant blob.
		expect(lines.length).toBe(200)

		for (const line of lines.slice(0, 3)) {
			const parsed = JSON.parse(line)

			expect(parsed).toHaveProperty("prop")
			expect(parsed).toHaveProperty("data")
		}

		expect(await state.readLargeRecordFromLineStream<string>(dest)).toEqual(record)

		// The atomic write left no temp file behind (the move consumed it).
		expect(Object.keys(vfs.controls.toJSON()).filter(path => path.endsWith(".tmp"))).toEqual([])
	})

	it("skips blank, unparseable and wrong-shaped lines, keeping only valid {prop,data} entries", async () => {
		const vfs = createVirtualFS()
		const state = makeState(makeSyncStub(vfs, "reader-uuid"))
		const dest = pathModule.join(state.statePath, "mixed")
		const content =
			[
				JSON.stringify({ prop: "/valid1", data: "v1" }),
				"not json at all",
				JSON.stringify({ prop: "/valid2", data: "v2" }),
				"}{ broken line",
				JSON.stringify({ noprop: true }),
				"42",
				"null",
				"\"juststring\"",
				JSON.stringify({ prop: "/valid3", data: "v3" }),
				"",
				"   "
			].join("\n") + "\n"

		writeRaw(vfs, dest, content)

		// Garbage / non-object / shapeless / empty lines are all silently dropped; the reader recovers
		// the three well-formed entries without throwing.
		expect(await state.readLargeRecordFromLineStream<string>(dest)).toEqual({
			"/valid1": "v1",
			"/valid2": "v2",
			"/valid3": "v3"
		})
	})
})

describe("State — localFileHashes persistence", () => {
	it("saves and reloads localFileHashes across a fresh State over the same vfs", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "hash-uuid")

		source.localFileHashes = { "/a.txt": "h-a", "/dir/b.txt": "h-b" }

		await makeState(source).saveLocalFileHashes()

		const reloaded = makeSyncStub(vfs, "hash-uuid")

		await makeState(reloaded).loadLocalFileHashes()

		expect(reloaded.localFileHashes).toEqual({ "/a.txt": "h-a", "/dir/b.txt": "h-b" })
	})
})

describe("State — previous-trees round-trip", () => {
	it("persists trees/inodes/uuids/hashes and reloads them deep-equal, with sizes derived from the tree", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "round-uuid")

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

		const hashes = { "/a.txt": "hash-a", "/dir/b.txt": "hash-b" }

		source.previousLocalTree = localTree
		source.previousRemoteTree = remoteTree
		source.localFileHashes = hashes

		const sourceState = makeState(source)

		await sourceState.save()

		// savePreviousTrees marks the live state as non-empty after writing.
		expect(source.isPreviousSavedTreeStateEmpty).toBe(false)

		const reloaded = makeSyncStub(vfs, "round-uuid")
		const reloadedState = makeState(reloaded)

		await reloadedState.initialize()

		expect(reloaded.previousLocalTree.tree).toEqual(localTree.tree)
		expect(reloaded.previousLocalTree.inodes).toEqual(localTree.inodes)
		expect(reloaded.previousRemoteTree.tree).toEqual(remoteTree.tree)
		expect(reloaded.previousRemoteTree.uuids).toEqual(remoteTree.uuids)
		expect(reloaded.localFileHashes).toEqual(hashes)
		expect(reloaded.isPreviousSavedTreeStateEmpty).toBe(false)

		// Sizes are recomputed from the loaded TREE key counts (they are not themselves persisted).
		expect(reloaded.previousLocalTree.size).toBe(Object.keys(localTree.tree).length)
		expect(reloaded.previousRemoteTree.size).toBe(Object.keys(remoteTree.tree).length)
	})

	it("keys the four tree files by path/inode/uuid as documented", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "layout-uuid")

		const fileA = localFile("/a.txt", 101)
		const dir1 = localDir("/dir", 102)
		const rfileA = remoteFile("/a.txt", "u-a", "a.txt")
		const rdir = remoteDir("/dir", "u-dir", "dir")

		source.previousLocalTree = { tree: { "/a.txt": fileA, "/dir": dir1 }, inodes: { 101: fileA, 102: dir1 }, size: 2 }
		source.previousRemoteTree = { tree: { "/a.txt": rfileA, "/dir": rdir }, uuids: { "u-a": rfileA, "u-dir": rdir }, size: 2 }

		const state = makeState(source)

		await state.savePreviousTrees()

		const propsOf = (filePath: string): string[] => jsonLines(readRaw(vfs, filePath)).map(line => JSON.parse(line).prop).sort()

		// previousLocalTree is keyed by relative path, previousLocalINodes by inode (as a string key).
		expect(propsOf(state.previousLocalTreePath)).toEqual(["/a.txt", "/dir"])
		expect(propsOf(state.previousLocalINodesPath)).toEqual(["101", "102"])
		// previousRemoteTree is keyed by path, previousRemoteUUIDs by uuid.
		expect(propsOf(state.previousRemoteTreePath)).toEqual(["/a.txt", "/dir"])
		expect(propsOf(state.previousRemoteUUIDsPath)).toEqual(["u-a", "u-dir"])

		// The per-line `data` is the verbatim item, so a single line rehydrates the whole RemoteItem.
		const firstRemoteLine = jsonLines(readRaw(vfs, state.previousRemoteTreePath))[0]!

		expect(JSON.parse(firstRemoteLine)).toEqual({ prop: "/a.txt", data: rfileA })
	})
})

describe("State — loadPreviousTrees branches", () => {
	it("treats a completely missing state directory as a fresh, empty previous state without throwing", async () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "missing-uuid")

		await makeState(stub).initialize()

		expect(stub.localFileHashes).toEqual({})
		expect(stub.previousLocalTree.tree).toEqual({})
		expect(stub.previousLocalTree.inodes).toEqual({})
		expect(stub.previousRemoteTree.tree).toEqual({})
		expect(stub.previousRemoteTree.uuids).toEqual({})
		expect(stub.isPreviousSavedTreeStateEmpty).toBe(true)
	})

	it("treats a partial set of tree files as no saved state (short-circuits before reading)", async () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "partial-uuid")
		const state = makeState(stub)

		// Only the local tree exists; the missing remote tree trips the existence guard, so the loader
		// returns "empty" without ever attempting to read the absent files.
		writeRaw(vfs, state.previousLocalTreePath, JSON.stringify({ prop: "/x.txt", data: localFile("/x.txt", 1) }) + "\n")

		await state.initialize()

		expect(stub.isPreviousSavedTreeStateEmpty).toBe(true)
		expect(stub.previousLocalTree.tree).toEqual({})
	})

	it("treats a saved state with a MISSING local-inodes file as no saved state, not a throw", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "missing-inodes-uuid")

		const fileA = localFile("/a.txt", 101)
		const rfileA = remoteFile("/a.txt", "u-a", "a.txt")

		source.previousLocalTree = { tree: { "/a.txt": fileA }, inodes: { 101: fileA }, size: 1 }
		source.previousRemoteTree = { tree: { "/a.txt": rfileA }, uuids: { "u-a": rfileA }, size: 1 }

		const sourceState = makeState(source)

		await sourceState.save()

		// The local-inodes file is the ONE file the completeness guard used to skip while still reading it
		// unconditionally. Remove it to simulate a partial / interrupted-write on-disk state: the loader must
		// degrade to "no saved state" (and re-derive next cycle), NOT throw ENOENT and brick the load.
		vfs.ifs.rmSync(toPosixPath(sourceState.previousLocalINodesPath))

		const reloaded = makeSyncStub(vfs, "missing-inodes-uuid")

		await makeState(reloaded).initialize()

		expect(reloaded.isPreviousSavedTreeStateEmpty).toBe(true)
		expect(reloaded.previousLocalTree.tree).toEqual({})
		expect(reloaded.previousLocalTree.inodes).toEqual({})
		expect(reloaded.previousRemoteTree.tree).toEqual({})
	})

	it("distinguishes a persisted-but-empty state (files present, empty) from no saved state", async () => {
		const vfs = createVirtualFS()

		// Saving empty trees writes empty files for all of them.
		await makeState(makeSyncStub(vfs, "empty-uuid")).save()

		const reloaded = makeSyncStub(vfs, "empty-uuid")

		await makeState(reloaded).initialize()

		expect(reloaded.previousLocalTree.tree).toEqual({})
		expect(reloaded.previousLocalTree.size).toBe(0)
		expect(reloaded.previousRemoteTree.tree).toEqual({})
		expect(reloaded.previousRemoteTree.size).toBe(0)
		expect(reloaded.localFileHashes).toEqual({})
		// Files exist, so this is "an empty saved state", NOT "no saved state".
		expect(reloaded.isPreviousSavedTreeStateEmpty).toBe(false)
	})

	it("degrades a single corrupt tree file to empty while still loading the intact siblings", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "corrupt-uuid")

		const fileA = localFile("/a.txt", 101)

		source.previousLocalTree = { tree: { "/a.txt": fileA }, inodes: { 101: fileA }, size: 1 }
		source.previousRemoteTree = {
			tree: { "/a.txt": remoteFile("/a.txt", "u-a", "a.txt") },
			uuids: { "u-a": remoteFile("/a.txt", "u-a", "a.txt") },
			size: 1
		}

		const sourceState = makeState(source)

		await sourceState.save()

		// Corrupt ONLY the remote tree file; the loader reads each file independently and recovers
		// per-line, so this one degrades to empty without affecting the still-valid local tree.
		writeRaw(vfs, sourceState.previousRemoteTreePath, "}{ not json\n<<garbage>>\n")

		const reloaded = makeSyncStub(vfs, "corrupt-uuid")

		await makeState(reloaded).initialize()

		expect(reloaded.previousRemoteTree.tree).toEqual({})
		expect(reloaded.previousRemoteTree.size).toBe(0)
		expect(reloaded.previousLocalTree.tree).toEqual({ "/a.txt": fileA })
		expect(reloaded.isPreviousSavedTreeStateEmpty).toBe(false)
	})

	it("removes stray .tmp files from the state directory while leaving real files untouched", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "tmp-uuid")
		const fileA = localFile("/a.txt", 101)

		source.previousLocalTree = { tree: { "/a.txt": fileA }, inodes: { 101: fileA }, size: 1 }
		source.previousRemoteTree = {
			tree: { "/a.txt": remoteFile("/a.txt", "u-a", "a.txt") },
			uuids: { "u-a": remoteFile("/a.txt", "u-a", "a.txt") },
			size: 1
		}

		const sourceState = makeState(source)

		await sourceState.save()

		const strayTmp = pathModule.join(sourceState.statePath, "leftover.tmp")

		writeRaw(vfs, strayTmp, "interrupted write")

		expect(vfs.controls.exists(strayTmp)).toBe(true)

		const reloaded = makeSyncStub(vfs, "tmp-uuid")
		const reloadedState = makeState(reloaded)

		await reloadedState.loadPreviousTrees()

		// The stray temp file was swept; the real persisted state still loaded.
		expect(vfs.controls.exists(strayTmp)).toBe(false)
		expect(vfs.controls.exists(reloadedState.previousLocalTreePath)).toBe(true)
		expect(reloaded.previousLocalTree.tree).toEqual({ "/a.txt": fileA })
	})
})

describe("State — clear", () => {
	it("removes all five persisted files, so a subsequent load sees no saved state", async () => {
		const vfs = createVirtualFS()
		const source = makeSyncStub(vfs, "clear-uuid")
		const fileA = localFile("/a.txt", 101)

		source.previousLocalTree = { tree: { "/a.txt": fileA }, inodes: { 101: fileA }, size: 1 }
		source.previousRemoteTree = {
			tree: { "/a.txt": remoteFile("/a.txt", "u-a", "a.txt") },
			uuids: { "u-a": remoteFile("/a.txt", "u-a", "a.txt") },
			size: 1
		}
		source.localFileHashes = { "/a.txt": "hash-a" }

		const state = makeState(source)

		await state.save()

		const files = [
			state.previousLocalTreePath,
			state.previousLocalINodesPath,
			state.previousRemoteTreePath,
			state.previousRemoteUUIDsPath,
			state.localFileHashesPath
		]

		for (const filePath of files) {
			expect(vfs.controls.exists(filePath)).toBe(true)
		}

		await state.clear()

		for (const filePath of files) {
			expect(vfs.controls.exists(filePath)).toBe(false)
		}

		const reloaded = makeSyncStub(vfs, "clear-uuid")

		await makeState(reloaded).initialize()

		expect(reloaded.isPreviousSavedTreeStateEmpty).toBe(true)
		expect(reloaded.previousLocalTree.tree).toEqual({})
		expect(reloaded.localFileHashes).toEqual({})
	})

	it("is a no-op (force) when there is nothing to remove", async () => {
		const vfs = createVirtualFS()
		const state = makeState(makeSyncStub(vfs, "clear-empty-uuid"))

		await expect(state.clear()).resolves.toBeUndefined()
	})
})

describe("State — applyDoneTasksToState", () => {
	it("returns the trees untouched (same references) when the sync was removed", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "removed-uuid")

		stub.removed = true
		stub.localFileHashes = { "/f.txt": "h" }

		const localTree: LocalTree = { tree: { "/f.txt": localFile("/f.txt", 1) }, inodes: { 1: localFile("/f.txt", 1) }, size: 1 }
		const remoteTree: RemoteTree = { tree: {}, uuids: {}, size: 0 }
		const localSnapshot = structuredClone(localTree)
		const hashesSnapshot = structuredClone(stub.localFileHashes)

		const result = makeState(stub).applyDoneTasksToState({
			doneTasks: [{ path: "/f.txt", type: "deleteLocalFile" }],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		expect(result.currentLocalTree).toBe(localTree)
		expect(result.currentRemoteTree).toBe(remoteTree)
		expect(localTree).toEqual(localSnapshot)
		expect(stub.localFileHashes).toEqual(hashesSnapshot)
	})

	it("applies create/upload/download tasks to both trees with normalizeUTime-floored timestamps", () => {
		const vfs = createVirtualFS()
		const state = makeState(makeSyncStub(vfs, "create-uuid"))
		const localTree: LocalTree = { tree: {}, inodes: {}, size: 0 }
		const remoteTree: RemoteTree = { tree: {}, uuids: {}, size: 0 }

		const crItem = remoteDir("/cr", "u-cr", "cr")
		const upItem = remoteFile("/up.txt", "u-up", "up.txt")
		const clItem = remoteDir("/cl", "u-cl", "cl")
		const dlItem = remoteFile("/dl.txt", "u-dl", "dl.txt")

		const tasks: DoneTask[] = [
			{ path: "/cr", type: "createRemoteDirectory", item: crItem, stats: makeStats({ mtimeMs: 1000.9, birthtimeMs: 500.9, size: 4096, ino: 401 }) },
			{ path: "/up.txt", type: "uploadFile", item: upItem, stats: makeStats({ mtimeMs: 2000.5, birthtimeMs: 1500.5, size: 123, ino: 402 }) },
			{ path: "/cl", type: "createLocalDirectory", item: clItem, stats: makeStats({ mtimeMs: 3000.1, birthtimeMs: 2500.1, size: 777, ino: 403 }) },
			{ path: "/dl.txt", type: "downloadFile", item: dlItem, stats: makeStats({ mtimeMs: 4000.8, birthtimeMs: 3500.8, size: 456, ino: 404 }) }
		]

		state.applyDoneTasksToState({ doneTasks: tasks, currentLocalTree: localTree, currentRemoteTree: remoteTree })

		// Every task mirrors its remote item into the remote tree, keyed by both path and uuid.
		expect(remoteTree.tree["/cr"]).toBe(crItem)
		expect(remoteTree.uuids["u-cr"]).toBe(crItem)
		expect(remoteTree.tree["/up.txt"]).toBe(upItem)
		expect(remoteTree.uuids["u-up"]).toBe(upItem)
		expect(remoteTree.tree["/cl"]).toBe(clItem)
		expect(remoteTree.tree["/dl.txt"]).toBe(dlItem)

		// Local items are synthesized from stats; float mtimes/creations are floored by normalizeUTime,
		// and a createRemoteDirectory carries size 0 whereas a createLocalDirectory keeps the stat size.
		expect(localTree.tree["/cr"]).toEqual({ type: "directory", path: "/cr", size: 0, inode: 401, lastModified: 1000, creation: 500 })
		expect(localTree.inodes[401]).toBe(localTree.tree["/cr"])
		expect(localTree.tree["/up.txt"]).toEqual({ type: "file", path: "/up.txt", size: 123, inode: 402, lastModified: 2000, creation: 1500 })
		expect(localTree.tree["/cl"]).toEqual({ type: "directory", path: "/cl", size: 777, inode: 403, lastModified: 3000, creation: 2500 })
		expect(localTree.tree["/dl.txt"]).toEqual({ type: "file", path: "/dl.txt", size: 456, inode: 404, lastModified: 4000, creation: 3500 })
	})

	it("reparents a renamed local directory: tree, inodes and file hashes all follow the move", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "rl-uuid")

		stub.localFileHashes = { "/old": "hOld", "/old/child.txt": "hChild", "/unrelated.txt": "hUnrel" }

		const oldDir = localDir("/old", 201)
		const childFile = localFile("/old/child.txt", 202)
		const unrelFile = localFile("/unrelated.txt", 203)
		const localTree: LocalTree = {
			tree: { "/old": oldDir, "/old/child.txt": childFile, "/unrelated.txt": unrelFile },
			inodes: { 201: oldDir, 202: childFile, 203: unrelFile },
			size: 3
		}
		const remoteTree: RemoteTree = { tree: {}, uuids: {}, size: 0 }

		makeState(stub).applyDoneTasksToState({
			doneTasks: [
				{ path: "/new", type: "renameLocalDirectory", from: "/old", to: "/new", stats: makeStats({ mtimeMs: 1, birthtimeMs: 1, size: 0, ino: 201 }) }
			],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		expect(localTree.tree["/new"]).toMatchObject({ path: "/new", type: "directory", inode: 201 })
		expect(localTree.tree["/new/child.txt"]).toMatchObject({ path: "/new/child.txt", inode: 202 })
		expect(localTree.tree["/old"]).toBeUndefined()
		expect(localTree.tree["/old/child.txt"]).toBeUndefined()
		expect(localTree.tree["/unrelated.txt"]).toBe(unrelFile)
		expect(localTree.inodes[201]!.path).toBe("/new")
		expect(localTree.inodes[202]!.path).toBe("/new/child.txt")
		expect(stub.localFileHashes).toEqual({ "/new": "hOld", "/new/child.txt": "hChild", "/unrelated.txt": "hUnrel" })
	})

	it("reparents a renamed remote directory: tree, uuids and basenames all follow the move", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "rr-uuid")

		const oldDir = remoteDir("/rold", "u-old", "rold")
		const childFile = remoteFile("/rold/c.txt", "u-child", "c.txt")
		const otherFile = remoteFile("/other.txt", "u-other", "other.txt")
		const localTree: LocalTree = { tree: {}, inodes: {}, size: 0 }
		const remoteTree: RemoteTree = {
			tree: { "/rold": oldDir, "/rold/c.txt": childFile, "/other.txt": otherFile },
			uuids: { "u-old": oldDir, "u-child": childFile, "u-other": otherFile },
			size: 3
		}

		makeState(stub).applyDoneTasksToState({
			doneTasks: [{ path: "/rnew", type: "renameRemoteDirectory", from: "/rold", to: "/rnew" }],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		expect(remoteTree.tree["/rnew"]).toMatchObject({ path: "/rnew", name: "rnew", uuid: "u-old", type: "directory" })
		expect(remoteTree.uuids["u-old"]).toMatchObject({ path: "/rnew", name: "rnew" })
		expect(remoteTree.tree["/rnew/c.txt"]).toMatchObject({ path: "/rnew/c.txt", name: "c.txt", uuid: "u-child" })
		expect(remoteTree.uuids["u-child"]).toMatchObject({ path: "/rnew/c.txt", name: "c.txt" })
		expect(remoteTree.tree["/rold"]).toBeUndefined()
		expect(remoteTree.tree["/rold/c.txt"]).toBeUndefined()
		expect(remoteTree.tree["/other.txt"]).toBe(otherFile)
	})

	it("prunes a deleted local directory's subtree from tree, inodes and hashes (and survives a stale inode)", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "dl-uuid")

		stub.localFileHashes = { "/del/sub.txt": "h1", "/keep.txt": "h2" }

		const delDir = localDir("/del", 301)
		const subFile = localFile("/del/sub.txt", 302)
		const keepFile = localFile("/keep.txt", 303)
		const localTree: LocalTree = {
			tree: { "/del": delDir, "/del/sub.txt": subFile, "/keep.txt": keepFile },
			// The 999 slot is intentionally a hole, exercising the `!currentItem` guard in the inode loop.
			inodes: { 301: delDir, 302: subFile, 303: keepFile, 999: undefined as unknown as LocalItem },
			size: 3
		}
		const remoteTree: RemoteTree = { tree: {}, uuids: {}, size: 0 }

		makeState(stub).applyDoneTasksToState({
			doneTasks: [{ path: "/del", type: "deleteLocalDirectory" }],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		expect(localTree.tree["/del"]).toBeUndefined()
		expect(localTree.tree["/del/sub.txt"]).toBeUndefined()
		expect(localTree.tree["/keep.txt"]).toBe(keepFile)
		expect(localTree.inodes[301]).toBeUndefined()
		expect(localTree.inodes[302]).toBeUndefined()
		expect(localTree.inodes[303]).toBe(keepFile)
		expect(stub.localFileHashes).toEqual({ "/keep.txt": "h2" })
	})

	it("prunes a deleted remote directory's subtree from tree and uuids (and survives a stale uuid)", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "dr-uuid")

		const delDir = remoteDir("/rdel", "u-d", "rdel")
		const xFile = remoteFile("/rdel/x.txt", "u-x", "x.txt")
		const keepFile = remoteFile("/rkeep.txt", "u-k", "rkeep.txt")
		const localTree: LocalTree = { tree: {}, inodes: {}, size: 0 }
		const remoteTree: RemoteTree = {
			tree: { "/rdel": delDir, "/rdel/x.txt": xFile, "/rkeep.txt": keepFile },
			// The hole exercises the `!currentItem` guard in the uuid loop.
			uuids: { "u-d": delDir, "u-x": xFile, "u-k": keepFile, "u-undef": undefined as unknown as RemoteItem },
			size: 3
		}

		makeState(stub).applyDoneTasksToState({
			doneTasks: [{ path: "/rdel", type: "deleteRemoteDirectory" }],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		expect(remoteTree.tree["/rdel"]).toBeUndefined()
		expect(remoteTree.tree["/rdel/x.txt"]).toBeUndefined()
		expect(remoteTree.tree["/rkeep.txt"]).toBe(keepFile)
		expect(remoteTree.uuids["u-d"]).toBeUndefined()
		expect(remoteTree.uuids["u-x"]).toBeUndefined()
		expect(remoteTree.uuids["u-k"]).toBe(keepFile)
	})

	it("deletes single local and remote files from their trees, inodes/uuids and hashes", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "df-uuid")

		stub.localFileHashes = { "/f.txt": "h" }

		const lf = localFile("/f.txt", 501)
		const rf = remoteFile("/rf.txt", "u-rf", "rf.txt")
		const localTree: LocalTree = { tree: { "/f.txt": lf }, inodes: { 501: lf }, size: 1 }
		const remoteTree: RemoteTree = { tree: { "/rf.txt": rf }, uuids: { "u-rf": rf }, size: 1 }

		makeState(stub).applyDoneTasksToState({
			doneTasks: [
				{ path: "/f.txt", type: "deleteLocalFile" },
				{ path: "/rf.txt", type: "deleteRemoteFile" }
			],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		expect(localTree.tree["/f.txt"]).toBeUndefined()
		expect(localTree.inodes[501]).toBeUndefined()
		expect(stub.localFileHashes).toEqual({})
		expect(remoteTree.tree["/rf.txt"]).toBeUndefined()
		expect(remoteTree.uuids["u-rf"]).toBeUndefined()
	})

	it("relocates a single local and remote file rename, leaving a prefix-sibling untouched (no descendant scan)", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "rf2-uuid")

		stub.localFileHashes = { "/a.txt": "hA", "/a.txt.bak": "hBak" }

		const lf = localFile("/a.txt", 601)
		// Shares the "/a.txt" PREFIX but is NOT a descendant ("/a.txt/..."), so a file rename must leave it be.
		const sibling = localFile("/a.txt.bak", 602)
		const rf = remoteFile("/ra.txt", "u-ra", "ra.txt")
		const rsibling = remoteFile("/ra.txt.bak", "u-rab", "ra.txt.bak")
		const localTree: LocalTree = { tree: { "/a.txt": lf, "/a.txt.bak": sibling }, inodes: { 601: lf, 602: sibling }, size: 2 }
		const remoteTree: RemoteTree = { tree: { "/ra.txt": rf, "/ra.txt.bak": rsibling }, uuids: { "u-ra": rf, "u-rab": rsibling }, size: 2 }

		makeState(stub).applyDoneTasksToState({
			doneTasks: [
				{ path: "/b.txt", type: "renameLocalFile", from: "/a.txt", to: "/b.txt", stats: makeStats({ mtimeMs: 1, birthtimeMs: 1, size: 0, ino: 601 }) },
				{ path: "/rb.txt", type: "renameRemoteFile", from: "/ra.txt", to: "/rb.txt" }
			],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		// The file moved (tree + inode + its own hash)...
		expect(localTree.tree["/b.txt"]).toMatchObject({ path: "/b.txt", inode: 601 })
		expect(localTree.tree["/a.txt"]).toBeUndefined()
		expect(localTree.inodes[601]!.path).toBe("/b.txt")
		expect(stub.localFileHashes["/b.txt"]).toBe("hA")
		expect(stub.localFileHashes["/a.txt"]).toBeUndefined()
		// ...and the prefix-sibling is completely untouched.
		expect(localTree.tree["/a.txt.bak"]).toBe(sibling)
		expect(localTree.inodes[602]).toBe(sibling)
		expect(stub.localFileHashes["/a.txt.bak"]).toBe("hBak")

		expect(remoteTree.tree["/rb.txt"]).toMatchObject({ path: "/rb.txt", name: "rb.txt", uuid: "u-ra" })
		expect(remoteTree.tree["/ra.txt"]).toBeUndefined()
		expect(remoteTree.uuids["u-ra"]!.path).toBe("/rb.txt")
		expect(remoteTree.tree["/ra.txt.bak"]).toBe(rsibling)
		expect(remoteTree.uuids["u-rab"]).toBe(rsibling)
	})

	it("is a safe no-op when a rename targets a path absent from the current trees", () => {
		const vfs = createVirtualFS()
		const stub = makeSyncStub(vfs, "rfm-uuid")
		const localTree: LocalTree = { tree: {}, inodes: {}, size: 0 }
		const remoteTree: RemoteTree = { tree: {}, uuids: {}, size: 0 }

		makeState(stub).applyDoneTasksToState({
			doneTasks: [
				{ path: "/ghostB", type: "renameLocalFile", from: "/ghostA", to: "/ghostB", stats: makeStats({ mtimeMs: 1, birthtimeMs: 1, size: 0, ino: 1 }) },
				{ path: "/rghostB", type: "renameRemoteFile", from: "/rghostA", to: "/rghostB" }
			],
			currentLocalTree: localTree,
			currentRemoteTree: remoteTree
		})

		// No source item existed, so nothing is created or moved on either side.
		expect(localTree.tree).toEqual({})
		expect(localTree.inodes).toEqual({})
		expect(remoteTree.tree).toEqual({})
		expect(remoteTree.uuids).toEqual({})
		expect(stub.localFileHashes).toEqual({})
	})
})
