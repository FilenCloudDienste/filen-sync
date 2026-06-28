import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { messagesOfType } from "../harness/snapshot"
import { makeErrnoError } from "../fakes/virtual-fs"

/**
 * Category ZI — the local smoke test must not hold the account lock during a local outage (H7).
 *
 * The smoke test retries every SYNC_INTERVAL for as long as the local sync root is unavailable (an
 * unmounted drive, a disconnected network filesystem). It used to run AFTER the lock was acquired, so the
 * whole outage held the account lock and starved every other device. Running it BEFORE the lock means an
 * outage stalls only this pair's cycle. (The retry loop was also de-recursed so a long outage no longer
 * grows the stack by one suspended frame per retry.)
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

const countOf = (world: World, type: Parameters<typeof messagesOfType>[1]): number => messagesOfType(world.messages, type).length

describe("Category ZI — smoke test does not hold the lock during a local outage", () => {
	it("ZI1: a local outage retries the smoke test WITHOUT acquiring the lock, then proceeds on recovery", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "a" } }, async world => {
			// Settle once for a clean base.
			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
			await world.sync.runCycle()

			const lockDoneBaseline = countOf(world, "cycleAcquiringLockDone")

			// Simulate a local outage: the sync root is no longer accessible.
			world.vfs.controls.setError("/local", makeErrnoError("EACCES", "local sync root unavailable"))

			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

			let settled = false
			const cyclePromise = world.sync.runCycle().finally(() => {
				settled = true
			})

			// Pump several retry intervals while the outage persists.
			for (let i = 0; i < 3 && !settled; i++) {
				await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
			}

			// The smoke test failed and kept failing — but the lock was NEVER acquired (before the fix it
			// would have been, because the smoke test ran under the lock), and the cycle has not settled.
			expect(countOf(world, "cycleLocalSmokeTestFailed")).toBeGreaterThan(0)
			expect(countOf(world, "cycleAcquiringLockDone"), "the lock must not be acquired during the outage").toBe(lockDoneBaseline)
			expect(settled).toBe(false)

			// Recover: the path is accessible again. The next retry succeeds and the cycle runs to completion.
			world.vfs.controls.clearError("/local")

			for (let i = 0; i < 10 && !settled; i++) {
				await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
			}

			await cyclePromise

			expect(settled).toBe(true)
			expect(countOf(world, "cycleAcquiringLockDone"), "after recovery the lock is acquired and the cycle proceeds").toBeGreaterThan(
				lockDoneBaseline
			)
		})
	})
})
