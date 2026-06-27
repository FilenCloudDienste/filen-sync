import { describe, it, expect, vi } from "vitest"
import { PauseSignal } from "@filen/sdk"
import SyncWorker from "../../src/index"
import Sync from "../../src/lib/sync"
import { promiseAllChunked, promiseAllSettledChunked, isPathSyncedByICloud, pathSyncedByICloud } from "../../src/utils"
import { type LocalTreeError } from "../../src/lib/filesystems/local"
import { createWorld, BASE_TIME, DB_ROOT, type CreateWorldOptions, type World } from "../harness/world"
import { makeErrnoError } from "../fakes/virtual-fs"

/**
 * Targeted unit tests for the {@link SyncWorker} public control surface in `src/index.ts` and the
 * remaining uncovered helpers in `src/utils.ts`. The behavioral scenario suite (Category I in
 * particular) already drives the match/effect paths of the lifecycle methods; this file fills the
 * gaps: the constructor option handling, the methods the scenarios do not touch
 * (`resetLocalTreeErrors`, `toggleLocalTrash`, `updateRequireConfirmationOnLargeDeletion`,
 * `fetchIgnorerContent`), the per-transfer pause-signal fan-out inside `updatePaused`, and the
 * "unknown uuid / absent Sync" no-op branches shared by the whole control surface.
 *
 * World-backed tests run under vitest fake timers (matching {@link createWorld}'s contract); the
 * pure helper tests do not need them.
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

/**
 * Run `fn` with `process.platform` temporarily stubbed (async variant of the helper used in
 * `n-unit.test.ts`). `process.platform` is non-writable but configurable, so it is replaced via
 * `defineProperty` and restored from its original descriptor.
 */
async function withPlatformAsync(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
	const original = Object.getOwnPropertyDescriptor(process, "platform")

	Object.defineProperty(process, "platform", { value: platform, configurable: true })

	try {
		await fn()
	} finally {
		if (original) {
			Object.defineProperty(process, "platform", original)
		}
	}
}

describe("SyncWorker public API — constructor", () => {
	it("throws when neither an sdk instance nor an sdkConfig is provided", () => {
		expect(() => new SyncWorker({ syncPairs: [], dbPath: DB_ROOT })).toThrow(
			"Either pass a configured SDK instance OR a SDKConfig object."
		)
	})

	it("falls back to the default environment, defaults runOnce to false, and tolerates a missing onMessage", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			// No `environment` => defaultEnvironment(); no `onMessage` => the process.onMessage assignment
			// is skipped; `runOnce` is omitted => defaults to false.
			const worker = new SyncWorker({
				syncPairs: [world.syncPair],
				dbPath: DB_ROOT,
				sdk: world.cloud.sdk,
				disableLogging: true
			})

			expect(worker.runOnce).toBe(false)
			expect(worker.environment.fs).toBeDefined()
			expect(worker.environment.globFs).toBeDefined()
			expect(typeof worker.environment.writeFileAtomic).toBe("function")
			expect(typeof worker.environment.createWatcher).toBe("function")

			// It registered nothing and started nothing: initialize() was never called.
			expect(Object.keys(worker.syncs)).toEqual([])
		})
	})
})

describe("SyncWorker public API — updateSyncPairs error handling", () => {
	it("surfaces and rethrows an initialization failure for a newly registered pair", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			// A brand-new pair (not yet in `syncs`) makes updateSyncPairs construct a Sync and initialize
			// it. A throwaway Sync over the same pair exposes the exact state directory the real one will
			// `ensureDir()` during initialize(); failing that fs op makes initialize() reject and forces
			// updateSyncPairs into its catch/rethrow.
			const newPair = { ...world.syncPair, uuid: "worker-api-second-pair" }
			const probe = new Sync({ syncPair: newPair, worker: world.worker })

			world.vfs.controls.setError(probe.state.statePath, makeErrnoError("EACCES", "EACCES: permission denied"))

			await expect(world.worker.updateSyncPairs([newPair])).rejects.toThrow("EACCES")
		})
	})
})

describe("SyncWorker public API — per-pair control methods", () => {
	it("resetLocalTreeErrors clears the matching pair's local-tree errors and ignores an unknown uuid", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid
			const treeError: LocalTreeError = {
				localPath: `${world.localPath}/broken.txt`,
				relativePath: "/broken.txt",
				error: new Error("stat failed"),
				uuid: "node-uuid"
			}

			world.sync.localTreeErrors = [treeError]

			// Unknown uuid: the loop `continue`s past the (mismatched) pair, leaving the errors intact.
			world.worker.resetLocalTreeErrors("not-this-pair")
			expect(world.sync.localTreeErrors).toEqual([treeError])

			// Matching uuid: the errors are reset to an empty array.
			world.worker.resetLocalTreeErrors(uuid)
			expect(world.sync.localTreeErrors).toEqual([])
		})
	})

	it("toggleLocalTrash flips localTrashDisabled for the matching pair and ignores an unknown uuid", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			expect(world.sync.localTrashDisabled).toBe(false)

			// Unknown uuid: no change.
			world.worker.toggleLocalTrash("not-this-pair", true)
			expect(world.sync.localTrashDisabled).toBe(false)

			// Matching uuid: disable, then re-enable.
			world.worker.toggleLocalTrash(uuid, true)
			expect(world.sync.localTrashDisabled).toBe(true)

			world.worker.toggleLocalTrash(uuid, false)
			expect(world.sync.localTrashDisabled).toBe(false)
		})
	})

	it("updateRequireConfirmationOnLargeDeletion toggles the flag for the matching pair and ignores an unknown uuid", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			expect(world.sync.requireConfirmationOnLargeDeletion).toBe(false)

			world.worker.updateRequireConfirmationOnLargeDeletion("not-this-pair", true)
			expect(world.sync.requireConfirmationOnLargeDeletion).toBe(false)

			world.worker.updateRequireConfirmationOnLargeDeletion(uuid, true)
			expect(world.sync.requireConfirmationOnLargeDeletion).toBe(true)
		})
	})

	it("fetchIgnorerContent returns the matching pair's ignorer content and an empty string for an unknown uuid", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			// Unknown uuid short-circuits to an empty string (no pair matched).
			expect(await world.worker.fetchIgnorerContent("not-this-pair")).toBe("")

			// After setting the ignorer content it round-trips through the physical .filenignore.
			await world.worker.updateIgnorerContent(uuid, "node_modules\n*.log")
			expect(await world.worker.fetchIgnorerContent(uuid)).toBe("node_modules\n*.log")
		})
	})

	it("updatePaused pauses and resumes each registered per-transfer signal, skipping ones already in the target state", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid
			const running = new PauseSignal()
			const alreadyPaused = new PauseSignal()

			alreadyPaused.pause()

			world.sync.pauseSignals["upload:/running.txt"] = running
			world.sync.pauseSignals["upload:/already.txt"] = alreadyPaused

			// Pausing the pair pauses the running signal and leaves the already-paused one untouched.
			world.worker.updatePaused(uuid, true)

			expect(world.sync.paused).toBe(true)
			expect(running.isPaused()).toBe(true)
			expect(alreadyPaused.isPaused()).toBe(true)

			// Add a freshly-registered, still-running signal: the resume pass must resume the paused ones
			// and skip the running one.
			const stillRunning = new PauseSignal()

			world.sync.pauseSignals["download:/fresh.txt"] = stillRunning

			world.worker.updatePaused(uuid, false)

			expect(world.sync.paused).toBe(false)
			expect(running.isPaused()).toBe(false)
			expect(alreadyPaused.isPaused()).toBe(false)
			expect(stillRunning.isPaused()).toBe(false)
		})
	})

	it("updateRemoved with removed=false clears the removed flag without running cleanup", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			world.sync.removed = true

			const mark = world.messages.length

			await world.worker.updateRemoved(uuid, false)

			expect(world.sync.removed).toBe(false)
			// The removed=false branch does NOT call cleanup(), so no cycleExited is emitted.
			expect(world.messages.slice(mark).some(message => message.type === "cycleExited")).toBe(false)
		})
	})
})

describe("SyncWorker public API — unknown uuid / absent Sync no-ops", () => {
	it("resetCache and resetTaskErrors do nothing for an unknown uuid", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const cacheBefore = world.sync.localFileSystem.getDirectoryTreeCache
			const timestampBefore = world.sync.localFileSystem.lastDirectoryChangeTimestamp
			const taskErrorsBefore = world.sync.taskErrors

			world.worker.resetCache("not-this-pair")
			world.worker.resetTaskErrors("not-this-pair")

			// The mismatched-uuid branch `continue`s without touching any state (same references/values).
			expect(world.sync.localFileSystem.getDirectoryTreeCache).toBe(cacheBefore)
			expect(world.sync.localFileSystem.lastDirectoryChangeTimestamp).toBe(timestampBefore)
			expect(world.sync.taskErrors).toBe(taskErrorsBefore)
		})
	})

	it("update* controls leave the pair untouched when called with an unknown uuid", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const ignorePath = `${world.localPath}/.filenignore`

			expect(world.sync.paused).toBe(false)
			expect(world.sync.excludeDotFiles).toBe(false)
			expect(world.sync.mode).toBe("twoWay")
			expect(world.sync.deletionConfirmationResult).toBe("waiting")
			expect(world.vfs.controls.exists(ignorePath)).toBe(false)

			world.worker.updatePaused("not-this-pair", true)
			world.worker.updateExcludeDotFiles("not-this-pair", true)
			world.worker.updateMode("not-this-pair", "localBackup")
			world.worker.confirmDeletion("not-this-pair", "delete")
			await world.worker.updateIgnorerContent("not-this-pair", "secret")
			await world.worker.updateRemoved("not-this-pair", true)

			expect(world.sync.paused).toBe(false)
			expect(world.sync.excludeDotFiles).toBe(false)
			expect(world.sync.mode).toBe("twoWay")
			expect(world.sync.deletionConfirmationResult).toBe("waiting")
			expect(world.sync.removed).toBe(false)
			// updateIgnorerContent for an unknown uuid wrote nothing to the physical .filenignore.
			expect(world.vfs.controls.exists(ignorePath)).toBe(false)
		})
	})

	it("transfer controls are safe no-ops for unknown uuids and unknown transfer keys", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			// Unknown uuid: the per-sync lookup never matches, so nothing is registered.
			world.worker.stopTransfer("not-this-pair", "upload", "/a.txt")
			world.worker.pauseTransfer("not-this-pair", "upload", "/a.txt")
			world.worker.resumeTransfer("not-this-pair", "upload", "/a.txt")

			// Known uuid but a transfer key that was never registered: still a no-op, no controller or
			// signal is conjured into existence.
			world.worker.stopTransfer(uuid, "download", "/missing.txt")
			world.worker.resumeTransfer(uuid, "download", "/missing.txt")
			world.worker.pauseTransfer(uuid, "download", "/missing.txt")

			expect(world.sync.abortControllers["upload:/a.txt"]).toBeUndefined()
			expect(world.sync.abortControllers["download:/missing.txt"]).toBeUndefined()
			expect(world.sync.pauseSignals["upload:/a.txt"]).toBeUndefined()
			expect(world.sync.pauseSignals["download:/missing.txt"]).toBeUndefined()
		})
	})

	it("control methods skip a registered pair that has no active Sync instance", async () => {
		await withWorld({ mode: "twoWay" }, async world => {
			const uuid = world.syncPair.uuid

			// A pair present in `syncPairs` but with no instantiated Sync (e.g. before initialize() or after
			// a teardown): the `!sync` guard must skip it safely rather than dereferencing undefined.
			Reflect.deleteProperty(world.worker.syncs, uuid)

			expect(() => {
				world.worker.resetCache(uuid)
				world.worker.resetTaskErrors(uuid)
				world.worker.resetLocalTreeErrors(uuid)
				world.worker.toggleLocalTrash(uuid, true)
			}).not.toThrow()

			// None of the calls recreated a Sync for the pair.
			expect(world.worker.syncs[uuid]).toBeUndefined()
		})
	})
})

describe("utils — promiseAllChunked", () => {
	it("withResults=true returns the fulfilled values in order across a chunk boundary", async () => {
		const promises = [1, 2, 3, 4, 5].map(n => Promise.resolve(n * 10))

		// chunkSize=2 < 5 forces multiple chunks; the concatenated result preserves input order.
		const result = await promiseAllChunked(promises, 2, true)

		expect(result).toEqual([10, 20, 30, 40, 50])
	})

	it("withResults=false awaits every promise but resolves to an empty array", async () => {
		const order: number[] = []
		const make = (n: number): Promise<void> =>
			Promise.resolve().then(() => {
				order.push(n)
			})

		const result = await promiseAllChunked([make(1), make(2), make(3), make(4), make(5)], 2, false)

		expect(result).toEqual([])
		// Every promise still ran even though no results were collected.
		expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
	})
})

describe("utils — promiseAllSettledChunked", () => {
	it("withResults=true keeps fulfilled values in order and swallows rejections in the reducer", async () => {
		const promises = [
			Promise.resolve("a"),
			Promise.reject(new Error("nope")),
			Promise.resolve("b"),
			Promise.reject(new Error("nope2")),
			Promise.resolve("c")
		]

		const result = await promiseAllSettledChunked(promises, 2, true)

		// Rejections are dropped by the reduce; only fulfilled values survive, in order.
		expect(result).toEqual(["a", "b", "c"])
	})

	it("withResults=false awaits all settlements but resolves to an empty array", async () => {
		const order: number[] = []
		const make = (n: number): Promise<number> =>
			Promise.resolve().then(() => {
				order.push(n)

				return n
			})

		const result = await promiseAllSettledChunked([make(1), make(2), make(3)], 2, false)

		expect(result).toEqual([])
		expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3])
	})
})

describe("utils — isPathSyncedByICloud / pathSyncedByICloud", () => {
	it("both resolve to false immediately on a non-darwin platform (no xattr exec, no dirname walk)", async () => {
		await withPlatformAsync("linux", async () => {
			expect(await pathSyncedByICloud("/home/me/Documents/file.txt")).toBe(false)
			// isPathSyncedByICloud returns at the platform guard, never entering the dirname-walk loop.
			expect(await isPathSyncedByICloud("/home/me/Documents/deeply/nested/file.txt")).toBe(false)
		})

		await withPlatformAsync("win32", async () => {
			expect(await pathSyncedByICloud("C:/Users/me/file.txt")).toBe(false)
			expect(await isPathSyncedByICloud("C:/Users/me/file.txt")).toBe(false)
		})
	})
})
