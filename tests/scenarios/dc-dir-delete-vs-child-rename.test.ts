import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, rmLocal } from "../harness/mutations"

/**
 * Category DC — one side DELETES a directory while the other RENAMES/MOVES a child of it in the same cycle.
 * AG/ZH pin dir-delete vs a child ADD or MODIFY; this pins dir-delete vs a child RENAME, which routes
 * through a different seam: directoriesWithSurvivingChildren must treat the rename's NEW in-dir path as
 * live content that keeps the directory alive (the renamed child is "newer data" beating the delete), while
 * a child renamed OUT of the directory does NOT keep it alive (it left). The cross-side rename itself cannot
 * propagate as a server-side rename (its source vanished under the delete) and degrades to a re-create at
 * the surviving path. Every case must converge with the child's content intact.
 */
describe("Category DC — dir delete vs cross-side child rename/move", () => {
	it("DC1: local DELETES /d while remote renames child /d/a.txt→/d/b.txt (in place) → /d survives with the renamed child", async () => {
		const result = await runScenario({
			name: "DC1",
			mode: "twoWay",
			initialLocal: { "/local/d/a.txt": "CONTENT-A", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "d")),
				remoteMutate(world => world.cloud.controls.movePath("/d/a.txt", "/d/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Newer data (the renamed child) beats the directory delete: /d comes back holding b.txt.
		expect(result.finalRemote["/d/b.txt"]).toMatchObject({ type: "file", size: "CONTENT-A".length })
		expect(result.finalRemote["/d/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/d/b.txt"]!.contentHash).toBe(result.finalRemote["/d/b.txt"]!.contentHash)
	})

	it("DC2: remote DELETES /d while local renames child /d/a.txt→/d/b.txt (in place) → /d survives (symmetric)", async () => {
		const result = await runScenario({
			name: "DC2",
			mode: "twoWay",
			initialLocal: { "/local/d/a.txt": "CONTENT-A", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/d")),
				localMutate(world => renameLocal(world, "d/a.txt", "d/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/d/b.txt"]).toMatchObject({ type: "file", size: "CONTENT-A".length })
		expect(result.finalRemote["/d/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("DC3: local DELETES /d while remote MOVES the child into a new subdir /d/sub/b.txt → /d and the subtree survive", async () => {
		const result = await runScenario({
			name: "DC3",
			mode: "twoWay",
			initialLocal: { "/local/d/a.txt": "CONTENT-A", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "d")),
				remoteMutate(world => world.cloud.controls.movePath("/d/a.txt", "/d/sub/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/d/sub/b.txt"]).toMatchObject({ type: "file", size: "CONTENT-A".length })
		expect(result.finalRemote["/d/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("DC4: local DELETES /d while remote moves the child OUT to /escaped.txt → the child escapes, /d is deleted", async () => {
		const result = await runScenario({
			name: "DC4",
			mode: "twoWay",
			initialLocal: { "/local/d/a.txt": "CONTENT-A", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "d")),
				remoteMutate(world => world.cloud.controls.movePath("/d/a.txt", "/escaped.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The child left /d before the delete could take it, so it survives at the new path; /d (now empty
		// and deleted locally) does not come back.
		expect(result.finalRemote["/escaped.txt"]).toMatchObject({ type: "file", size: "CONTENT-A".length })
		expect(result.finalRemote["/d"]).toBeUndefined()
		expect(result.finalRemote["/d/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/escaped.txt"]!.contentHash).toBe(result.finalRemote["/escaped.txt"]!.contentHash)
	})
})
