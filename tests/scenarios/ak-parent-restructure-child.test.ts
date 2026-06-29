import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, rmLocal, writeLocal } from "../harness/mutations"

/**
 * Category AK — parent-directory restructure combined with a child op in the SAME cycle (twoWay). A
 * directory rename relocates its whole subtree; doing a child rename / delete / add at the same time
 * stresses collapseDeltas (is the child op redundant with the parent rename or independent?) and the
 * rename-aware rebase. Also covers conflicting directory renames on the two sides. Add-only.
 */
describe("Category AK — parent restructure + child op", () => {
	it("AK1: rename a directory AND move a child OUT of it in one cycle — child escapes, rest follows", async () => {
		const result = await runScenario({
			name: "AK1",
			mode: "twoWay",
			initialLocal: { "/local/dir/x.txt": "x", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "dir", "dir2")
					renameLocal(world, "dir2/x.txt", "y.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		// keep.txt rides the parent rename into dir2; x.txt independently escapes to /y.txt.
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/y.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AK2: rename a directory AND delete a child in one cycle — rename applies, child stays deleted", async () => {
		const result = await runScenario({
			name: "AK2",
			mode: "twoWay",
			initialLocal: { "/local/dir/x.txt": "x", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "dir", "dir2")
					rmLocal(world, "dir2/x.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AK3: rename a directory AND add a new child in one cycle — both rename and add land", async () => {
		const result = await runScenario({
			name: "AK3",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "dir", "dir2")
					writeLocal(world, "dir2/new.txt", "n")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AK4: both sides rename the same directory to DIFFERENT names — converges, no child loss", async () => {
		const result = await runScenario({
			name: "AK4",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "a", "/local/dir/b.txt": "b" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dirLocal")),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dirRemote")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Conflicting directory renames must converge with no child lost — the children exist under
		// whatever name(s) survive, identically on both sides.
		expect(result.finalLocal).toEqual(result.finalRemote)
		const files = Object.entries(result.finalRemote).filter(([, v]) => v.type === "file")
		// Both children survive (possibly under one or both directory names), never zero.
		expect(files.length).toBeGreaterThanOrEqual(2)
	})
})
