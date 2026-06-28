import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Lock from "../../src/lib/lock"
import type Sync from "../../src/lib/sync"

/**
 * Lock teardown on release (H1). The lock auto-refreshes its server-side hold on a 5s interval. When the
 * LAST holder releases, the refresh interval AND the held state must be torn down UNCONDITIONALLY — even if
 * the server releaseResourceLock call fails. The implementation keeps the invariant "refresh timer alive iff
 * acquiredCount > 0", which closes both failure modes at once:
 *
 *  - Keeping the timer alive after the holder is gone (the earlier "restore the count so it can retry"
 *    behavior) renews a lock NOBODY holds forever: the count never returns to 0, the release is never
 *    retried, and no other device can ever acquire it (cross-device starvation).
 *  - Leaving acquiredCount >= 1 with a DEAD timer is the opposite hazard — the engine believes it holds a
 *    lock the server has let lapse (split-brain).
 *
 * A failed release therefore STOPS refreshing and resets to the unheld state; the server-side lock TTL
 * lapses the now-un-refreshed hold, and the retained uuid lets the next acquire re-acquire cleanly.
 */

type LockHandlers = {
	acquireResourceLock: ReturnType<typeof vi.fn>
	refreshResourceLock: ReturnType<typeof vi.fn>
	releaseResourceLock: ReturnType<typeof vi.fn>
}

function makeLock(handlers: LockHandlers): Lock {
	const sync = {
		sdk: {
			user: () => handlers
		}
	} as unknown as Sync

	return new Lock({ sync, resource: "sync-test-resource" })
}

describe("Lock — teardown on release survives a server release failure (H1)", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("stops refreshing and resets to the unheld state after a failed release (no held-forever)", async () => {
		let releaseShouldFail = true
		const handlers: LockHandlers = {
			acquireResourceLock: vi.fn(async () => {}),
			refreshResourceLock: vi.fn(async () => {}),
			releaseResourceLock: vi.fn(async () => {
				if (releaseShouldFail) {
					throw new Error("release boom")
				}
			})
		}

		const lock = makeLock(handlers)

		await lock.acquire()
		expect(handlers.acquireResourceLock).toHaveBeenCalledTimes(1)

		// The refresh interval is live while held.
		await vi.advanceTimersByTimeAsync(5000)
		expect(handlers.refreshResourceLock.mock.calls.length).toBeGreaterThanOrEqual(1)

		// The (last) release fails at the server, but the holder is gone: the failure surfaces...
		await expect(lock.release()).rejects.toThrow("release boom")
		expect(handlers.releaseResourceLock).toHaveBeenCalledTimes(1)

		// ...and refreshing STOPS. A lock that kept refreshing here would be held forever (the H1 bug);
		// with the timer torn down the server-side TTL lapses the un-refreshed hold.
		const refreshesAfterFailure = handlers.refreshResourceLock.mock.calls.length
		await vi.advanceTimersByTimeAsync(20000)
		expect(
			handlers.refreshResourceLock.mock.calls.length,
			"a relinquished lock must not keep refreshing after a failed release"
		).toBe(refreshesAfterFailure)

		// The held state was reset (acquiredCount back to 0), so the next acquire is a REAL server acquire —
		// not a re-entrant no-op, which is what a count stuck at >= 1 (believing it still holds) would yield.
		releaseShouldFail = false
		await lock.acquire()
		expect(handlers.acquireResourceLock, "a reset lock must re-acquire from the server").toHaveBeenCalledTimes(2)

		await lock.release()
		expect(handlers.releaseResourceLock).toHaveBeenCalledTimes(2)
	})

	it("keeps refreshing while a re-entrant holder remains, and only tears down on the final release", async () => {
		const handlers: LockHandlers = {
			acquireResourceLock: vi.fn(async () => {}),
			refreshResourceLock: vi.fn(async () => {}),
			releaseResourceLock: vi.fn(async () => {})
		}

		const lock = makeLock(handlers)

		await lock.acquire()
		await lock.acquire()

		// Inner release: an outer holder remains, so the timer must stay alive (count > 0) and the sdk is
		// untouched.
		await lock.release()
		expect(handlers.releaseResourceLock).not.toHaveBeenCalled()

		const refreshesBefore = handlers.refreshResourceLock.mock.calls.length
		await vi.advanceTimersByTimeAsync(5000)
		expect(
			handlers.refreshResourceLock.mock.calls.length,
			"the timer lives while any holder remains"
		).toBeGreaterThan(refreshesBefore)

		// Outer release: last holder gone → release the server lock and stop refreshing.
		await lock.release()
		expect(handlers.releaseResourceLock).toHaveBeenCalledTimes(1)

		const refreshesAfter = handlers.refreshResourceLock.mock.calls.length
		await vi.advanceTimersByTimeAsync(15000)
		expect(handlers.refreshResourceLock.mock.calls.length).toBe(refreshesAfter)
	})

	it("a clean acquire/release leaves no refresh timer running", async () => {
		const handlers: LockHandlers = {
			acquireResourceLock: vi.fn(async () => {}),
			refreshResourceLock: vi.fn(async () => {}),
			releaseResourceLock: vi.fn(async () => {})
		}

		const lock = makeLock(handlers)

		await lock.acquire()
		await lock.release()
		expect(handlers.releaseResourceLock).toHaveBeenCalledTimes(1)

		const refreshes = handlers.refreshResourceLock.mock.calls.length
		await vi.advanceTimersByTimeAsync(20000)
		expect(handlers.refreshResourceLock.mock.calls.length).toBe(refreshes)
	})
})
