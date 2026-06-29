import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control, restart } from "../harness/runner"
import { renameLocal } from "../harness/mutations"

/**
 * Category ZP — partial (non-atomic) remote rename+move faults.
 *
 * A cross-parent move that ALSO renames the basename is NOT one SDK call in the engine: remote.rename()
 * issues `renameFile`/`renameDirectory` FIRST, then `moveFile`/`moveDirectory` (remote.ts). A fault landing
 * BETWEEN those two calls leaves the item renamed-but-not-moved on the real backend, while the engine's
 * in-memory tree-cache update (which runs only AFTER both calls succeed) never happens.
 *
 * Recovery model: a cycle that ends with task errors does NOT commit state; the engine reports
 * `cycleRestarting` and the worker rebuilds the Sync, reloading the LAST GOOD base (here the pre-move
 * state) from disk and re-fetching both trees — modelled here by a `restart()` after the fault clears.
 * After that restart the half-applied, engine-INITIATED rename is indistinguishable from an EXTERNAL
 * remote rename and races the still-pending local move of the SAME identity → without a fix the conflict
 * resolver keeps both → a DUPLICATE the user never created.
 *
 * The engine must make a rename+move atomic-on-failure: if the move-half fails after the rename-half
 * committed, roll the rename back so the backend returns to its pre-task path; the retry then sees a clean
 * one-sided move and converges to the single intended destination. The fix lives entirely in the sync
 * engine (remote.ts error path), uses only existing SDK calls, and never runs on the success/hot path.
 * add-only; never edits existing tests.
 */
describe("Category ZP — partial rename+move faults", () => {
	it("ZP1: a FILE move that faults after the rename-half converges to the destination (no duplicate)", async () => {
		const result = await runScenario({
			name: "ZP1",
			mode: "twoWay",
			initialLocal: { "/local/old/a.txt": "hello-zp1", "/local/dst/keep.txt": "keep" },
			steps: [
				runCycle(),
				// Fault ONLY the move-half; the preceding renameFile (a.txt -> b.txt in /old) commits.
				control(world => world.cloud.controls.setError("moveFile", new Error("injected move fault"))),
				localMutate(world => renameLocal(world, "old/a.txt", "dst/b.txt")),
				runCycle(),
				control(world => world.cloud.controls.clearError("moveFile")),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The user's single intent — /old/a.txt becomes /dst/b.txt — must hold on both sides, with NO
		// duplicate at the renamed-but-not-moved half-way path (/old/b.txt) and nothing left at the source.
		expect(result.finalLocal["/dst/b.txt"]).toMatchObject({ type: "file", size: "hello-zp1".length })
		expect(result.finalRemote["/dst/b.txt"]).toMatchObject({ type: "file", size: "hello-zp1".length })
		expect(result.finalLocal["/old/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/old/b.txt"]).toBeUndefined()
		expect(result.finalRemote["/old/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/old/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZP2: a DIRECTORY move that faults after the rename-half converges (no duplicate subtree)", async () => {
		const result = await runScenario({
			name: "ZP2",
			mode: "twoWay",
			initialLocal: { "/local/old/sub/c.txt": "zp2-child", "/local/dst/keep.txt": "keep" },
			steps: [
				runCycle(),
				// Fault ONLY the directory move-half; renameDirectory (sub -> renamed) commits first.
				control(world => world.cloud.controls.setError("moveDirectory", new Error("injected dir move fault"))),
				localMutate(world => renameLocal(world, "old/sub", "dst/renamed")),
				runCycle(),
				control(world => world.cloud.controls.clearError("moveDirectory")),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The whole subtree must end up only at the destination, with no half-renamed copy left in /old.
		expect(result.finalLocal["/dst/renamed/c.txt"]).toMatchObject({ type: "file", size: "zp2-child".length })
		expect(result.finalRemote["/dst/renamed/c.txt"]).toMatchObject({ type: "file", size: "zp2-child".length })
		expect(result.finalLocal["/old/sub"]).toBeUndefined()
		expect(result.finalLocal["/old/renamed"]).toBeUndefined()
		expect(result.finalRemote["/old/sub"]).toBeUndefined()
		expect(result.finalRemote["/old/renamed"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZP3: a move to a NEW parent that faults after the rename-half converges (no duplicate)", async () => {
		const result = await runScenario({
			name: "ZP3",
			mode: "twoWay",
			// The destination parent /fresh does not exist yet, so the engine mkdir's it before moving.
			initialLocal: { "/local/old/a.txt": "hello-zp3" },
			steps: [
				runCycle(),
				control(world => world.cloud.controls.setError("moveFile", new Error("injected move fault"))),
				localMutate(world => renameLocal(world, "old/a.txt", "fresh/b.txt")),
				runCycle(),
				control(world => world.cloud.controls.clearError("moveFile")),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/fresh/b.txt"]).toMatchObject({ type: "file", size: "hello-zp3".length })
		expect(result.finalRemote["/fresh/b.txt"]).toMatchObject({ type: "file", size: "hello-zp3".length })
		expect(result.finalLocal["/old/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/old/b.txt"]).toBeUndefined()
		expect(result.finalRemote["/old/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZP4: a fault on the rename-half itself leaves nothing applied and retries cleanly", async () => {
		const result = await runScenario({
			name: "ZP4",
			mode: "twoWay",
			initialLocal: { "/local/old/a.txt": "hello-zp4", "/local/dst/keep.txt": "keep" },
			steps: [
				runCycle(),
				// The rename-half runs first; faulting it means NOTHING is applied — a clean all-or-nothing failure.
				control(world => world.cloud.controls.setError("renameFile", new Error("injected rename fault"))),
				localMutate(world => renameLocal(world, "old/a.txt", "dst/b.txt")),
				runCycle(),
				control(world => world.cloud.controls.clearError("renameFile")),
				restart(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/dst/b.txt"]).toMatchObject({ type: "file", size: "hello-zp4".length })
		expect(result.finalLocal["/old/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/old/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZP5: a PURE move (no rename) that faults is all-or-nothing and converges (no half-state)", async () => {
		const result = await runScenario({
			name: "ZP5",
			mode: "twoWay",
			// Same basename => only the move-half runs; a fault applies nothing, so the retry is clean.
			initialLocal: { "/local/old/a.txt": "hello-zp5", "/local/dst/keep.txt": "keep" },
			steps: [
				runCycle(),
				control(world => world.cloud.controls.setError("moveFile", new Error("injected move fault"))),
				localMutate(world => renameLocal(world, "old/a.txt", "dst/a.txt")),
				runCycle(),
				control(world => world.cloud.controls.clearError("moveFile")),
				restart(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/dst/a.txt"]).toMatchObject({ type: "file", size: "hello-zp5".length })
		expect(result.finalLocal["/old/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
