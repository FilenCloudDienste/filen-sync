import { describe, it, expect, vi } from "vitest"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { type LocalItem, type LocalTree } from "../../src/lib/filesystems/local"
import { type RemoteItem, type RemoteTree } from "../../src/lib/filesystems/remote"

/**
 * Category ZN — deltas.process() must return its deltas ordered shallow-to-deep (ascending path depth) so
 * the executor always creates/renames/deletes a parent directory before touching its children.
 *
 * process() used to sort by depth TWICE: once over the full PRE-collapse set and again over the collapsed
 * result. collapseDeltas only ever filters (drops subsumed descendants) or rewrites a rename's `from` — it
 * never reorders and never changes a delta's `path` — and it indexes the renamed/deleted directories up
 * front, so it is independent of input order. The pre-collapse sort was therefore redundant: a single sort
 * on the (smaller) collapsed set yields the identical order, with each delta's depth computed once instead
 * of re-splitting the path on every comparison. This locks the observable contract — the returned deltas
 * are depth-ascending and child deletes still fold into their ancestor — so the dropped sort cannot
 * silently regress ordering.
 *
 * Behavior-preserving performance change with no backend-observable effect (the executor consumes the same
 * ordered set); correctness against the live backend is covered by every convergence e2e scenario.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const

async function withWorld(options: CreateWorldOptions, body: (world: World) => Promise<void>): Promise<void> {
	vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
	vi.setSystemTime(BASE_TIME)

	try {
		const world = await createWorld(options)

		await body(world)
	} finally {
		vi.useRealTimers()
	}
}

function localFile(path: string, inode: number): LocalItem {
	return { type: "file", path, inode, size: 100, lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 }
}

function localDir(path: string, inode: number): LocalItem {
	return { type: "directory", path, inode, size: 0, lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 }
}

function remoteFile(path: string, uuid: string): RemoteItem {
	return {
		type: "file",
		uuid,
		name: path.slice(path.lastIndexOf("/") + 1),
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

function remoteDir(path: string, uuid: string): RemoteItem {
	return { type: "directory", uuid, name: path.slice(path.lastIndexOf("/") + 1), size: 0, path }
}

describe("Category ZN — process() returns depth-ordered deltas after a single post-collapse sort", () => {
	it("ZN1: a directory delete that subsumes its child, alongside nested adds, yields depth-ascending output", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			// Base: /gone and /gone/inner.txt were synced on both sides.
			const goneDir = localDir("/gone", 1)
			const goneInner = localFile("/gone/inner.txt", 2)
			const goneDirR = remoteDir("/gone", "u-gone")
			const goneInnerR = remoteFile("/gone/inner.txt", "u-gone-inner")

			const previousLocalTree: LocalTree = {
				tree: { "/gone": goneDir, "/gone/inner.txt": goneInner },
				inodes: { 1: goneDir, 2: goneInner },
				size: 2
			}
			const previousRemoteTree: RemoteTree = {
				tree: { "/gone": goneDirR, "/gone/inner.txt": goneInnerR },
				uuids: { "u-gone": goneDirR, "u-gone-inner": goneInnerR },
				size: 2
			}

			// Current local: /gone was deleted, and a fresh nested subtree /new/sub/deep.txt was added — so the
			// raw deltas span depths 2..4 and include a child delete that must fold into its ancestor dir delete.
			// The subtree is inserted DEEP-FIRST: the add pass emits in tree-iteration order, so the raw (pre-sort)
			// deltas come out deepest-first — only the final depth sort restores parents-before-children, which is
			// exactly what this test must catch if it ever regresses.
			const newDeep = localFile("/new/sub/deep.txt", 12)
			const newSub = localDir("/new/sub", 11)
			const newDir = localDir("/new", 10)
			const currentLocalTree: LocalTree = {
				tree: { "/new/sub/deep.txt": newDeep, "/new/sub": newSub, "/new": newDir },
				inodes: { 12: newDeep, 11: newSub, 10: newDir },
				size: 3
			}

			// Current remote: unchanged (still holds /gone + child), so the local delete propagates to the remote.
			const currentRemoteTree: RemoteTree = {
				tree: { "/gone": goneDirR, "/gone/inner.txt": goneInnerR },
				uuids: { "u-gone": goneDirR, "u-gone-inner": goneInnerR },
				size: 2
			}

			const { deltas } = await world.sync.deltas.process({
				currentLocalTree,
				currentRemoteTree,
				previousLocalTree,
				previousRemoteTree,
				currentLocalTreeErrors: [],
				currentLocalTreeIgnored: []
			})

			// The child delete folded into the ancestor directory delete (collapse ran).
			expect(deltas.find(delta => delta.path === "/gone/inner.txt"), "child delete must be subsumed by /gone").toBeUndefined()
			// The collapsed parent delete and the deepest add are both present, so the set spans depths 2..4.
			expect(deltas.some(delta => delta.type === "deleteRemoteDirectory" && delta.path === "/gone")).toBe(true)
			expect(deltas.some(delta => delta.type === "uploadFile" && delta.path === "/new/sub/deep.txt")).toBe(true)

			// The contract P5 must preserve: the returned deltas are ordered ascending by path depth (parents
			// before children), produced by the single post-collapse sort.
			const depths = deltas.map(delta => delta.path.split("/").length)
			expect(depths, `deltas must be depth-ascending, got: ${deltas.map(delta => delta.path).join(", ")}`).toEqual(
				[...depths].sort((a, b) => a - b)
			)
		})
	})
})
