import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, type E2EWorld } from "./harness/world"
import { settle, messagesOfType } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, rmLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — large-deletion confirmation against the live backend. When
 * `requireConfirmationOnLargeDeletion` is set and an entire side is emptied, the engine raises a
 * `confirmDeletion` prompt every second and BLOCKS the cycle until `confirmDeletion(uuid, decision)`
 * arrives: "delete" proceeds, "restart" skips the cycle's deletions. This is the live counterpart of
 * mocked Category G — the gate's threshold is computed from the real tree sizes the real walk reports,
 * and the confirmed deletion is carried out against the real backend.
 *
 * Because the cycle blocks mid-run, these are driven by hand (real timers): start the cycle, deliver the
 * decision repeatedly (the prompt resets it to "waiting" each tick) until the cycle resolves.
 */
async function runCycleWithDecision(world: E2EWorld, decision: "delete" | "restart"): Promise<void> {
	world.worker.resetCache(world.syncPair.uuid)

	let settled = false
	const cyclePromise = world.sync.runCycle().finally(() => {
		settled = true
	})

	// Deliver the decision until the 1s prompt interval observes it and the cycle moves on. 250ms poll vs
	// the 1s prompt interval is a comfortable margin; the 80-iteration cap (20s) is only a safety net.
	for (let tick = 0; tick < 80 && !settled; tick++) {
		world.worker.confirmDeletion(world.syncPair.uuid, decision)

		await new Promise<void>(resolve => setTimeout(resolve, 250))
	}

	await cyclePromise
}

describe.skipIf(!E2E_ENABLED)("E2E — large-deletion confirmation", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("a confirmed full-emptying deletion (decision: delete) propagates to the real backend", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", requireConfirmationOnLargeDeletion: true }, async world => {
			await writeLocal(world, "a.txt", "a")
			await writeLocal(world, "b.txt", "b")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })

			// Empty the entire local side — this trips the large-deletion gate on the next cycle.
			await rmLocal(world, "a.txt")
			await rmLocal(world, "b.txt")

			await runCycleWithDecision(world, "delete")

			// A prompt WAS raised, and the confirmed deletion really emptied the remote.
			expect(messagesOfType(world.messages, "confirmDeletion").length).toBeGreaterThan(0)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toBeUndefined()
		})
	})

	it("declining the prompt (decision: restart) skips the deletion — the remote copies survive", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", requireConfirmationOnLargeDeletion: true }, async world => {
			await writeLocal(world, "x.txt", "x")
			await writeLocal(world, "y.txt", "y")
			await settle(world)

			await rmLocal(world, "x.txt")
			await rmLocal(world, "y.txt")

			await runCycleWithDecision(world, "restart")

			// The deletion was declined: the remote still holds both files (the gate protected them).
			const remote = await snapshotRemoteReal(world)

			expect(remote["/x.txt"]).toMatchObject({ type: "file" })
			expect(remote["/y.txt"]).toMatchObject({ type: "file" })
		})
	})
})
