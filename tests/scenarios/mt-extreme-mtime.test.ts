import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { writeLocalAt } from "../harness/mutations"

/**
 * Category MT — extreme mtime VALUES (far-future, epoch-zero). ZR pins whole-second rounding and ordinary
 * backward/forward dates; this pins that the engine stays ROBUST at the value extremes: it syncs, converges,
 * and — critically — does NOT enter a re-sync LOOP because a far-future or zero timestamp round-trips to a
 * different value (which would make every cycle re-detect a phantom change).
 *
 * The whole-second normalization (normalizeLastModifiedMsForComparison) is INTENTIONAL and load-bearing —
 * some filesystems (e.g. macOS) report float-imprecise FS timestamps that break a ms-precision comparator —
 * so these assert STABILITY at the extremes, never ms precision. Values are ms-magnitude (> 1e11) so the
 * SDK metadata seconds-vs-ms heuristic (convertTimestampToMs) treats them as already-ms and they round-trip.
 */
const YEAR_2200_MS = 7_258_118_400_000 // far future, unambiguously milliseconds

describe("Category MT — extreme mtime robustness", () => {
	it("MT1: a local file with a FAR-FUTURE mtime uploads, converges, and the next cycle is a no-op (no loop)", async () => {
		const result = await runScenario({
			name: "MT1",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "future.txt", "FUTURE", YEAR_2200_MS)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/future.txt"]).toMatchObject({ type: "file", size: "FUTURE".length })
		expect(result.finalLocal).toEqual(result.finalRemote)

		// Stability: the last cycle did no transfer (a far-future mtime must not be re-detected every cycle).
		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)

		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
	})

	it("MT2: a local file with an EPOCH-ZERO mtime uploads, converges, and the next cycle is a no-op", async () => {
		const result = await runScenario({
			name: "MT2",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "epoch.txt", "EPOCH", 0)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/epoch.txt"]).toMatchObject({ type: "file", size: "EPOCH".length })
		expect(result.finalLocal).toEqual(result.finalRemote)

		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)

		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
	})

	it("MT3: a FAR-FUTURE local modify beats a normal-time remote modify (newer-mtime conflict resolution)", async () => {
		const result = await runScenario({
			name: "MT3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "orig" },
			steps: [
				runCycle(),
				// Local edits with a far-future timestamp; remote edits with an ordinary (older) timestamp.
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-FUTURE-WINS", YEAR_2200_MS)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "remote-now", { mtimeMs: 1_700_000_000_000 })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The far-future local edit is the strictly-newer side and wins on both.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-FUTURE-WINS".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("MT4: a REMOTE file with a FAR-FUTURE lastModified downloads, converges, and the next cycle is a no-op", async () => {
		const result = await runScenario({
			name: "MT4",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.addFile("/remote-future.txt", "RF", { mtimeMs: YEAR_2200_MS })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/remote-future.txt"]).toMatchObject({ type: "file", size: "RF".length })
		expect(result.finalLocal).toEqual(result.finalRemote)

		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)

		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
	})
})
