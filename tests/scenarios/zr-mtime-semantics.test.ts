import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, allOps } from "../harness/snapshot"
import { writeLocalAt, touchLocal, readLocal } from "../harness/mutations"

/**
 * Category ZR — mtime semantics & clock robustness.
 *
 * Local change is attributed by `size OR whole-second mtime !== base` (deltas.ts). The `!==` (not `>`) is
 * load-bearing: a restore-from-backup or a `touch -t` can move an mtime BACKWARDS while content changes,
 * and a `>`-based check would silently drop that edit. These tests pin that semantic, plus the no-churn
 * guarantee for a backwards touch with identical content, future-dated mtimes, and the fact that REMOTE
 * change detection is uuid-based (time-independent) so an older remote lastModified still pulls. add-only.
 */
const SECOND = 1000

describe("Category ZR — mtime semantics & clock robustness", () => {
	it("ZR1: a same-size content edit with an OLDER mtime still uploads (guards !== over >)", async () => {
		const result = await runScenario({
			name: "ZR1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "AAAAAAAA" }, // size 8, base mtime = BASE_TIME
			steps: [
				runCycle(),
				// Same size (8), different content, mtime moved 5s into the PAST (restore-from-backup shape).
				localMutate(world => writeLocalAt(world, "a.txt", "BBBBBBBB", BASE_TIME - 5 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		// The backwards-dated edit must be detected and pushed — not silently ignored.
		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(readLocal(result.world, "a.txt")).toBe("BBBBBBBB")
		expect(result.finalRemote["/a.txt"]!.contentHash).toBe(result.finalLocal["/a.txt"]!.contentHash)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZR2: a backwards touch with identical content does NOT upload and stays stable (no churn)", async () => {
		const result = await runScenario({
			name: "ZR2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "same-content" },
			steps: [
				runCycle(),
				// Move mtime into the past WITHOUT changing content: the md5 guard must suppress the upload.
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME - 10 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		// No transfer in either post-touch cycle — and crucially no churn loop across cycles.
		expect(allOps(result.cycles[1]!.messages)).toEqual([])
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("ZR3: a future-dated mtime content edit syncs correctly (clock-skew robustness)", async () => {
		const result = await runScenario({
			name: "ZR3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "now" },
			steps: [
				runCycle(),
				// mtime a year in the FUTURE (a skewed clock on another machine) with new content.
				localMutate(world => writeLocalAt(world, "a.txt", "future-edit", BASE_TIME + 365 * 24 * 3600 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "future-edit".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZR4: a remote re-upload with an OLDER lastModified still downloads (remote detection is uuid-based)", async () => {
		const result = await runScenario({
			name: "ZR4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				// New uuid (genuine remote change) but an OLDER timestamp than the local copy. The engine keys
				// remote change off the uuid, not the time, so this must still pull down.
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "v2-older-stamp", { mtimeMs: BASE_TIME - 60 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("download")
		expect(readLocal(result.world, "a.txt")).toBe("v2-older-stamp")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
