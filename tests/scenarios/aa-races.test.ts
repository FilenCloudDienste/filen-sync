import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotLocal, snapshotRemote, messagesOfType } from "../harness/snapshot"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category AA — concurrency / race conditions and the large-deletion confirmation across modes. The
 * lock cases prove a cycle survives another device holding the remote resource lock (it reports a
 * cycleError and recovers when released, never corrupting state). The confirmation cases extend the
 * Category G prompt — which only covered twoWay — to the directional modes: the prompt fires for the
 * side a mode is allowed to delete (localToCloud→local, cloudToLocal→remote) and NEVER fires for the
 * additive backup modes (which never delete the target).
 *
 * Cycles that block on a confirmation prompt are driven manually (a timer pump delivers the decision).
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

/**
 * Drive one cycle that begins while another device holds the remote lock. With maxTries:Infinity the
 * acquire BLOCKS (retrying every second) instead of failing, so the cycle does no work and reports no
 * cycleError until the lock frees. Mirrors cycleWithDecision's timer pump so the blocked acquire and the
 * rest of the (now unblocked) cycle both drain deterministically. `assertWhileBlocked` runs at the point
 * the cycle is provably still waiting on the lock, before it is released.
 */
async function cycleBlockedByContendedLock(world: World, assertWhileBlocked: () => void): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	let settled = false
	const cyclePromise = world.sync.runCycle().finally(() => {
		settled = true
	})

	// Spin several retry windows (past the 3s "acquiring lock" notice); the cycle stays blocked.
	await vi.advanceTimersByTimeAsync(5000)

	expect(settled, "the cycle must block on the contended lock, not fail").toBe(false)

	assertWhileBlocked()

	// Another device releases the lock; the acquire succeeds on its next retry and the cycle finishes.
	world.cloud.controls.releaseLockContention(lockResource(world))

	for (let tick = 0; tick < 30 && !settled; tick++) {
		await vi.advanceTimersByTimeAsync(1000)
	}

	await cyclePromise
}

function lockResource(world: World): string {
	return `sync-remoteParentUUID-${world.cloud.controls.rootUUID}`
}

function confirmDeletionCount(world: World): number {
	return messagesOfType(world.messages, "confirmDeletion").length
}

describe("Category AA — races & cross-mode deletion confirmation", () => {
	it("AA1: a contended remote lock makes the cycle wait, then it recovers when released", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "data" } }, async world => {
			world.cloud.controls.contendLock(lockResource(world))

			await cycleBlockedByContendedLock(world, () => {
				// Blocked on the lock (the engine acquires with maxTries:Infinity): it announced it is waiting,
				// reported NO error, and did NO work (no corruption) — the previous fake threw here instead.
				expect(messagesOfType(world.messages, "cycleAcquiringLockStarted").length).toBeGreaterThan(0)
				expect(messagesOfType(world.messages, "cycleError").length).toBe(0)
				expect(snapshotRemote(world)["/a.txt"]).toBeUndefined()
			})

			// The now-unblocked cycle (plus a follow-up to settle both sides) syncs to convergence.
			await plainCycle(world)

			expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
			expect(snapshotLocal(world)).toEqual(snapshotRemote(world))
		})
	})

	it("AA2: a cycle blocked by lock contention applies ALL pending adds and deletes once released", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/keep.txt": "k", "/local/remove.txt": "r" } }, async world => {
			await plainCycle(world)
			await plainCycle(world)

			// Queue an add and a delete, then block the next cycle on a contended lock.
			writeLocal(world, "added.txt", "added")
			rmLocal(world, "remove.txt")
			world.triggerWatcher()
			world.cloud.controls.contendLock(lockResource(world))

			await cycleBlockedByContendedLock(world, () => {
				// Nothing applied while the cycle is blocked on the lock.
				expect(snapshotRemote(world)["/added.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/remove.txt"]).toMatchObject({ type: "file" })
			})

			// After release the queued work all lands and the worlds converge.
			await plainCycle(world)

			expect(snapshotRemote(world)["/added.txt"]).toMatchObject({ type: "file" })
			expect(snapshotRemote(world)["/remove.txt"]).toBeUndefined()
			expect(snapshotLocal(world)).toEqual(snapshotRemote(world))
		})
	})

	it("AA3: localToCloud — emptying the local side prompts a local-deletion confirmation", async () => {
		await withWorld(
			{ mode: "localToCloud", requireConfirmationOnLargeDeletion: true, initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" } },
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				expect(messagesOfType(world.messages, "confirmDeletion")[0]!.data.where).toBe("local")
				// "delete" confirmed → the remote mirror is emptied.
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})

	it("AA4: cloudToLocal — emptying the remote side prompts a remote-deletion confirmation", async () => {
		await withWorld(
			{ mode: "cloudToLocal", requireConfirmationOnLargeDeletion: true, initialRemote: { "/a.txt": "a", "/b.txt": "b" } },
			async world => {
				await plainCycle(world)

				world.cloud.controls.trashPath("/a.txt")
				world.cloud.controls.trashPath("/b.txt")

				await cycleWithDecision(world, "delete")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				expect(messagesOfType(world.messages, "confirmDeletion")[0]!.data.where).toBe("remote")
				// "delete" confirmed → the local mirror is emptied.
				expect(snapshotLocal(world)).toEqual({})
			}
		)
	})

	it("AA5: localToCloud — answering 'restart' to the prompt skips the deletions", async () => {
		await withWorld(
			{ mode: "localToCloud", requireConfirmationOnLargeDeletion: true, initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" } },
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// "restart" → the remote still holds both files (deletions not applied).
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	it("AA6: localBackup — emptying the local side NEVER prompts (backups don't delete the target)", async () => {
		await withWorld(
			{ mode: "localBackup", requireConfirmationOnLargeDeletion: true, initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" } },
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await plainCycle(world)

				expect(confirmDeletionCount(world)).toBe(0)
				// The remote backup is untouched.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	it("AA7: cloudBackup — emptying the remote side NEVER prompts (backups don't delete the target)", async () => {
		await withWorld(
			{ mode: "cloudBackup", requireConfirmationOnLargeDeletion: true, initialRemote: { "/a.txt": "a", "/b.txt": "b" } },
			async world => {
				await plainCycle(world)

				world.cloud.controls.trashPath("/a.txt")
				world.cloud.controls.trashPath("/b.txt")

				await plainCycle(world)

				expect(confirmDeletionCount(world)).toBe(0)
				// The local backup is untouched.
				expect(snapshotLocal(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	it("AA8: a file replaced (vanished + re-created) mid-flight is handled without error and converges", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "v1" } }, async world => {
			await plainCycle(world)

			// Remote deletes a.txt while local re-creates it with new content in the same beat — the delete
			// task re-checks existence and the engine still settles on the surviving local content.
			world.cloud.controls.trashPath("/a.txt")
			writeLocal(world, "a.txt", "v2-local-recreated")
			world.triggerWatcher()

			await plainCycle(world)
			await plainCycle(world)
			await plainCycle(world)

			expect(messagesOfType(world.messages, "taskErrors").some(message => message.data.errors.length > 0)).toBe(false)
			expect(snapshotLocal(world)).toEqual(snapshotRemote(world))
		})
	})
})
