import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { v4 as uuidv4 } from "uuid"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged, messagesOfType } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, deleteRemote } from "./harness/mutations"

/**
 * Phase 3 e2e — concurrency / multi-device races against the live backend, the live counterpart of mocked
 * Category AA. Unlike the fake cloud (whose contended lock makes the cycle error out), the real engine
 * acquires the sync resource lock with `maxTries: Infinity`, so a device that already holds the lock makes
 * the cycle WAIT — the important production property: two devices syncing the same folder never corrupt
 * each other, the loser simply blocks until the lock frees. We hold the real lock from a second SDK
 * "device" to prove this, then prove a concurrent delete+recreate still converges with no task errors.
 */
describe.skipIf(!E2E_ENABLED)("E2E — races & multi-device contention", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("a cycle waits for a contending device's lock, does no work, then converges once released (AA1/AA2)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")

			// The exact resource the engine locks (lib/sync.ts) — a second device grabs it first.
			const resource = `sync-remoteParentUUID-${world.remoteParentUUID}`
			const otherDevice = uuidv4()

			await sdk.user().acquireResourceLock({ resource, lockUUID: otherDevice, maxTries: 1, tryTimeout: 1000 })

			world.worker.resetCache(world.syncPair.uuid)

			let cycleDone = false
			const cyclePromise = world.sync.runCycle().finally(() => {
				cycleDone = true
			})

			try {
				// While the other device holds the lock the engine keeps retrying acquisition and does NO sync
				// work — nothing is uploaded, no state is touched.
				await new Promise<void>(resolve => setTimeout(resolve, 5000))

				expect(cycleDone, "cycle should still be blocked on the contended lock").toBe(false)
				expect((await snapshotRemoteReal(world))["/a.txt"], "no work performed while contended").toBeUndefined()
				// The engine signalled it is waiting for the lock (posted after 3s of waiting).
				expect(messagesOfType(world.messages, "cycleAcquiringLockStarted").length).toBeGreaterThan(0)
			} finally {
				// Release so the engine's pending acquire succeeds on its next try, and drain the now-unblocked
				// cycle before leaving (no orphaned async work during teardown) regardless of how we exit.
				await sdk.user().releaseResourceLock({ resource, lockUUID: otherDevice }).catch(() => {})
				await cyclePromise.catch(() => {})
			}

			// Once released the cycle proceeds; the world converges with the file uploaded — no corruption.
			await settle(world)
			await expectConverged(world)

			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("a file deleted on one side and re-created on the other converges with no task errors (AA8)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "v1")
			await settle(world)
			await expectConverged(world)

			// The remote trashes a.txt while local re-creates it with new content before the next cycle. The
			// engine resolves the delete-vs-recreate without erroring and settles on the surviving content.
			await deleteRemote(world, "a.txt")
			await writeLocal(world, "a.txt", "v2-local-recreated-longer")

			await settle(world)
			await expectConverged(world)

			const anyTaskErrored = messagesOfType(world.messages, "taskErrors").some(message => message.data.errors.length > 0)

			expect(anyTaskErrored, "no task should surface an error across the reconciliation").toBe(false)
			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })
		})
	})
})
