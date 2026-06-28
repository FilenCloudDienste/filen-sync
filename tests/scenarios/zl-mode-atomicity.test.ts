import { describe, it, expect, vi } from "vitest"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { type LocalItem, type LocalTree } from "../../src/lib/filesystems/local"
import { type RemoteItem, type RemoteTree } from "../../src/lib/filesystems/remote"

/**
 * Category ZL — one cycle must compute its whole delta set under a SINGLE mode (M6).
 *
 * process() is async (it awaits a content hash on the same-size/newer-mtime path) and reads the pair's
 * mode in ~20 places across its passes. updateMode() mutates sync.mode synchronously from the main thread
 * at any moment, so a mode switch landing during one of those awaits used to split a single cycle across
 * two modes — e.g. the local-deletions pass running as twoWay while a later pass runs as cloudToLocal —
 * producing a self-contradictory delta set (here: a brand-new local file silently dropped instead of
 * uploaded). The fix snapshots the mode once at entry and reports it back.
 *
 * The mode flip is injected through the one awaited dependency inside the passes (createFileHash), which is
 * exactly the real race window. This is client-side delta logic with no backend role, so there is no e2e
 * counterpart (boundary noted in tests/e2e/regressions.e2e.test.ts).
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

function localFile(path: string, inode: number, lastModified = 1_700_000_000_000): LocalItem {
	return { type: "file", path, inode, size: 100, lastModified, creation: 1_690_000_000_000 }
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

const EMPTY_REMOTE: RemoteTree = { tree: {}, uuids: {}, size: 0 }

describe("Category ZL — a mid-cycle mode switch must not split one delta computation", () => {
	it("ZL1: a mode switch DURING process() does not split the cycle across two modes", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			// "hashme.txt" forces the single awaited content hash inside the delta passes; the stub flips the
			// pair's mode mid-flight, exactly as a racing updateMode() would. (Its own delta is irrelevant.)
			const hashSpy = vi.spyOn(world.sync.localFileSystem, "createFileHash").mockImplementation(async () => {
				world.sync.mode = "cloudToLocal"

				return "cached-hash"
			})

			world.sync.localFileHashes["/hashme.txt"] = "cached-hash"

			const baseHash = localFile("/hashme.txt", 201, 1_700_000_000_000)
			const currentHash = localFile("/hashme.txt", 201, 1_700_000_010_000) // same size, newer mtime -> needs the hash
			const remoteHash = remoteFile("/hashme.txt", "u-h", "hashme.txt")
			const newLocal = localFile("/localnew.txt", 202)

			const currentLocalTree: LocalTree = {
				tree: { "/hashme.txt": currentHash, "/localnew.txt": newLocal },
				inodes: { 201: currentHash, 202: newLocal },
				size: 2
			}

			const { deltas, mode } = await world.sync.deltas.process({
				currentLocalTree,
				currentRemoteTree: EMPTY_REMOTE, // both remote copies are gone
				previousLocalTree: { tree: { "/hashme.txt": baseHash }, inodes: { 201: baseHash }, size: 1 },
				previousRemoteTree: { tree: { "/hashme.txt": remoteHash }, uuids: { "u-h": remoteHash }, size: 1 },
				currentLocalTreeErrors: [],
				currentLocalTreeIgnored: []
			})

			expect(hashSpy, "the scenario must actually reach the awaited hash (the race window)").toHaveBeenCalled()

			// The new local file is attributed by the local-additions pass, which runs AFTER that await. Under the
			// entry mode (twoWay) it must upload; a live read of the flipped mode (cloudToLocal) would skip the
			// whole pass and silently drop the file. The single-mode snapshot keeps the cycle on twoWay.
			expect(
				deltas.filter(d => d.type === "uploadFile" && d.path === "/localnew.txt"),
				"a pass after the mid-cycle flip must still use the entry mode"
			).toHaveLength(1)
			expect(deltas.filter(d => d.type === "deleteLocalFile" && d.path === "/localnew.txt")).toHaveLength(0)
			expect(mode, "process() reports the one mode the whole cycle ran under").toBe("twoWay")
		})
	})
})
