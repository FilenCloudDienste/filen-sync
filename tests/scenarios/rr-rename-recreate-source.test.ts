import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, writeLocal } from "../harness/mutations"

/**
 * Category RR — rename a path AWAY and re-create a brand-new item of the SAME type at the freed source
 * path, in the SAME cycle.
 *
 * The rename pass marks BOTH the new path and the OLD (source) path as "added" (pathsAdded) so the later
 * passes don't double-handle the moved identity. But a genuinely NEW file created at that old path in the
 * same cycle then collides with the source marker: the additions pass skips it on the rename cycle, so the
 * new file converges on a SUBSEQUENT cycle rather than the first. These pin that the new item is never LOST
 * — the moved content lands at the new name AND the fresh content lands at the reused old name, on both
 * sides. (AS4 covers the file→DIRECTORY type-swap at the freed path; this is the same-type recreate that
 * the source-marker interaction makes subtle.)
 */
describe("Category RR — rename away + recreate source path (same type)", () => {
	it("RR1: local renames a→b AND creates a new a (same path, new content) → both converge", async () => {
		const result = await runScenario({
			name: "RR1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "ORIGINAL-A" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "b.txt")
					writeLocal(world, "a.txt", "BRAND-NEW-A")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The moved content lands at b; the fresh content lands at the reused a — neither is lost.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "ORIGINAL-A".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "BRAND-NEW-A".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
		expect(result.finalLocal["/b.txt"]!.contentHash).toBe(result.finalRemote["/b.txt"]!.contentHash)
		// The two files really hold distinct content (no accidental aliasing of the moved bytes).
		expect(result.finalLocal["/a.txt"]!.contentHash).not.toBe(result.finalLocal["/b.txt"]!.contentHash)
	})

	it("RR2: remote renames a→b AND adds a new a (same path, new content) → both converge (symmetric)", async () => {
		const result = await runScenario({
			name: "RR2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "ORIGINAL-A" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.movePath("/a.txt", "/b.txt")
					world.cloud.controls.addFile("/a.txt", "BRAND-NEW-A")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file", size: "ORIGINAL-A".length })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "BRAND-NEW-A".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).not.toBe(result.finalLocal["/b.txt"]!.contentHash)
	})

	it("RR3: local renames a DIRECTORY a→b AND creates a new directory a (with a child) → both converge", async () => {
		const result = await runScenario({
			name: "RR3",
			mode: "twoWay",
			initialLocal: { "/local/a/orig.txt": "ORIG" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a", "b")
					writeLocal(world, "a/fresh.txt", "FRESH")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The moved directory's child lands under b; the fresh directory + child land under the reused a.
		expect(result.finalRemote["/b/orig.txt"]).toMatchObject({ type: "file", size: "ORIG".length })
		expect(result.finalRemote["/a/fresh.txt"]).toMatchObject({ type: "file", size: "FRESH".length })
		expect(result.finalRemote["/a/orig.txt"]).toBeUndefined()
		expect(result.finalRemote["/b/fresh.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("RR4: localToCloud — local renames a→b AND recreates a → the mirror reflects both", async () => {
		const result = await runScenario({
			name: "RR4",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "ORIGINAL-A" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "b.txt")
					writeLocal(world, "a.txt", "BRAND-NEW-A")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "ORIGINAL-A".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "BRAND-NEW-A".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
