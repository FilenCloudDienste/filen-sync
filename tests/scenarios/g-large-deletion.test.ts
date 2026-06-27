import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotLocal, snapshotRemote, messagesOfType } from "../harness/snapshot"
import { rmLocal } from "../harness/mutations"

/**
 * Category G — large-deletion confirmation (behavioral spec §G, §6). When
 * requireConfirmationOnLargeDeletion is set and an entire side is emptied, the engine emits a
 * `confirmDeletion` prompt every second and blocks the cycle until `confirmDeletion(uuid, decision)`
 * arrives. "delete" proceeds; "restart" (or timeout) skips the cycle's deletions.
 *
 * These cycles block mid-run on the prompt, so they are driven manually (not via runScenario): the
 * timer pump below both fires the 1s prompt interval and delivers the user's decision.
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

/** Drive one cycle that is NOT expected to block on a confirmation prompt. */
async function plainCycle(world: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	await world.sync.runCycle()
}

/** Drive one cycle, delivering `decision` to any confirmation prompt so the cycle can complete. */
async function cycleWithDecision(world: World, decision: "delete" | "restart"): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	let settled = false
	const cyclePromise = world.sync.runCycle().finally(() => {
		settled = true
	})

	// The prompt resets the decision to "waiting" when it opens, so re-deliver each tick until the
	// 1s interval observes it and the cycle moves on.
	for (let tick = 0; tick < 30 && !settled; tick++) {
		world.worker.confirmDeletion(world.syncPair.uuid, decision)

		await vi.advanceTimersByTimeAsync(1000)
	}

	await cyclePromise
}

function confirmDeletionCount(world: World): number {
	return messagesOfType(world.messages, "confirmDeletion").length
}

describe("Category G — large-deletion confirmation", () => {
	it("G1: emptying the local side and confirming the deletion proceeds", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				expect(messagesOfType(world.messages, "confirmDeletion")[0]!.data.where).toBe("local")
				// "delete" was given, so the remote is emptied to match.
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})

	it("G2: emptying the local side and answering restart skips the cycle (no deletions)", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// "restart" was given, so the deletions are NOT applied — the remote still has both files.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G3: confirmRemoteDeletion is gated by BOTH the mode and the `previousRemote.size <= deleteCount`
	// threshold (symmetric to confirmLocalDeletion). Here the remote is emptied but only part of it is
	// attributable to remote-side deletions (the rest was deleted locally), so the threshold is NOT met
	// and there is NO prompt. (BUG-001 fix: the missing `&&` that dropped the threshold + mode gate is
	// restored, so confirmRemoteDeletion is now symmetric with confirmLocalDeletion.)
	it("G3: a sub-threshold remote emptying does not trigger a confirmation prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				// Start from the remote so the previous remote tree is observed non-empty (size 3) — an
				// upload-only cycle would leave previousRemote.size at 0 and the prompt could never fire.
				initialRemote: { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c" }
			},
			async world => {
				await plainCycle(world)

				// Remote loses everything, but one of those removals is also a LOCAL deletion — so it is
				// attributed to a remote-delete, leaving deleteLocalCount (2) < previousRemote.size (3). The
				// correct (threshold-gated) confirmRemoteDeletion is therefore false.
				world.cloud.controls.trashPath("/a.txt")
				world.cloud.controls.trashPath("/b.txt")
				world.cloud.controls.trashPath("/c.txt")
				rmLocal(world, "a.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				// TARGET: the threshold is not met, so the engine proceeds without prompting.
				expect(confirmDeletionCount(world)).toBe(0)
			}
		)
	})

	it("G4: with confirmation disabled, a full emptying deletes without prompting", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: false,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await plainCycle(world)

				expect(confirmDeletionCount(world)).toBe(0)
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})

	it("G5: a partial deletion (side not emptied) does not trigger a prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b", "/local/c.txt": "c" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				world.triggerWatcher()

				await plainCycle(world)

				expect(confirmDeletionCount(world)).toBe(0)
				// Only the deleted file is gone; the rest remain.
				expect(snapshotRemote(world)["/a.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/c.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)["/a.txt"]).toBeUndefined()
			}
		)
	})
})
