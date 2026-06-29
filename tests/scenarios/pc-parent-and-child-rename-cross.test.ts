import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal } from "../harness/mutations"

/**
 * Category PC — a COMPOUND rename where one side renames a directory AND one of its children in the same
 * cycle, while the OTHER side renames a DIFFERENT child of that directory. R pins parent+child renames on a
 * single side; ZW pins a parent rename vs a cross-side child rename of the SAME child. The untested shape:
 * three renames at once — parent + child-A on one side, child-B on the other — so the rename-aware rebase
 * and collapseDeltas must compose the parent move with BOTH leaf renames and land each child at the union
 * of the renames that touched it. Must converge to /P/a2 + /P/b2 with no stale paths or duplication.
 */
describe("Category PC — parent rename + own-child rename racing a cross-side sibling rename", () => {
	it("PC1: local renames parent + child-a, remote renames child-b → both leaf renames land under the renamed parent", async () => {
		const result = await runScenario({
			name: "PC1",
			mode: "twoWay",
			initialLocal: { "/local/p/a.txt": "AAA", "/local/p/b.txt": "BBB" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "p", "P")
					renameLocal(world, "P/a.txt", "P/a2.txt")
				}),
				remoteMutate(world => world.cloud.controls.movePath("/p/b.txt", "/p/b2.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/P/a2.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalRemote["/P/b2.txt"]).toMatchObject({ type: "file", size: "BBB".length })
		expect(result.finalRemote["/P/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/P/b.txt"]).toBeUndefined()
		expect(result.finalRemote["/p"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/P/a2.txt"]!.contentHash).toBe(result.finalRemote["/P/a2.txt"]!.contentHash)
		expect(result.finalLocal["/P/b2.txt"]!.contentHash).toBe(result.finalRemote["/P/b2.txt"]!.contentHash)
	})

	it("PC2: remote renames parent + child-a, local renames child-b → both leaf renames land (symmetric)", async () => {
		const result = await runScenario({
			name: "PC2",
			mode: "twoWay",
			initialLocal: { "/local/p/a.txt": "AAA", "/local/p/b.txt": "BBB" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.movePath("/p", "/Premote")
					world.cloud.controls.movePath("/Premote/a.txt", "/Premote/a2.txt")
				}),
				localMutate(world => renameLocal(world, "p/b.txt", "p/b2.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/Premote/a2.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalRemote["/Premote/b2.txt"]).toMatchObject({ type: "file", size: "BBB".length })
		expect(result.finalRemote["/Premote/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/Premote/b.txt"]).toBeUndefined()
		expect(result.finalRemote["/p"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("PC3: parent rename + child-DIR rename racing a cross-side sibling-DIR rename → converges", async () => {
		const result = await runScenario({
			name: "PC3",
			mode: "twoWay",
			initialLocal: { "/local/p/a/x.txt": "AX", "/local/p/b/y.txt": "BY" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "p", "P")
					renameLocal(world, "P/a", "P/a2")
				}),
				remoteMutate(world => world.cloud.controls.movePath("/p/b", "/p/b2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/P/a2/x.txt"]).toMatchObject({ type: "file", size: "AX".length })
		expect(result.finalRemote["/P/b2/y.txt"]).toMatchObject({ type: "file", size: "BY".length })
		expect(result.finalRemote["/P/a/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/P/b/y.txt"]).toBeUndefined()
		expect(result.finalRemote["/p"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
