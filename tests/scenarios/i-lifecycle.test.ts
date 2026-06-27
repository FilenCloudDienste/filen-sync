import { describe, it, expect, vi } from "vitest"
import pathModule from "path"
import { PauseSignal } from "@filen/sdk"
import { SYNC_INTERVAL } from "../../src/constants"
import SyncWorker from "../../src/index"
import { type SyncMessage } from "../../src/types"
import { type SyncEnvironment } from "../../src/lib/environment"
import { DEVICE_ID_VERSION } from "../../src/lib/filesystems/remote"
import { createWorld, BASE_TIME, DB_ROOT, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotLocal, snapshotRemote, messagesOfType, countMessages, transferKinds, transferOps } from "../harness/snapshot"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category I — lifecycle / control / transfers (behavioral spec §I, §8). These exercise the
 * SyncWorker control surface that drives a pair's lifecycle: `runOnce` (one cycle then cleanup),
 * `updatePaused` (short-circuit / resume), `updateRemoved` (abort transfers + delete db files),
 * the per-transfer `pauseTransfer`/`resumeTransfer`/`stopTransfer` signals keyed `${type}:${path}`,
 * `updateMode` (mode change takes effect next cycle), and `updateSyncPairs` (runtime registration).
 *
 * Like Category G these cycles are driven MANUALLY (not via runScenario): fake timers are installed,
 * the clock is pinned to BASE_TIME, and {@link plainCycle} pumps the sync interval before each
 * {@link Sync.runCycle}. This gives the deterministic control the lifecycle assertions need.
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

/** Drive exactly one cycle (advance the interval so the local-change wait passes, then run). */
async function plainCycle(world: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	await world.sync.runCycle()
}

/** The messages appended to the world's stream while `body` runs (a per-cycle slice). */
async function capture(world: World, body: () => Promise<void>): Promise<SyncMessage[]> {
	const mark = world.messages.length

	await body()

	return world.messages.slice(mark)
}

describe("Category I — lifecycle / control / transfers", () => {
	it("I1: a runOnce worker performs a single cycle, syncs, then cleans up and exits without rescheduling", async () => {
		await withWorld(
			{
				mode: "twoWay",
				initialLocal: { "/local/a.txt": "hello" }
			},
			async world => {
				// A runOnce pair is a WORKER-level constructor option, so build a second worker over the
				// same virtual fs + cloud + pair. Its messages land on a private stream (process.onMessage
				// is replaced when the worker is constructed), so assert against that stream directly.
				const messages: SyncMessage[] = []
				const environment: SyncEnvironment = {
					fs: world.vfs.fs,
					globFs: world.vfs.globFs,
					writeFileAtomic: async (filename, data, writeOptions): Promise<void> => {
						await world.vfs.fs.writeFile(filename, data, writeOptions)
					},
					createWatcher: async (_path, _onChange) => ({
						close: async (): Promise<void> => {}
					}),
					fetchDirTree: (_sdk, request) => world.cloud.sdk.api(3).dir().tree(request)
				}

				const worker = new SyncWorker({
					syncPairs: [world.syncPair],
					dbPath: DB_ROOT,
					sdk: world.cloud.sdk,
					onMessage: message => {
						messages.push(message)
					},
					disableLogging: true,
					environment,
					runOnce: true
				})

				// initialize() floats the self-driving run() loop; for runOnce that loop runs one cycle
				// then calls cleanup() (which emits cycleExited) instead of rescheduling. Pump until the
				// terminal message arrives — the cycle never blocks, so this settles in a few iterations.
				await worker.initialize()

				for (let tick = 0; tick < 200 && !messages.some(message => message.type === "cycleExited"); tick++) {
					await vi.advanceTimersByTimeAsync(100)
				}

				// The one cycle ran: the pending local file was uploaded and the worlds converged.
				expect(transferKinds(messages)).toContain("upload")
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)).toEqual(snapshotRemote(world))

				// Terminal state: it cleaned up (cycleExited) and did NOT schedule another cycle.
				expect(messages.some(message => message.type === "cycleExited")).toBe(true)
				expect(countMessages(messages, "cycleRestarting")).toBe(0)
				expect(worker.syncs[world.syncPair.uuid]!.removed).toBe(true)
			}
		)
	})

	it("I2: a paused pair short-circuits its cycle and resuming lets the pending change sync", async () => {
		await withWorld(
			{
				mode: "twoWay",
				paused: true
			},
			async world => {
				const uuid = world.syncPair.uuid

				// A change is pending while the pair is paused.
				writeLocal(world, "a.txt", "v1")
				world.triggerWatcher()

				const pausedCycle = await capture(world, () => plainCycle(world))

				// The cycle short-circuits before doing any work: cyclePaused is emitted, nothing starts.
				expect(messagesOfType(pausedCycle, "cyclePaused").length).toBeGreaterThan(0)
				expect(countMessages(pausedCycle, "cycleStarted")).toBe(0)
				expect(transferOps(pausedCycle)).toEqual([])
				// No op happened: the pending addition was NOT uploaded.
				expect(snapshotRemote(world)).toEqual({})

				// Resume via the worker control method, then run a cycle.
				world.worker.updatePaused(uuid, false)
				world.triggerWatcher()

				const resumedCycle = await capture(world, () => plainCycle(world))

				// Now the pending change syncs and the worlds converge.
				expect(messagesOfType(resumedCycle, "cyclePaused").length).toBe(0)
				expect(transferKinds(resumedCycle)).toContain("upload")
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)).toEqual(snapshotRemote(world))
			}
		)
	})

	it("I3: removing a pair aborts its in-flight transfers, deletes its db files, and exits", async () => {
		await withWorld(
			{
				mode: "twoWay",
				initialLocal: { "/local/a.txt": "a" }
			},
			async world => {
				const uuid = world.syncPair.uuid

				// First cycle uploads and persists state + a deviceId, so there are db files to delete.
				await plainCycle(world)

				const stateFiles = [
					world.sync.state.previousLocalTreePath,
					world.sync.state.previousRemoteTreePath,
					world.sync.state.localFileHashesPath
				]
				const deviceIdFile = pathModule.posix.join(DB_ROOT, "deviceId", `v${DEVICE_ID_VERSION}`, uuid)

				for (const file of stateFiles) {
					expect(world.vfs.controls.exists(file)).toBe(true)
				}
				expect(world.vfs.controls.exists(deviceIdFile)).toBe(true)

				// Stand in for an in-flight transfer: a registered, not-yet-aborted controller.
				world.sync.abortControllers["upload:/a.txt"] = new AbortController()

				const removalMessages = await capture(world, () => world.worker.updateRemoved(uuid, true))

				// The transfer was aborted, the pair is marked removed, and it exited (cleanup -> cycleExited).
				expect(world.sync.abortControllers["upload:/a.txt"]!.signal.aborted).toBe(true)
				expect(world.sync.removed).toBe(true)
				expect(messagesOfType(removalMessages, "cycleExited").length).toBeGreaterThan(0)

				// The persisted state + deviceId files for this pair are gone.
				for (const file of stateFiles) {
					expect(world.vfs.controls.exists(file)).toBe(false)
				}
				expect(world.vfs.controls.exists(deviceIdFile)).toBe(false)
			}
		)
	})

	it("I4: pauseTransfer and resumeTransfer toggle a specific transfer signal and the pair still syncs", async () => {
		await withWorld(
			{
				mode: "twoWay"
			},
			async world => {
				const uuid = world.syncPair.uuid

				writeLocal(world, "a.txt", "v1")
				world.triggerWatcher()

				// Stand in for an in-flight upload: a registered pause signal keyed `${type}:${path}`.
				const signalKey = "upload:/a.txt"
				world.sync.pauseSignals[signalKey] = new PauseSignal()

				// pauseTransfer / resumeTransfer route by the same key and flip the signal state.
				world.worker.pauseTransfer(uuid, "upload", "/a.txt")
				expect(world.sync.pauseSignals[signalKey]!.isPaused()).toBe(true)

				world.worker.resumeTransfer(uuid, "upload", "/a.txt")
				expect(world.sync.pauseSignals[signalKey]!.isPaused()).toBe(false)

				// An unknown key is a safe no-op: no throw and no signal conjured.
				world.worker.pauseTransfer(uuid, "download", "/does-not-exist.txt")
				expect(world.sync.pauseSignals["download:/does-not-exist.txt"]).toBeUndefined()

				// With the signal resumed, the cycle still converges. (NOTE: the fake cloud does not honor
				// pauseSignal mid-transfer, so end-to-end blocking is not observable here — only the
				// worker's signal routing is. The transfer consumes/clears the signal when it completes.)
				await plainCycle(world)

				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)).toEqual(snapshotRemote(world))
			}
		)
	})

	it("I5: stopping a specific transfer surfaces an error, and the transfer is retried until it converges", async () => {
		await withWorld(
			{
				mode: "twoWay"
			},
			async world => {
				const uuid = world.syncPair.uuid

				writeLocal(world, "a.txt", "v1")
				world.triggerWatcher()

				// Pre-register the transfer's abort controller (as if it were in flight) and stop it via the
				// worker. The upload then runs against an already-aborted signal — the closest deterministic
				// stand-in for a mid-transfer abort, since the harness completes transfers synchronously.
				const signalKey = "upload:/a.txt"
				world.sync.abortControllers[signalKey] = new AbortController()
				world.worker.stopTransfer(uuid, "upload", "/a.txt")
				expect(world.sync.abortControllers[signalKey]!.signal.aborted).toBe(true)

				const abortedCycle = await capture(world, () => plainCycle(world))

				// The abort is surfaced as an upload transfer error, and nothing was uploaded.
				const uploadErrors = messagesOfType(abortedCycle, "transfer").filter(
					message => message.data.of === "upload" && message.data.type === "error"
				)

				expect(uploadErrors.length).toBeGreaterThan(0)
				expect(snapshotRemote(world)).toEqual({})

				// Retry on a later cycle: clear the recorded task error (it gates the next cycle) and rerun.
				// The controller was disposed by the failed transfer, so a fresh one is created and succeeds.
				world.worker.resetTaskErrors(uuid)
				world.triggerWatcher()

				const retryCycle = await capture(world, () => plainCycle(world))

				expect(transferKinds(retryCycle)).toContain("upload")
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)).toEqual(snapshotRemote(world))

				// Idempotence: a further cycle with no external change performs no transfer.
				world.triggerWatcher()

				const settledCycle = await capture(world, () => plainCycle(world))

				expect(transferOps(settledCycle)).toEqual([])
			}
		)
	})

	it("I6: updateMode mid-run switches behavior on the next cycle (twoWay -> localBackup stops deletions)", async () => {
		await withWorld(
			{
				mode: "twoWay",
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				const uuid = world.syncPair.uuid

				// First cycle (twoWay): both files upload and the worlds converge.
				const firstCycle = await capture(world, () => plainCycle(world))

				expect(transferKinds(firstCycle)).toContain("upload")
				expect(snapshotLocal(world)).toEqual(snapshotRemote(world))

				// Switch to a backup mode; it must take effect on the NEXT cycle.
				world.worker.updateMode(uuid, "localBackup")

				// Delete one file (a deletion that twoWay WOULD propagate) and add another.
				rmLocal(world, "a.txt")
				writeLocal(world, "c.txt", "c")
				world.triggerWatcher()

				const backupCycle = await capture(world, () => plainCycle(world))

				// localBackup propagates additions but NOT deletions, proving the new mode is active:
				// the add reached the cloud, the deletion did not.
				expect(transferKinds(backupCycle)).toContain("upload")
				expect(transferKinds(backupCycle)).not.toContain("deleteRemoteFile")
				expect(snapshotRemote(world)["/c.txt"]).toMatchObject({ type: "file" })
				// The local deletion was NOT mirrored to the cloud (backup keeps the remote copy)…
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				// …and it was not pulled back down either (backup is one-way local -> cloud).
				expect(snapshotLocal(world)["/a.txt"]).toBeUndefined()
			}
		)
	})

	it("I7: updateSyncPairs is a safe idempotent no-op for empty input and an already-registered pair", async () => {
		await withWorld(
			{
				mode: "twoWay",
				initialLocal: { "/local/a.txt": "a" }
			},
			async world => {
				const uuid = world.syncPair.uuid

				await plainCycle(world)

				const existingSync = world.worker.syncs[uuid]

				// Empty input returns early; re-registering the existing pair must not recreate its Sync
				// (the worker guards on syncs[uuid]). Neither call throws or disturbs internal state.
				await world.worker.updateSyncPairs([])
				await world.worker.updateSyncPairs([world.syncPair])

				expect(world.worker.syncs[uuid]).toBe(existingSync)
				expect(Object.keys(world.worker.syncs)).toEqual([uuid])

				// The worker remains healthy after the no-op registrations: a new change still converges.
				// (NOTE: registering a brand-new pair triggers Sync.initialize() -> the self-scheduling
				// run() loop, which this direct-runCycle harness does not host; runtime-add of a NEW pair
				// is therefore covered structurally — method present + idempotent — not end-to-end.)
				writeLocal(world, "b.txt", "b")
				world.triggerWatcher()

				await plainCycle(world)

				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)).toEqual(snapshotRemote(world))
			}
		)
	})
})
