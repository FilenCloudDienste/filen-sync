import { describe, it, expect, vi } from "vitest"
import { isMainThread } from "worker_threads"
import { postMessageToMain } from "../../src/lib/ipc"
import { Lock } from "../../src/lib/lock"
import { serializeError } from "../../src/utils"
import { type SyncMessage } from "../../src/types"
import { createFakeCloud, type FakeCloudControls } from "../fakes/fake-cloud"
import { createVirtualFS } from "../fakes/virtual-fs"
import type Sync from "../../src/lib/sync"

/**
 * Unit coverage for the two IPC/locking seams the scenario suite never exercises directly:
 *
 * - `src/lib/ipc.ts` `postMessageToMain` — its three mutually exclusive routing branches
 *   (`ipcProcess.onMessage`, the main-thread `process.send` fallback, and the worker-thread
 *   `parentPort.postMessage`). The worker-thread branch is unreachable from vitest's main thread,
 *   so it is driven by re-importing the module under a scoped `vi.doMock("worker_threads", ...)`.
 * - `src/lib/lock.ts` `Lock` — acquire/release, re-entrant counting, the 5s refresh interval and its
 *   swallow-on-error contract, plus the acquire-contention and release-error rollback paths. The lock
 *   is the REAL class, driven through a minimal `Sync` stand-in whose sdk wraps the fake cloud's
 *   actual `user()` lock methods in spies (so `controls.contendLock` / `setError` semantics are real).
 */

/**
 * `process` augmented with the worker IPC hook. The hook is declared as a global `NodeJS.Process`
 * member in `index.d.ts`; re-stating the shape locally lets this file type-check in single-file mode
 * (where that ambient augmentation is not in scope) as well as in the full `tsconfig.test.json` program.
 */
const ipcProcess = process as NodeJS.Process & { onMessage?: (message: SyncMessage) => void }

/** A fixed clock so the fake cloud's timestamps and the refresh interval are deterministic. */
const FIXED_TIME = new Date("2024-06-01T00:00:00.000Z").getTime()

/** Faked time primitives — mirrors the scenario suite so the refresh `setInterval` is controllable. */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const

/** A concrete, opaque message; `postMessageToMain` forwards it verbatim on every branch. */
const MESSAGE: SyncMessage = {
	type: "error",
	data: {
		error: serializeError(new Error("ipc boom")),
		uuid: "ipc-test"
	}
}

/**
 * Restore an optional `process` property. Under `exactOptionalPropertyTypes` a bare
 * `ipcProcess.onMessage = undefined` is a type error — the absent state must be expressed by `delete`,
 * not by assigning `undefined`. These helpers route through `delete` when the saved value was absent.
 */
function restoreOnMessage(value: ((message: SyncMessage) => void) | undefined): void {
	if (value === undefined) {
		delete ipcProcess.onMessage
	} else {
		ipcProcess.onMessage = value
	}
}

function restoreSend(value: typeof process.send): void {
	if (value === undefined) {
		delete process.send
	} else {
		process.send = value
	}
}

describe("ipc.ts — postMessageToMain", () => {
	it("(a) routes to ipcProcess.onMessage when it is set", () => {
		const original = ipcProcess.onMessage
		const onMessage = vi.fn()

		ipcProcess.onMessage = onMessage

		try {
			postMessageToMain(MESSAGE)

			expect(onMessage).toHaveBeenCalledTimes(1)
			expect(onMessage).toHaveBeenCalledWith(MESSAGE)
		} finally {
			restoreOnMessage(original)
		}
	})

	it("(b) falls back to process.send on the main thread when onMessage is unset", () => {
		const originalOnMessage = ipcProcess.onMessage
		const originalSend = process.send
		const send = vi.fn()

		delete ipcProcess.onMessage
		process.send = send as unknown as NonNullable<typeof process.send>

		try {
			// vitest runs this file on a child process's main thread, so this branch is genuinely taken.
			expect(isMainThread).toBe(true)

			postMessageToMain(MESSAGE)

			expect(send).toHaveBeenCalledTimes(1)
			expect(send).toHaveBeenCalledWith(MESSAGE)
		} finally {
			restoreOnMessage(originalOnMessage)
			restoreSend(originalSend)
		}
	})

	it("(b') is a no-op on the main thread when neither onMessage nor send is available", () => {
		const originalOnMessage = ipcProcess.onMessage
		const originalSend = process.send

		delete ipcProcess.onMessage
		delete process.send

		try {
			// isMainThread is true and process.send is falsy, so the only correct behavior is to do
			// nothing — and crucially not throw.
			expect(() => postMessageToMain(MESSAGE)).not.toThrow()
		} finally {
			restoreOnMessage(originalOnMessage)
			restoreSend(originalSend)
		}
	})

	it("(c) posts to parentPort.postMessage when running inside a worker thread", async () => {
		const originalOnMessage = ipcProcess.onMessage
		const postMessage = vi.fn()

		delete ipcProcess.onMessage

		// The real module sees isMainThread === true on the main thread, so the parentPort branch is
		// only reachable by re-evaluating ipc.ts against a worker-thread-shaped worker_threads.
		vi.resetModules()
		vi.doMock("worker_threads", () => ({
			isMainThread: false,
			parentPort: { postMessage }
		}))

		try {
			const { postMessageToMain: scopedPostMessageToMain } = await import("../../src/lib/ipc")

			scopedPostMessageToMain(MESSAGE)

			expect(postMessage).toHaveBeenCalledTimes(1)
			expect(postMessage).toHaveBeenCalledWith(MESSAGE)
		} finally {
			vi.doUnmock("worker_threads")
			vi.resetModules()

			restoreOnMessage(originalOnMessage)
		}
	})
})

type LockFixture = {
	lock: Lock
	controls: FakeCloudControls
	resource: string
	acquireResourceLock: ReturnType<typeof vi.fn>
	refreshResourceLock: ReturnType<typeof vi.fn>
	releaseResourceLock: ReturnType<typeof vi.fn>
}

/**
 * Build a real {@link Lock} over a minimal `Sync` stand-in. The stand-in's `sdk.user()` returns spies
 * that wrap the fake cloud's ACTUAL lock methods, so `controls.contendLock` / `controls.setError`
 * drive genuine acquire/refresh/release behavior while the calls remain assertable.
 *
 * Runs the body under fake timers (the 5s refresh interval is a `setInterval`) and always restores
 * real timers afterwards, which also discards any interval still registered at body exit.
 */
async function withLock(body: (fixture: LockFixture) => Promise<void>): Promise<void> {
	vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
	vi.setSystemTime(FIXED_TIME)

	try {
		const resource = "sync-remoteParentUUID-test"
		const vfs = createVirtualFS()
		const cloud = createFakeCloud({}, { localFs: vfs.fs })
		const user = cloud.sdk.user()
		// The fake's `user()` methods are stable closures over the same lock maps, so capturing them
		// once and wrapping each in a spy preserves real semantics (contention, injected errors).
		const acquireResourceLock = vi.fn(user.acquireResourceLock)
		const refreshResourceLock = vi.fn(user.refreshResourceLock)
		const releaseResourceLock = vi.fn(user.releaseResourceLock)
		const sync = {
			sdk: {
				user: () => ({ acquireResourceLock, refreshResourceLock, releaseResourceLock })
			}
		} as unknown as Sync
		const lock = new Lock({ sync, resource })

		await body({ lock, controls: cloud.controls, resource, acquireResourceLock, refreshResourceLock, releaseResourceLock })
	} finally {
		vi.useRealTimers()
	}
}

describe("lock.ts — Lock", () => {
	it("acquires then releases, forwarding the resource/lockUUID and freeing the lock", async () => {
		await withLock(async ({ lock, resource, acquireResourceLock, releaseResourceLock }) => {
			await lock.acquire()

			expect(acquireResourceLock).toHaveBeenCalledTimes(1)
			expect(acquireResourceLock.mock.calls[0]![0]).toMatchObject({ resource, maxTries: Infinity, tryTimeout: 1000 })

			const firstLockUUID = acquireResourceLock.mock.calls[0]![0].lockUUID

			expect(typeof firstLockUUID).toBe("string")

			await lock.release()

			expect(releaseResourceLock).toHaveBeenCalledTimes(1)
			expect(releaseResourceLock).toHaveBeenCalledWith({ resource, lockUUID: firstLockUUID })

			// A successful release nulls the uuid and frees the resource: the next acquire mints a fresh
			// uuid and the fake (which rejects a mismatched holder) still accepts it — proving it is free.
			await lock.acquire()

			const secondLockUUID = acquireResourceLock.mock.calls[1]![0].lockUUID

			expect(acquireResourceLock).toHaveBeenCalledTimes(2)
			expect(secondLockUUID).not.toBe(firstLockUUID)

			await lock.release()
		})
	})

	it("counts re-entrant acquire/release and only hits the sdk on the outermost pair", async () => {
		await withLock(async ({ lock, acquireResourceLock, releaseResourceLock }) => {
			await lock.acquire()
			await lock.acquire()

			// The second acquire just increments the counter (acquiredCount > 1) and returns early.
			expect(acquireResourceLock).toHaveBeenCalledTimes(1)

			await lock.release()

			// First release decrements to 1 (acquiredCount > 0) and returns without touching the sdk.
			expect(releaseResourceLock).not.toHaveBeenCalled()

			await lock.release()

			// Only the release that drops the counter to 0 actually releases the remote lock.
			expect(releaseResourceLock).toHaveBeenCalledTimes(1)
		})
	})

	it("refreshes every 5s while held and stops refreshing after release", async () => {
		await withLock(async ({ lock, resource, acquireResourceLock, refreshResourceLock }) => {
			await lock.acquire()

			const lockUUID = acquireResourceLock.mock.calls[0]![0].lockUUID

			expect(refreshResourceLock).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(5000)

			expect(refreshResourceLock).toHaveBeenCalledTimes(1)
			expect(refreshResourceLock).toHaveBeenLastCalledWith({ resource, lockUUID })

			await vi.advanceTimersByTimeAsync(5000)

			expect(refreshResourceLock).toHaveBeenCalledTimes(2)

			await lock.release()

			// release() clears the interval, so further time advancement triggers no more refreshes.
			await vi.advanceTimersByTimeAsync(15000)

			expect(refreshResourceLock).toHaveBeenCalledTimes(2)
		})
	})

	it("swallows a refresh error and keeps refreshing on the next tick", async () => {
		await withLock(async ({ lock, controls, refreshResourceLock }) => {
			await lock.acquire()

			controls.setError("refreshResourceLock", new Error("refresh boom"))

			// The refresh callback's try/catch swallows the rejection — the lock must survive the tick.
			await vi.advanceTimersByTimeAsync(5000)

			expect(refreshResourceLock).toHaveBeenCalledTimes(1)

			controls.clearError("refreshResourceLock")

			await vi.advanceTimersByTimeAsync(5000)

			// Having swallowed the error, the interval is intact and the next tick refreshes normally.
			expect(refreshResourceLock).toHaveBeenCalledTimes(2)

			await lock.release()
		})
	})

	it("propagates an acquire-contention failure, rolls back, then recovers reusing the same uuid", async () => {
		await withLock(async ({ lock, controls, resource, acquireResourceLock, refreshResourceLock }) => {
			controls.contendLock(resource)

			await expect(lock.acquire()).rejects.toThrow(/Could not acquire lock/)

			// The failed acquire rolled the counter back but kept the minted uuid for reuse, and never
			// armed the refresh interval.
			expect(acquireResourceLock).toHaveBeenCalledTimes(1)
			expect(refreshResourceLock).not.toHaveBeenCalled()

			controls.releaseLockContention(resource)

			await lock.acquire()

			expect(acquireResourceLock).toHaveBeenCalledTimes(2)
			// The retained uuid is reused (the `!this.lockUUID` guard is false on the recovery acquire).
			expect(acquireResourceLock.mock.calls[1]![0].lockUUID).toBe(acquireResourceLock.mock.calls[0]![0].lockUUID)

			await lock.release()
		})
	})

	it("is a no-op when releasing while nothing is held", async () => {
		await withLock(async ({ lock, releaseResourceLock }) => {
			await lock.release()

			expect(releaseResourceLock).not.toHaveBeenCalled()
		})
	})

	it("restores the count when releaseResourceLock fails, then releases on retry", async () => {
		await withLock(async ({ lock, controls, releaseResourceLock }) => {
			await lock.acquire()

			controls.setError("releaseResourceLock", new Error("release boom"))

			await expect(lock.release()).rejects.toThrow(/release boom/)

			// The failed release restored the previous count, so the lock is still considered held: a
			// retry (after clearing the error) drops the count to 0 and releases for real.
			expect(releaseResourceLock).toHaveBeenCalledTimes(1)

			controls.clearError("releaseResourceLock")

			await lock.release()

			expect(releaseResourceLock).toHaveBeenCalledTimes(2)
		})
	})
})
