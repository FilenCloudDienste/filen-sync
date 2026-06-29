import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { renameLocal, writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category AS — type swaps across two paths and vacate-and-fill rename chains (twoWay). A file and a
 * directory exchanging names is simultaneously two type changes AND a swap; a 2-link chain (a→b, c→a)
 * reuses a path that another file is moving out of. These stress the occupied-target rename guard
 * against cross-type targets and partially-freed paths. Add-only.
 */
describe("Category AS — type swaps + rename chains", () => {
	it("AS1: a file and a non-empty directory swap names", async () => {
		const result = await runScenario({
			name: "AS1",
			mode: "twoWay",
			initialLocal: { "/local/a": "i am file a", "/local/b/child.txt": "child of b" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a", "tmp") // file a -> tmp
					renameLocal(world, "b", "a") // dir b -> a (carries child.txt to /a/child.txt)
					renameLocal(world, "tmp", "b") // file -> b
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// /a is now the directory (holding child.txt); /b is now the file.
		expect(result.finalRemote["/a"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/a/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AS2: a file and an empty directory swap names", async () => {
		const result = await runScenario({
			name: "AS2",
			mode: "twoWay",
			initialLocal: { "/local/f": "i am the file", "/local/d/.keep": "k" },
			steps: [
				runCycle(),
				// Remove the placeholder so d is a genuinely empty directory before the swap.
				localMutate(world => renameLocal(world, "d/.keep", ".keep")),
				runCycle(),
				localMutate(world => {
					renameLocal(world, "f", "tmp")
					renameLocal(world, "d", "f") // empty dir d -> f
					renameLocal(world, "tmp", "d") // file -> d
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/f"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/d"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AS3: a vacate-and-fill chain (a→b, then c→a) converges", async () => {
		const result = await runScenario({
			name: "AS3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "AAA", "/local/c.txt": "CCC" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "b.txt") // a vacates its path
					renameLocal(world, "c.txt", "a.txt") // c fills the freed path
				}),
				runCycle(),
				runCycle()
			]
		})

		// /a.txt now holds c's content, /b.txt holds a's content, /c.txt is gone.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/c.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		const hashes = new Set([result.finalRemote["/a.txt"]!.contentHash, result.finalRemote["/b.txt"]!.contentHash])
		expect(hashes.size).toBe(2)
	})

	it("AS4: a file replaced by a directory of the same name while a new file takes the old spot elsewhere", async () => {
		const result = await runScenario({
			name: "AS4",
			mode: "twoWay",
			initialLocal: { "/local/x": "i am a file" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "x", "y.txt") // the file moves to y.txt
					writeLocal(world, "x/inner.txt", "x is now a directory") // x becomes a directory
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/x/inner.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/y.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// AS5 — the DEEP variant: a file becomes a directory holding a brand-new subdirectory into which an
	// existing (inode-preserved) file is moved. The moved child's destination cannot be reached while the
	// type-changing file still occupies an ancestor; the rename detector's ancestor check suppresses the
	// move so the addition pass rebuilds the child under the freshly-created directory. (The live e2e
	// counterpart `edge-extra.e2e.test.ts` AS5 is the authoritative regression — the real backend's task
	// ordering loses the child without the fix, which this synchronous mock cannot reproduce; this keeps
	// the scenario covered in the fast suite.)
	it("AS5: a file becomes a directory with a NEW subdir holding a MOVED child", async () => {
		const result = await runScenario({
			name: "AS5",
			mode: "twoWay",
			initialLocal: { "/local/a": "i am a file", "/local/old/child.txt": "moved child" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "a")
					renameLocal(world, "old/child.txt", "a/sub/child.txt")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/a/sub/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/old/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
