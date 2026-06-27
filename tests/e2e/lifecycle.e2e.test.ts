import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import fs from "fs-extra"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, messagesOfType, transferOps } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, rmLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — the SyncWorker control surface against the live backend, the live counterpart of mocked
 * Category I. These exercise the REAL worker methods a host app drives at runtime (pause/resume, runtime
 * mode change, pair removal + db cleanup, idempotent registration) and assert their backend-observable
 * effect on the real account — not just internal signal routing. Three Category I cases stay mocked-only
 * for genuine determinism reasons (not omission): pauseTransfer/stopTransfer mid-upload (I4/I5) — the SDK
 * only honors the abort inside the chunk loop, so aborting a real tiny-file upload is a race (the same
 * limit that keeps Category O mocked); and runOnce (I1) — a self-scheduling one-shot loop whose distinctive
 * effect is cleanup-without-reschedule, which IS exercised live here by the updateRemoved cleanup (I3).
 */
describe.skipIf(!E2E_ENABLED)("E2E — lifecycle & control surface", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("a paused pair short-circuits its cycle; resuming syncs the pending change (I2)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			world.worker.updatePaused(world.syncPair.uuid, true)

			// A change is pending while paused.
			await writeLocal(world, "a.txt", "v1")

			const pausedMessages = await cycle(world)

			// The cycle short-circuits before doing any work: cyclePaused is emitted, nothing starts/transfers.
			expect(messagesOfType(pausedMessages, "cyclePaused").length).toBeGreaterThan(0)
			expect(messagesOfType(pausedMessages, "cycleStarted").length).toBe(0)
			expect(transferOps(pausedMessages)).toEqual([])
			expect((await snapshotRemoteReal(world))["/a.txt"], "nothing uploaded while paused").toBeUndefined()

			// Resume → the pending change now syncs to the real backend and the worlds converge.
			world.worker.updatePaused(world.syncPair.uuid, false)
			await settle(world)
			await expectConverged(world)

			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("updateMode mid-run switches behavior on the next cycle: twoWay -> localBackup stops deletions (I6)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "a")
			await writeLocal(world, "b.txt", "b")
			await settle(world)
			await expectConverged(world)

			// Switch to a backup mode; it must take effect on the NEXT cycle.
			world.worker.updateMode(world.syncPair.uuid, "localBackup")

			// A deletion twoWay WOULD propagate, plus an addition.
			await rmLocal(world, "a.txt")
			await writeLocal(world, "c.txt", "c")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// localBackup propagates additions but NOT deletions, proving the new mode is active.
			expect(remote["/c.txt"]).toMatchObject({ type: "file" })
			expect(remote["/a.txt"], "the local deletion was NOT mirrored (backup keeps the remote copy)").toMatchObject({
				type: "file"
			})
		})
	})

	it("removing a pair aborts its in-flight transfers, deletes its db files, and exits (I3)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "a")
			// First settle persists state + a deviceId, so there are real db files to delete.
			await settle(world)

			const stateFiles = [
				world.sync.state.previousLocalTreePath,
				world.sync.state.previousRemoteTreePath,
				world.sync.state.localFileHashesPath
			]

			for (const file of stateFiles) {
				expect(await fs.pathExists(file)).toBe(true)
			}

			// Stand in for an in-flight transfer: a registered, not-yet-aborted controller at the real key.
			world.sync.abortControllers["upload:/a.txt"] = new AbortController()

			const mark = world.messages.length

			await world.worker.updateRemoved(world.syncPair.uuid, true)

			const removalMessages = world.messages.slice(mark)

			// The transfer was aborted, the pair is marked removed, and it exited (cleanup -> cycleExited).
			expect(world.sync.abortControllers["upload:/a.txt"]!.signal.aborted).toBe(true)
			expect(world.sync.removed).toBe(true)
			expect(messagesOfType(removalMessages, "cycleExited").length).toBeGreaterThan(0)

			// The persisted state files for this pair are gone from the real filesystem.
			for (const file of stateFiles) {
				expect(await fs.pathExists(file)).toBe(false)
			}
		})
	})

	it("updateSyncPairs is an idempotent no-op for empty input and an already-registered pair (I7)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "a")
			await settle(world)
			await expectConverged(world)

			const existingSync = world.worker.syncs[world.syncPair.uuid]

			// Empty input returns early; re-registering the existing pair must not recreate its Sync.
			await world.worker.updateSyncPairs([])
			await world.worker.updateSyncPairs([world.syncPair])

			expect(world.worker.syncs[world.syncPair.uuid]).toBe(existingSync)

			// The worker stays healthy after the no-op registrations: a new change still converges live.
			await writeLocal(world, "b.txt", "b")
			await settle(world)
			await expectConverged(world)

			expect((await snapshotRemoteReal(world))["/b.txt"]).toMatchObject({ type: "file" })
		})
	})
})
