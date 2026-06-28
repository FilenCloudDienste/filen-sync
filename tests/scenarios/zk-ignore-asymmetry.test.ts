import { describe, it, expect, vi } from "vitest"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { type LocalItem, type LocalTree, type LocalTreeIgnored } from "../../src/lib/filesystems/local"
import { type RemoteItem, type RemoteTree } from "../../src/lib/filesystems/remote"

/**
 * Category ZK — a remote deletion must not delete the LOCAL copy of a path that is IGNORED locally (M4).
 *
 * The local-deletions pass skips ignored paths (BUG-006): a path that is physically present locally but
 * excluded from the scanned tree — over-long name, invalid path, a default-ignore that grew across an
 * upgrade, a case-duplicate — must keep its cloud copy, never be reported as a deletion. The symmetric
 * remote-deletions pass had no such guard: when that same ignored path's REMOTE copy was deleted, it
 * emitted deleteLocal* and wiped the on-disk file the user never asked to sync.
 *
 * The end-of-process ignore filter does NOT cover this: it only consults the .filenignore matcher (and the
 * dot-file flag), never the nameLength / pathLength / invalidPath / defaultIgnore / duplicate reasons that
 * `currentLocalTreeIgnored` carries — so a .filenignore-based test would be masked and falsely pass. These
 * tests therefore drive deltas.process() directly with an injected `currentLocalTreeIgnored` entry whose
 * path the (empty) ignorer does NOT match, modelling exactly those non-.filenignore reasons.
 *
 * This is client-side delta-attribution logic; the backend's only role (a path deleted remotely) is already
 * covered by the live deletion e2e tests, and the trigger — a base path that became ignored for a
 * non-.filenignore reason — cannot be forced deterministically against the real backend, so there is no
 * e2e counterpart (boundary noted in tests/e2e/regressions.e2e.test.ts).
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
	return { type: "directory", uuid, name, size: 0, path }
}

const ignoredEntry = (path: string): LocalTreeIgnored => ({ localPath: `/local${path}`, relativePath: path, reason: "nameLength" })

// A base where `path` was synced on both sides; the remote copy is now gone. The local copy is present on
// disk but the caller decides (via currentLocalTree / currentLocalTreeIgnored) whether the scan ignored it.
function baseWith(path: string, kind: "file" | "dir"): { previousLocalTree: LocalTree; previousRemoteTree: RemoteTree } {
	const li = kind === "dir" ? localDir(path, 101) : localFile(path, 101)
	const ri = kind === "dir" ? remoteDir(path, "u-1", path.slice(1)) : remoteFile(path, "u-1", path.slice(1))

	return {
		previousLocalTree: { tree: { [path]: li }, inodes: { 101: li }, size: 1 },
		previousRemoteTree: { tree: { [path]: ri }, uuids: { "u-1": ri }, size: 1 }
	}
}

const EMPTY_LOCAL: LocalTree = { tree: {}, inodes: {}, size: 0 }
const EMPTY_REMOTE: RemoteTree = { tree: {}, uuids: {}, size: 0 }

describe("Category ZK — a remote deletion must not wipe a locally-ignored file", () => {
	it("ZK1: an IGNORED local file whose remote copy was deleted is NOT deleted locally", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const { previousLocalTree, previousRemoteTree } = baseWith("/over-long.txt", "file")

			// Current state: remote deleted it (absent remotely), and the local scan IGNORED it (absent from the
			// scanned tree, recorded in currentLocalTreeIgnored). The file is still on disk.
			const { deltas } = await world.sync.deltas.process({
				currentLocalTree: EMPTY_LOCAL,
				currentRemoteTree: EMPTY_REMOTE,
				previousLocalTree,
				previousRemoteTree,
				currentLocalTreeErrors: [],
				currentLocalTreeIgnored: [ignoredEntry("/over-long.txt")]
			})

			const wipes = deltas.filter(d => d.type === "deleteLocalFile" && d.path === "/over-long.txt")

			expect(wipes, "a remote delete must not propagate onto an ignored local file").toHaveLength(0)
			// And it must not have been mistaken for a local deletion to push to the cloud either (BUG-006).
			expect(deltas.filter(d => d.type === "deleteRemoteFile" && d.path === "/over-long.txt")).toHaveLength(0)
		})
	})

	it("ZK2: an IGNORED local directory whose remote copy was deleted is NOT deleted locally", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const { previousLocalTree, previousRemoteTree } = baseWith("/over-long-dir", "dir")

			const { deltas } = await world.sync.deltas.process({
				currentLocalTree: EMPTY_LOCAL,
				currentRemoteTree: EMPTY_REMOTE,
				previousLocalTree,
				previousRemoteTree,
				currentLocalTreeErrors: [],
				currentLocalTreeIgnored: [ignoredEntry("/over-long-dir")]
			})

			expect(deltas.filter(d => d.type === "deleteLocalDirectory" && d.path === "/over-long-dir")).toHaveLength(0)
		})
	})

	it("ZK3 (no over-suppression): a NON-ignored local file whose remote copy was deleted IS still deleted locally", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const { previousLocalTree, previousRemoteTree } = baseWith("/normal.txt", "file")
			const li = localFile("/normal.txt", 101)

			// Same remote deletion, but the local file is present in the scanned tree (not ignored). The normal
			// remote->local deletion propagation must still happen — the guard must not over-suppress.
			const { deltas } = await world.sync.deltas.process({
				currentLocalTree: { tree: { "/normal.txt": li }, inodes: { 101: li }, size: 1 },
				currentRemoteTree: EMPTY_REMOTE,
				previousLocalTree,
				previousRemoteTree,
				currentLocalTreeErrors: [],
				currentLocalTreeIgnored: []
			})

			expect(
				deltas.filter(d => d.type === "deleteLocalFile" && d.path === "/normal.txt"),
				"a normal remote deletion must still propagate to the local copy"
			).toHaveLength(1)
		})
	})
})
