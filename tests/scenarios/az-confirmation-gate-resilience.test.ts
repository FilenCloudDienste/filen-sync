import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, restartSync, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotRemote, snapshotLocal, messagesOfType } from "../harness/snapshot"
import { rmLocal } from "../harness/mutations"

/**
 * Category AZ — the large-deletion confirmation gate under crash/restart and alongside other work.
 *
 * Category G pins the gate's basic decisions; G6/G7 pin a pause/remove WHILE awaiting. The gate parks the
 * WHOLE cycle (no tasks run until answered), so two further properties matter for production safety:
 *   1. a process that DIES while awaiting must not lose data — the un-confirmed deletion was never applied,
 *      the base is unchanged, and a fresh engine re-derives the same prompt (never a silent delete);
 *   2. confirming a large deletion must also carry the cycle's non-deletion work (a concurrent remote add),
 *      since the gate blocks the whole cycle, not just the deletes.
 *
 * These cycles block mid-run on the prompt, so they are driven manually with a timer pump (like Category G).
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

/** Drive one cycle, delivering `decision` to any confirmation prompt so the cycle can complete. */
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

/** Open the prompt, then "crash": abandon the awaiting cycle (the process dies) without answering. */
async function openPromptThenCrash(world: World): Promise<boolean> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	let settled = false
	const cyclePromise = world.sync.runCycle().finally(() => {
		settled = true
	})

	// Let the prompt open, then simulate the process going away mid-wait (bail the wait loop so the test's
	// fake-timer cycle can settle, modelling the awaiting cycle never completing its tasks/state-save).
	await vi.advanceTimersByTimeAsync(1000)

	world.sync.removed = true

	for (let tick = 0; tick < 5 && !settled; tick++) {
		await vi.advanceTimersByTimeAsync(1000)
	}

	if (settled) {
		await cyclePromise
	}

	world.sync.removed = false

	return settled
}

function confirmDeletionCount(world: World): number {
	return messagesOfType(world.messages, "confirmDeletion").length
}

describe("Category AZ — confirmation gate resilience", () => {
	it("AZ1: a crash WHILE awaiting confirmation applies no deletion; a fresh engine re-prompts, then confirm deletes", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				// Empty the local side, then "crash" while the confirmation prompt is open.
				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				const settled = await openPromptThenCrash(world)

				expect(settled, "the awaiting cycle must abandon cleanly on crash").toBe(true)
				const promptsBeforeRestart = confirmDeletionCount(world)
				expect(promptsBeforeRestart).toBeGreaterThan(0)
				// No premature deletion — the remote copies survive the crash.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })

				// A fresh engine reloads the unchanged base and re-derives the SAME large deletion → re-prompts.
				await restartSync(world)

				await cycleWithDecision(world, "delete")

				// The prompt fired again after the restart (the deletion was never silently applied)…
				expect(confirmDeletionCount(world)).toBeGreaterThan(promptsBeforeRestart)
				// …and only now, with an explicit confirm, is the remote emptied.
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})

	it("AZ2: confirming a large deletion also carries the cycle's concurrent remote ADDITION", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				// Empty the local side (triggers the gate) while a brand-new file appears remotely.
				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.cloud.controls.addFile("/new-from-remote.txt", "NEW", { mtimeMs: BASE_TIME + 100_000 })
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// The emptied base files are deleted remotely…
				expect(snapshotRemote(world)["/a.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/b.txt"]).toBeUndefined()
				// …and the concurrent remote addition was NOT dropped by the gate — it downloaded to local.
				expect(snapshotRemote(world)["/new-from-remote.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)["/new-from-remote.txt"]).toMatchObject({ type: "file", size: "NEW".length })
			}
		)
	})

	it("AZ3: repeatedly DECLINING the prompt holds the data indefinitely; a later confirm finally deletes", async () => {
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

				// Decline twice across two cycles — the data must survive each time.
				await cycleWithDecision(world, "restart")
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })

				world.triggerWatcher()
				await cycleWithDecision(world, "restart")
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })

				// Finally confirm — the deletion the user kept declining now applies.
				world.triggerWatcher()
				await cycleWithDecision(world, "delete")
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})
})
