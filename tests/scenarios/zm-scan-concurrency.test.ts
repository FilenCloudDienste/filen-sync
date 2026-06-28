import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createWorld, BASE_TIME, LOCAL_ROOT } from "../harness/world"
import { LOCAL_SCAN_CONCURRENCY } from "../../src/lib/filesystems/local"

/**
 * Category ZM — the local tree scan must bound how many filesystem stat operations it launches at once.
 *
 * getDirectoryTree() fans an `lstat` (+ `access`) out over every glob entry. The walk used to map ALL
 * entries to promises in one go — `entries.map(async …)` eagerly invokes every async body, so a tree
 * with N entries allocated N pending promises and N in-flight stat results simultaneously. The chunk
 * size handed to the awaiting helper only batched the AWAIT, never the launch, so peak concurrency (and
 * peak memory) was unbounded — O(N) on top of the unavoidable result tree, with matching pressure on the
 * libuv thread pool and open file descriptors. Walking the entries in fixed-size batches caps the
 * in-flight fan-out at LOCAL_SCAN_CONCURRENCY.
 *
 * The peak is measured by wrapping the per-entry `lstat`: the scan routes those through environment.fs,
 * whereas FastGlob's own traversal uses the separate globFs adapter — so the wrapper observes ONLY the
 * fan-out. Because each async body runs synchronously up to its first `await`, every body in a batch
 * increments the in-flight counter before any stat resolves, so the observed peak equals the batch size
 * deterministically, with no reliance on timing.
 */
describe("Category ZM — the local scan bounds concurrent stat operations", () => {
	beforeEach(() => {
		// Match the scenario harness: fake only the engine's timers + clock, leaving microtasks/setImmediate
		// real so FastGlob's async traversal drains while the clock is frozen.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		vi.setSystemTime(BASE_TIME)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("ZM1: getDirectoryTree never launches more than LOCAL_SCAN_CONCURRENCY lstat operations at once", async () => {
		// Comfortably more entries than the bound, and not a round multiple of it, so the buggy unbounded
		// fan-out (peak = fileCount) is clearly distinguishable from the bounded one (peak = the bound).
		const fileCount = LOCAL_SCAN_CONCURRENCY * 2 + 137
		const initialLocal: Record<string, string> = {}

		for (let i = 0; i < fileCount; i++) {
			initialLocal[`${LOCAL_ROOT}/f${i}.txt`] = "x"
		}

		const world = await createWorld({ mode: "twoWay", initialLocal })

		// Wrap the per-entry lstat to record peak concurrent in-flight calls. environment.fs IS world.vfs.fs,
		// and the scan calls it once per entry; FastGlob's walk uses globFs, so this counts only the fan-out.
		const realLstat = world.vfs.fs.lstat.bind(world.vfs.fs)
		let inFlight = 0
		let maxInFlight = 0

		const countingLstat = (async (path: string) => {
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)

			try {
				return await realLstat(path)
			} finally {
				inFlight--
			}
		}) as typeof world.vfs.fs.lstat

		// SyncFS declares lstat readonly; swap in the counting wrapper through a mutable view (the underlying
		// memfs object is a plain mutable JS object — the readonly is only a compile-time annotation).
		;(world.vfs.fs as { lstat: typeof world.vfs.fs.lstat }).lstat = countingLstat

		const tree = await world.sync.localFileSystem.getDirectoryTree()

		// Sanity: the scan visited every file (otherwise a no-op scan would trivially satisfy the bound).
		expect(tree.result.size).toBe(fileCount)
		// The fix: peak in-flight stat operations are capped at the bound. The buggy fan-out peaked at
		// fileCount (every entry launched at once), so it fails this both as "> bound" and "≠ bound".
		expect(
			maxInFlight,
			`scan should cap concurrent lstat fan-out at ${LOCAL_SCAN_CONCURRENCY}, but ${maxInFlight} of ${fileCount} entries were in flight at once`
		).toBe(LOCAL_SCAN_CONCURRENCY)
	})
})
