import { describe, it, expect, vi } from "vitest"
import pathModule from "path"
import { SYNC_INTERVAL, LOCAL_TRASH_NAME } from "../../src/constants"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotRemote, messagesOfType, countMessages } from "../harness/snapshot"
import { rmLocal } from "../harness/mutations"
import { makeErrnoError } from "../fakes/virtual-fs"
import { type SyncMessage } from "../../src/types"

/**
 * Category Q — cycle lifecycle internals (behavioral spec §I, §8). These pin the parts of
 * `Sync.smokeTest` / `Sync.runCycle` / `Sync.cleanupLocalTrash` that the happy-path suite never
 * reaches: the smoke-test retry loop (local writable/readable + remote-present), the per-cycle gate
 * that refuses to proceed while an unresolved task error is pending, the catch-all `cycleError`, the
 * deletion-confirmation re-prompt, and the 30-day local-trash eviction.
 *
 * Like Categories G and I these cycles are driven MANUALLY (the smoke-test and confirmation paths
 * block on real timers), so fake timers are installed, the clock pinned to BASE_TIME, and the sync
 * interval pumped before each {@link Sync.runCycle}.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const
const DAY_MS = 86400000

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

describe("Category Q — cycle lifecycle internals", () => {
	it("Q1: a failed local writable smoke test emits cycleLocalSmokeTestFailed and retries until the path heals", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			// twoWay smoke-tests the local path for WRITABILITY; an injected EACCES makes isPathWritable false.
			world.vfs.controls.setError(world.syncPair.localPath, makeErrnoError("EACCES"))

			const messages = await capture(world, async () => {
				const smoke = world.sync.smokeTest()

				// Let the first attempt fail and schedule its SYNC_INTERVAL retry…
				await vi.advanceTimersByTimeAsync(1)

				// …then heal the fault so the scheduled retry passes and smokeTest resolves.
				world.vfs.controls.clearError(world.syncPair.localPath)

				await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
				await smoke
			})

			expect(messagesOfType(messages, "cycleLocalSmokeTestFailed").length).toBeGreaterThan(0)
			// It recovered (the promise resolved) rather than failing the remote check.
			expect(messagesOfType(messages, "cycleRemoteSmokeTestFailed").length).toBe(0)
		})
	})

	it("Q2: a read-only mode smoke-tests readability instead, and a failed read also retries to recovery", async () => {
		await withWorld({ mode: "localToCloud" }, async world => {
			// localToCloud smoke-tests the local path for READABILITY (isPathReadable), a distinct branch.
			world.vfs.controls.setError(world.syncPair.localPath, makeErrnoError("EACCES"))

			const messages = await capture(world, async () => {
				const smoke = world.sync.smokeTest()

				await vi.advanceTimersByTimeAsync(1)

				world.vfs.controls.clearError(world.syncPair.localPath)

				await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
				await smoke
			})

			expect(messagesOfType(messages, "cycleLocalSmokeTestFailed").length).toBeGreaterThan(0)
		})
	})

	it("Q3: a failed remote smoke test emits cycleRemoteSmokeTestFailed and retries until the remote is present", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			// The local check passes; the remote presence probe throws, so remoteDirPathExisting returns false.
			world.cloud.controls.setError("present", new Error("present unavailable"))

			const messages = await capture(world, async () => {
				const smoke = world.sync.smokeTest()

				await vi.advanceTimersByTimeAsync(1)

				world.cloud.controls.clearError("present")

				await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
				await smoke
			})

			expect(messagesOfType(messages, "cycleRemoteSmokeTestFailed").length).toBeGreaterThan(0)
			// The local smoke test was never the problem here.
			expect(messagesOfType(messages, "cycleLocalSmokeTestFailed").length).toBe(0)
		})
	})

	it("Q4: cleanupLocalTrash evicts entries older than 30 days and keeps recent ones", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const trashDir = pathModule.posix.join(world.syncPair.localPath, LOCAL_TRASH_NAME)

			world.vfs.ifs.mkdirSync(trashDir, { recursive: true })
			world.vfs.ifs.writeFileSync(pathModule.posix.join(trashDir, "old.txt"), "stale")
			world.vfs.ifs.writeFileSync(pathModule.posix.join(trashDir, "fresh.txt"), "recent")

			const now = Date.now()
			// old.txt: last accessed 31 days ago (beyond the 30-day retention) → evicted.
			const staleSeconds = (now - DAY_MS * 31) / 1000
			// fresh.txt: accessed 1 day ago → retained.
			const recentSeconds = (now - DAY_MS) / 1000

			world.vfs.ifs.utimesSync(pathModule.posix.join(trashDir, "old.txt"), staleSeconds, staleSeconds)
			world.vfs.ifs.utimesSync(pathModule.posix.join(trashDir, "fresh.txt"), recentSeconds, recentSeconds)

			// Register the eviction interval, then fire one tick (the glob + rm settle within the advance).
			world.sync.cleanupLocalTrash()

			await vi.advanceTimersByTimeAsync(300000 + 1)
			await vi.advanceTimersByTimeAsync(1)

			expect(world.vfs.ifs.existsSync(pathModule.posix.join(trashDir, "old.txt"))).toBe(false)
			expect(world.vfs.ifs.existsSync(pathModule.posix.join(trashDir, "fresh.txt"))).toBe(true)
		})
	})

	it("Q5: a cycle that starts with an unresolved task error re-reports it and restarts without doing work", async () => {
		await withWorld({ mode: "twoWay", initialRemote: { "/dir/a.txt": "content" } }, async world => {
			// Settle twice so both previous trees + the engine's remote uuid cache are populated.
			await plainCycle(world)
			await plainCycle(world)

			// Delete locally but force the remote trash to fail → the failing cycle records a task error.
			rmLocal(world, "dir/a.txt")
			world.cloud.controls.setError("trashFile", new Error("backend unavailable"))
			world.triggerWatcher()

			await plainCycle(world)

			// The NEXT cycle is NOT reset, so it observes the pending task error at the very top and gates:
			// it re-emits taskErrors + cycleRestarting and returns BEFORE starting the cycle body.
			const gated = await capture(world, () => plainCycle(world))

			expect(messagesOfType(gated, "taskErrors").length).toBeGreaterThan(0)
			expect(messagesOfType(gated, "cycleRestarting").length).toBeGreaterThan(0)
			expect(countMessages(gated, "cycleStarted")).toBe(0)
		})
	})

	it("Q6: an error thrown while fetching the trees is caught and surfaced as cycleError", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "x" } }, async world => {
			await plainCycle(world)

			// Make the remote tree fetch throw inside the cycle body (after the lock + smoke test).
			world.cloud.controls.setError("tree", new Error("tree fetch boom"))
			world.triggerWatcher()

			const errored = await capture(world, () => plainCycle(world))

			expect(messagesOfType(errored, "cycleError").length).toBeGreaterThan(0)
		})
	})

	it("Q7: the deletion-confirmation prompt is re-emitted every second while it waits for a decision", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

				let settled = false
				const cyclePromise = world.sync.runCycle().finally(() => {
					settled = true
				})

				// Advance (without delivering a decision) until the prompt opens.
				for (let tick = 0; tick < 30 && messagesOfType(world.messages, "confirmDeletion").length === 0; tick++) {
					await vi.advanceTimersByTimeAsync(1000)
				}

				const afterOpen = messagesOfType(world.messages, "confirmDeletion").length

				expect(afterOpen).toBeGreaterThan(0)

				// One more second with no decision → the prompt is re-emitted (the waiting branch).
				await vi.advanceTimersByTimeAsync(1000)

				expect(messagesOfType(world.messages, "confirmDeletion").length).toBeGreaterThan(afterOpen)

				// Now deliver the decision each tick until the cycle completes.
				for (let tick = 0; tick < 30 && !settled; tick++) {
					world.worker.confirmDeletion(world.syncPair.uuid, "delete")

					await vi.advanceTimersByTimeAsync(1000)
				}

				await cyclePromise

				// "delete" was confirmed, so the emptying proceeded.
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})
})
