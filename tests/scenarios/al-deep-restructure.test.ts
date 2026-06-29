import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { renameLocal, rmLocal } from "../harness/mutations"

/**
 * Category AL — large structural restructures in one cycle (twoWay): flatten a deep tree to root,
 * deepen a flat tree, and relocate a whole subtree under a different parent. These exercise many
 * simultaneous directory + file renames and the collapse/rebase machinery at depth. Add-only.
 */
describe("Category AL — deep restructure", () => {
	it("AL1: flatten a deep tree — move every file up to the root, drop the empty dirs", async () => {
		const result = await runScenario({
			name: "AL1",
			mode: "twoWay",
			initialLocal: { "/local/a/b/c/deep.txt": "D", "/local/a/b/mid.txt": "M", "/local/a/top.txt": "T" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a/b/c/deep.txt", "deep.txt")
					renameLocal(world, "a/b/mid.txt", "mid.txt")
					renameLocal(world, "a/top.txt", "top.txt")
					rmLocal(world, "a")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/deep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/mid.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/top.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AL2: deepen a flat tree — move root files into a freshly-created nested path", async () => {
		const result = await runScenario({
			name: "AL2",
			mode: "twoWay",
			initialLocal: { "/local/x.txt": "X", "/local/y.txt": "Y" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "x.txt", "deep/nest/x.txt")
					renameLocal(world, "y.txt", "deep/nest/y.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/deep/nest/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/deep/nest/y.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/y.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AL3: relocate an entire subtree under a different parent", async () => {
		const result = await runScenario({
			name: "AL3",
			mode: "twoWay",
			initialLocal: {
				"/local/src/sub/a.txt": "A",
				"/local/src/sub/deeper/b.txt": "B",
				"/local/src/stay.txt": "s",
				"/local/dst/.keep": "k"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "src/sub", "dst/sub")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dst/sub/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dst/sub/deeper/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/src/stay.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/src/sub"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
