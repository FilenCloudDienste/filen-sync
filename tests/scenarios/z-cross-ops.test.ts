import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferOps } from "../harness/snapshot"
import { writeLocal, writeLocalAt, mkdirLocal, rmLocal, renameLocal, readLocal } from "../harness/mutations"

/**
 * Category Z — multiple operations composed in a SINGLE cycle (twoWay). These stress the phase-ordered
 * runner and the rename/collapse/modify interplay together (the area that hid F1). Every case must reach
 * a fixed point with the data intact. Distinct from Category E/R (rename mechanics), P (cross-dir moves),
 * K (bulk), and Y (cross-side conflicts): here several DIFFERENT op types land in one beat on one side.
 */
const SECOND = 1000

describe("Category Z — multi-op compositions in one cycle (twoWay)", () => {
	it("Z1: move a file OUT of a directory and delete that directory in one cycle", async () => {
		const result = await runScenario({
			name: "Z1",
			mode: "twoWay",
			initialLocal: { "/local/dir/f.txt": "keepme", "/local/dir/other.txt": "other" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "dir/f.txt", "f.txt")
					rmLocal(world, "dir")
				}),
				runCycle(),
				runCycle()
			]
		})

		// The moved-out file survives at the root; the directory (and its remaining child) are gone.
		expect(result.finalRemote["/f.txt"]).toMatchObject({ type: "file", size: "keepme".length })
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir/other.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z2: rename a directory AND modify a child within it in one cycle (child's new content propagates)", async () => {
		const result = await runScenario({
			name: "Z2",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old", "/local/dir/sibling.txt": "sib" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "dir", "dir2")
					writeLocalAt(world, "dir2/child.txt", "NEW-CONTENT-LONGER", BASE_TIME + 5 * SECOND)
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir2/child.txt"]).toMatchObject({ type: "file", size: "NEW-CONTENT-LONGER".length })
		expect(result.finalRemote["/dir2/sibling.txt"]).toMatchObject({ type: "file", size: "sib".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z3: move a subtree into another directory AND modify a file within the moved subtree", async () => {
		const result = await runScenario({
			name: "Z3",
			mode: "twoWay",
			initialLocal: { "/local/src/deep/data.txt": "old", "/local/dest/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "src", "dest/src")
					writeLocalAt(world, "dest/src/deep/data.txt", "MOVED-AND-CHANGED", BASE_TIME + 5 * SECOND)
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/src"]).toBeUndefined()
		expect(result.finalRemote["/dest/src/deep/data.txt"]).toMatchObject({ type: "file", size: "MOVED-AND-CHANGED".length })
		expect(result.finalRemote["/dest/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z4: rename a directory AND add a brand-new file into the renamed directory in one cycle", async () => {
		const result = await runScenario({
			name: "Z4",
			mode: "twoWay",
			initialLocal: { "/local/dir/existing.txt": "e" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "dir", "dir2")
					writeLocal(world, "dir2/fresh.txt", "fresh")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir2/existing.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/fresh.txt"]).toMatchObject({ type: "file", size: "fresh".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z5: swap two directory names (a↔b) via a temp in one cycle", async () => {
		const result = await runScenario({
			name: "Z5",
			mode: "twoWay",
			initialLocal: { "/local/a/fa.txt": "AAA", "/local/b/fb.txt": "BBB" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a", "tmp")
					renameLocal(world, "b", "a")
					renameLocal(world, "tmp", "b")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// a now holds B's content, b holds A's content.
		expect(result.finalRemote["/a/fb.txt"]).toMatchObject({ type: "file", size: "BBB".length })
		expect(result.finalRemote["/b/fa.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z6: cross-directory move AND content modify of the same file in one cycle", async () => {
		const result = await runScenario({
			name: "Z6",
			mode: "twoWay",
			initialLocal: { "/local/from/f.txt": "original", "/local/to/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "from/f.txt", "to/f.txt")
					writeLocalAt(world, "to/f.txt", "MOVED-CONTENT", BASE_TIME + 5 * SECOND)
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/from/f.txt"]).toBeUndefined()
		expect(result.finalRemote["/to/f.txt"]).toMatchObject({ type: "file", size: "MOVED-CONTENT".length })
		expect(readLocal(result.world, "to/f.txt")).toBe("MOVED-CONTENT")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z7: delete one file, rename another, and add a third — all in one cycle", async () => {
		const result = await runScenario({
			name: "Z7",
			mode: "twoWay",
			initialLocal: { "/local/del.txt": "d", "/local/ren.txt": "r" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "del.txt")
					renameLocal(world, "ren.txt", "renamed.txt")
					writeLocal(world, "added.txt", "a")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/del.txt"]).toBeUndefined()
		expect(result.finalRemote["/ren.txt"]).toBeUndefined()
		expect(result.finalRemote["/renamed.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/added.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z8: create a directory and move an existing file into it in one cycle", async () => {
		const result = await runScenario({
			name: "Z8",
			mode: "twoWay",
			initialLocal: { "/local/f.txt": "data" },
			steps: [
				runCycle(),
				localMutate(world => {
					mkdirLocal(world, "newdir")
					renameLocal(world, "f.txt", "newdir/f.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/newdir"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/newdir/f.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/f.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z9: a rename round-trip across cycles (a→b→a) ends as an identity no-op", async () => {
		let uuidBefore: string | undefined

		const result = await runScenario({
			name: "Z9",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "data" },
			steps: [
				runCycle(),
				localMutate(world => {
					uuidBefore = world.cloud.controls.getByPath("/a.txt")?.uuid
					renameLocal(world, "a.txt", "b.txt")
				}),
				runCycle(),
				localMutate(world => renameLocal(world, "b.txt", "a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "data".length })
		expect(result.finalRemote["/b.txt"]).toBeUndefined()
		// Identity preserved through the round trip (no re-upload, same remote node).
		expect(result.world.cloud.controls.getByPath("/a.txt")?.uuid).toBe(uuidBefore)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("Z10: modify a file and rename its parent directory in one cycle", async () => {
		const result = await runScenario({
			name: "Z10",
			mode: "twoWay",
			initialLocal: { "/local/parent/data.txt": "old", "/local/parent/static.txt": "s" },
			steps: [
				runCycle(),
				localMutate(world => {
					writeLocalAt(world, "parent/data.txt", "EDITED-IN-PLACE", BASE_TIME + 5 * SECOND)
					renameLocal(world, "parent", "parent-renamed")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/parent"]).toBeUndefined()
		expect(result.finalRemote["/parent-renamed/data.txt"]).toMatchObject({ type: "file", size: "EDITED-IN-PLACE".length })
		expect(result.finalRemote["/parent-renamed/static.txt"]).toMatchObject({ type: "file" })
		expect(readLocal(result.world, "parent-renamed/data.txt")).toBe("EDITED-IN-PLACE")
		expect(result.finalLocal).toEqual(result.finalRemote)
		// Settled.
		expect(transferOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("Z11: a deep mixed batch (adds, a delete, a move, a modify) converges and is idempotent", async () => {
		const result = await runScenario({
			name: "Z11",
			mode: "twoWay",
			initialLocal: {
				"/local/keep/a.txt": "a",
				"/local/keep/b.txt": "b",
				"/local/gone/x.txt": "x",
				"/local/move-me.txt": "m"
			},
			steps: [
				runCycle(),
				localMutate(world => {
					writeLocal(world, "keep/c.txt", "c")
					writeLocalAt(world, "keep/a.txt", "a-edited", BASE_TIME + 5 * SECOND)
					rmLocal(world, "gone")
					renameLocal(world, "move-me.txt", "keep/move-me.txt")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/keep/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep/a.txt"]).toMatchObject({ type: "file", size: "a-edited".length })
		expect(result.finalRemote["/gone"]).toBeUndefined()
		expect(result.finalRemote["/keep/move-me.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/move-me.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(transferOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
