import { describe, it, expect, beforeAll, afterAll } from "vitest"
import FilenSDK, { PauseSignal } from "@filen/sdk"
import fs from "fs-extra"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, messagesOfType, allOps } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, rmLocal, uploadRemote, readLocal, existsLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — the SyncWorker control surface against the live backend, the live counterpart of mocked
 * Category I (+ the abort-driven error path of Q5). These exercise the REAL worker methods a host app
 * drives at runtime — pause/resume (I2), runtime mode change (I6), pair removal + db cleanup (I3),
 * idempotent registration (I7), per-transfer pause/stop routing (I4), and stop-then-retry for an upload
 * (I5) — plus the task-error gate (Q5). A pre-registered abort controller is the deterministic stand-in
 * for an in-flight transfer: the SDK honors the abort at the chunk-loop entry, so a pre-aborted upload
 * fails reliably (verified by hammering). Stopping a DOWNLOAD is covered too — and surfaced a real bug now
 * fixed in remote.ts: an aborted download RESOLVES with a 0-byte staged file, which the engine used to
 * commit as synced (permanent divergence); the integrity guard now discards an incomplete download so the
 * next cycle re-fetches it in full. Only runOnce (I1) stays mocked-only — a self-scheduling one-shot loop
 * whose distinctive effect, cleanup-without-reschedule, is already exercised live by I3.
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
			expect(allOps(pausedMessages)).toEqual([])
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

	it("pauseTransfer / resumeTransfer route to the per-transfer signal; unknown keys are safe no-ops (I4)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			// Stand in for an in-flight upload: a registered pause signal keyed `${type}:${path}`.
			const signalKey = "upload:/a.txt"
			world.sync.pauseSignals[signalKey] = new PauseSignal()

			// pauseTransfer / resumeTransfer route by the same key and flip the real signal's state.
			world.worker.pauseTransfer(uuid, "upload", "/a.txt")
			expect(world.sync.pauseSignals[signalKey]!.isPaused()).toBe(true)

			world.worker.resumeTransfer(uuid, "upload", "/a.txt")
			expect(world.sync.pauseSignals[signalKey]!.isPaused()).toBe(false)

			// An unknown key is a safe no-op: no throw and no signal conjured.
			world.worker.pauseTransfer(uuid, "download", "/does-not-exist.txt")
			expect(world.sync.pauseSignals["download:/does-not-exist.txt"]).toBeUndefined()
		})
	})

	it("stopping a transfer surfaces an error, and a retry converges (I5)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			await writeLocal(world, "a.txt", "v1")

			// Pre-register the transfer's abort controller (as if in flight) and stop it via the worker; the
			// upload then runs against an already-aborted signal — the engine reuses the registered controller.
			const signalKey = "upload:/a.txt"
			world.sync.abortControllers[signalKey] = new AbortController()
			world.worker.stopTransfer(uuid, "upload", "/a.txt")

			expect(world.sync.abortControllers[signalKey]!.signal.aborted).toBe(true)

			const abortedMessages = await cycle(world)
			const uploadErrors = messagesOfType(abortedMessages, "transfer").filter(
				message => message.data.of === "upload" && message.data.type === "error"
			)

			// The abort is surfaced as an upload transfer error and nothing was uploaded.
			expect(uploadErrors.length).toBeGreaterThan(0)
			expect((await snapshotRemoteReal(world))["/a.txt"]).toBeUndefined()

			// Retry on a later cycle: clear the recorded task error (it gates the next cycle); a fresh
			// controller is created and the upload succeeds against the real backend.
			world.worker.resetTaskErrors(uuid)
			await settle(world)
			await expectConverged(world)

			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("a cycle starting with an unresolved task error re-reports it and gates without doing work (Q5)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			await writeLocal(world, "a.txt", "v1")

			// Induce a REAL task error (no synthetic injection): stop the upload so the transfer fails and the
			// engine records a task error for the pair.
			world.sync.abortControllers["upload:/a.txt"] = new AbortController()
			world.worker.stopTransfer(uuid, "upload", "/a.txt")

			await cycle(world)

			// The NEXT cycle is NOT error-reset, so it observes the pending task error at the very top and
			// gates: it re-emits taskErrors + cycleRestarting and returns BEFORE cycleStarted (no work done).
			const gated = await cycle(world)

			expect(messagesOfType(gated, "taskErrors").length).toBeGreaterThan(0)
			expect(messagesOfType(gated, "cycleRestarting").length).toBeGreaterThan(0)
			expect(messagesOfType(gated, "cycleStarted").length).toBe(0)
			expect((await snapshotRemoteReal(world))["/a.txt"], "still nothing uploaded while the error gates").toBeUndefined()
		})
	})

	it("an incomplete (stopped) download is discarded, not committed as 0 bytes, and a retry converges", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			// A remote-origin file the engine will pull down.
			await uploadRemote(world, "r.txt", "remote-content")

			// Pre-abort the download. The SDK resolves with a 0-byte staged file (the aborted stream ends
			// cleanly), but the engine's integrity guard must DISCARD it on the size mismatch instead of
			// moving a 0-byte file into place and caching it as synced — which would diverge permanently.
			const signalKey = "download:/r.txt"
			world.sync.abortControllers[signalKey] = new AbortController()
			world.worker.stopTransfer(uuid, "download", "/r.txt")

			const abortedMessages = await cycle(world)

			expect(
				messagesOfType(abortedMessages, "transfer").filter(message => message.data.of === "download" && message.data.type === "error")
					.length
			).toBeGreaterThan(0)
			// The guard prevented a corrupt 0-byte file from being committed locally.
			expect(await existsLocal(world, "r.txt"), "the incomplete download must not be committed").toBe(false)

			// Retry: the FULL file downloads and the worlds converge (no lingering 0-byte divergence).
			world.worker.resetTaskErrors(uuid)
			await settle(world)
			await expectConverged(world)

			expect(await readLocal(world, "r.txt")).toBe("remote-content")
		})
	})

	it("an upload failure on an already-synced, then EDITED file does not suppress the retry (F1)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			// First sync the file so it exists on BOTH sides and its md5 is recorded in localFileHashes.
			await writeLocal(world, "a.txt", "v1-original")
			await settle(world)
			await expectConverged(world)

			// Edit it (distinct size) → the modify branch, which consults the md5 dedup cache.
			await writeLocal(world, "a.txt", "v2-edited-longer-content")

			// Fail the upload of the edit by pre-aborting its transfer (no synthetic injection).
			const signalKey = "upload:/a.txt"
			world.sync.abortControllers[signalKey] = new AbortController()
			world.worker.stopTransfer(uuid, "upload", "/a.txt")

			const abortedMessages = await cycle(world)

			expect(
				messagesOfType(abortedMessages, "transfer").filter(message => message.data.of === "upload" && message.data.type === "error")
					.length
			).toBeGreaterThan(0)
			// The edit has not landed remotely yet (still the original).
			expect((await snapshotRemoteReal(world, { withContent: true }))["/a.txt"]).toMatchObject({ size: "v1-original".length })

			// Recover. resetTaskErrors does NOT clear localFileHashes — if the failed upload had poisoned it with
			// the edit's hash, the modify branch would now find the hash already cached and SUPPRESS the
			// re-upload, stranding the edit locally forever. With the fix the hash is only written on success.
			world.worker.resetTaskErrors(uuid)
			await settle(world)
			await expectConverged(world)

			expect(await readLocal(world, "a.txt")).toBe("v2-edited-longer-content")
			expect((await snapshotRemoteReal(world, { withContent: true }))["/a.txt"]).toMatchObject({ size: "v2-edited-longer-content".length })
		})
	})
})
