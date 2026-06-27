import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Lock from "../../src/lib/lock"
import type Sync from "../../src/lib/sync"

/**
 * Lock refresh resilience (F2). The lock auto-refreshes its server-side hold on a 5s interval. The release
 * path must NOT tear that interval down before the release has durably succeeded: a transient
 * releaseResourceLock failure restores acquiredCount to >= 1, and if the refresh timer was already gone (and
 * not restarted) every later acquire() short-circuits (count > 1) without re-installing it, so the lock
 * silently lapses while the engine still believes it holds it — letting another device acquire it
 * concurrently (split-brain). These tests pin that the timer survives a failed release and is only torn down
 * once a release actually succeeds.
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

describe("Lock — refresh survives a release failure (F2)", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("keeps refreshing the still-held lock after releaseResourceLock fails, then tears down on a successful release", async () => {
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

		// The refresh interval is live: advancing 5s fires one refresh.
		await vi.advanceTimersByTimeAsync(5000)
		expect(handlers.refreshResourceLock.mock.calls.length).toBeGreaterThanOrEqual(1)

		// A transient release failure must NOT kill the refresh timer.
		await expect(lock.release()).rejects.toThrow("release boom")
		expect(handlers.releaseResourceLock).toHaveBeenCalledTimes(1)

		const refreshesBefore = handlers.refreshResourceLock.mock.calls.length
		await vi.advanceTimersByTimeAsync(5000)
		expect(
			handlers.refreshResourceLock.mock.calls.length,
			"the still-held lock must keep refreshing after a failed release"
		).toBeGreaterThan(refreshesBefore)

		// A later successful release genuinely releases it and stops refreshing.
		releaseShouldFail = false
		await lock.release()
		expect(handlers.releaseResourceLock).toHaveBeenCalledTimes(2)

		const refreshesAfterRelease = handlers.refreshResourceLock.mock.calls.length
		await vi.advanceTimersByTimeAsync(15000)
		expect(
			handlers.refreshResourceLock.mock.calls.length,
			"no refreshes after the lock is released"
		).toBe(refreshesAfterRelease)
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
