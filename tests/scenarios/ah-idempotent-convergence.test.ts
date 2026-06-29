import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { writeLocal, rmLocal, renameLocal } from "../harness/mutations"

/**
 * Category AH — idempotent convergence when BOTH sides independently make the SAME change in one cycle
 * (twoWay). The correct outcome is the shared result with no duplication, no spurious conflict copy,
 * and — once settled — no further transfers. Add-only.
 */
describe("Category AH — both-sides-identical convergence", () => {
	it("AH1: both sides create the same file with identical content — converges, no duplication", async () => {
		const result = await runScenario({
			name: "AH1",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "a.txt", "same-content")),
				remoteMutate(world => world.cloud.controls.addFile("/a.txt", "same-content")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		// No conflict-copy was spawned: exactly one entry at the root.
		expect(Object.keys(result.finalRemote)).toEqual(["/a.txt"])
	})

	it("AH2: both sides modify a file to the SAME new content — converges with that content", async () => {
		const result = await runScenario({
			name: "AH2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "a.txt", "converged-edit")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "converged-edit")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
		expect(Object.keys(result.finalRemote)).toEqual(["/a.txt"])
	})

	it("AH3: both sides delete the same file — converges to empty, no error", async () => {
		const result = await runScenario({
			name: "AH3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "x", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AH4: both sides rename the same file to the same target — converges, no duplication", async () => {
		const result = await runScenario({
			name: "AH4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "content" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(Object.keys(result.finalRemote)).toEqual(["/b.txt"])
	})

	it("AH5: both sides create the same nested directory tree — converges, settles to no transfers", async () => {
		const result = await runScenario({
			name: "AH5",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				localMutate(world => {
					writeLocal(world, "tree/sub/x.txt", "X")
					writeLocal(world, "tree/sub/y.txt", "Y")
				}),
				remoteMutate(world => {
					world.cloud.controls.addFile("/tree/sub/x.txt", "X")
					world.cloud.controls.addFile("/tree/sub/y.txt", "Y")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/tree/sub/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/tree/sub/y.txt"]).toMatchObject({ type: "file" })
		// Settled: the last cycle does no work.
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
