import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotRemote, messagesOfType } from "../harness/snapshot"
import { writeLocal } from "../harness/mutations"

/**
 * Category ZT — the large-deletion confirmation gate must NOT false-fire when files merely become
 * IGNORED. The gate keys on the RAW delete count, which is tallied in the deletion passes BEFORE the
 * end-of-process ignore filter drops ignored-path deltas. Now that the scan PRUNES .filenignore'd paths
 * (so they no longer flow through `ignoredLocalPaths`, which previously made the deletion pass skip them),
 * a path that becomes ignored is briefly counted as a "delete" before being filtered — which could make
 * the gate think the whole side was emptied and prompt the user to confirm deleting everything. It must
 * not: ignoring files is not deleting them, and the deltas are dropped anyway. add-only.
 *
 * These cycles can block on the prompt, so they are driven manually (mirrors Category G).
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

async function plainCycle(world: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	await world.sync.runCycle()
}

/** Drive one cycle, delivering `decision` to ANY confirmation prompt so a (mis)fired gate can't hang. */
async function cycleWithDecision(world: World, decision: "delete" | "restart"): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	let settled = false
	const cyclePromise = world.sync.runCycle().finally(() => {
		settled = true
	})

	for (let tick = 0; tick < 30 && !settled; tick++) {
		world.worker.confirmDeletion(world.syncPair.uuid, decision)

		await vi.advanceTimersByTimeAsync(1000)
	}

	await cyclePromise
}

function confirmDeletionCount(world: World): number {
	return messagesOfType(world.messages, "confirmDeletion").length
}

describe("Category ZT — ignore vs the large-deletion gate", () => {
	it("ZT1: ignoring a PRUNABLE directory that holds the whole side does NOT trigger a deletion prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				// excludeDotFiles so the `.filenignore` file itself is dot-ignored and does NOT keep the local tree
				// non-empty — otherwise the gate's `size === 0` condition could never be reached at all.
				excludeDotFiles: true,
				// Everything lives under one directory so that ignoring it (a bare, glob-PRUNABLE name — the case
				// that bypasses ignoredLocalPaths) empties the local scan entirely.
				initialLocal: { "/local/data/a.txt": "a", "/local/data/b.txt": "b", "/local/data/c.txt": "c" }
			},
			async world => {
				// Sync the subtree to the remote (previous tree becomes {data, data/a, data/b, data/c}).
				await plainCycle(world)

				// Now ignore the whole directory by bare name — it is glob-pruned from the scan, so the local
				// scan sees size 0. The would-be deletes are filtered, but the RAW count must not make the gate
				// believe the whole side was deleted.
				await world.sync.ignorer.update("data")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				// The gate must stay silent — ignoring is not deleting — and the remote backups must survive.
				expect(confirmDeletionCount(world)).toBe(0)
				expect(snapshotRemote(world)["/data/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/data/b.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/data/c.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	it("ZT2: a REAL emptying of the side still triggers the gate (the safety net is intact)", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b", "/local/c.txt": "c" }
			},
			async world => {
				await plainCycle(world)

				// A genuine deletion of every file (no ignore involved) MUST still prompt — proving the fix
				// narrows the count to real deletes without weakening the safety gate.
				world.vfs.ifs.rmSync(`${world.localPath}/a.txt`)
				world.vfs.ifs.rmSync(`${world.localPath}/b.txt`)
				world.vfs.ifs.rmSync(`${world.localPath}/c.txt`)
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// "restart" → deletions NOT applied; remote still intact.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	it("ZT3: ignoring all files while a NEW non-ignored file appears converges with no prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/archive/old1.txt": "1", "/local/archive/old2.txt": "2" }
			},
			async world => {
				await plainCycle(world)

				// Ignore the old files' PRUNABLE directory, then add a fresh non-ignored file at the root.
				await world.sync.ignorer.update("archive")
				writeLocal(world, "fresh.md", "new")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				// No prompt (the side is not empty — fresh.md is present), the new file syncs, the ignored
				// backups survive on the remote.
				expect(confirmDeletionCount(world)).toBe(0)
				expect(snapshotRemote(world)["/fresh.md"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/archive/old1.txt"]).toMatchObject({ type: "file" })
			}
		)
	})
})
