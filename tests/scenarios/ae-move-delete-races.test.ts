import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { rmLocal, renameLocal } from "../harness/mutations"

/**
 * Category AE — move/delete races (twoWay). Cross-side interactions between a local move/rename and a
 * remote delete/move of the same subtree in ONE cycle. These probe the rename-propagation guards
 * (skip-if-other-side-changed) + the dir-delete-vs-surviving-child rule + path reuse, for silent data
 * loss or non-convergence. Add-only; never edits existing tests.
 */
describe("Category AE — move/delete races", () => {
	it("AE1: local move INTO a directory the remote deletes in the same cycle keeps the moved file", async () => {
		const result = await runScenario({
			name: "AE1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "content-a", "/local/target/keep.txt": "keep" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "target/a.txt")),
				remoteMutate(world => world.cloud.controls.trashPath("/target")),
				runCycle(),
				runCycle()
			]
		})

		// The freshly-moved-in child must survive (newer content beats the directory delete); the directory
		// is re-asserted to hold it, while the unmodified sibling the remote deleted is gone.
		expect(result.finalRemote["/target/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/target/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/target/keep.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AE2: local move OUT of a directory the remote deletes keeps the moved file, drops the rest", async () => {
		const result = await runScenario({
			name: "AE2",
			mode: "twoWay",
			initialLocal: { "/local/src/a.txt": "a", "/local/src/b.txt": "b" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "src/a.txt", "a.txt")),
				remoteMutate(world => world.cloud.controls.trashPath("/src")),
				runCycle(),
				runCycle()
			]
		})

		// a.txt moved out → survives at root; the remote-deleted src (incl. the unmoved b.txt) is gone.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/src/b.txt"]).toBeUndefined()
		expect(result.finalRemote["/src"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AE3: delete a file and move another onto its freed path in one cycle (path reuse)", async () => {
		const result = await runScenario({
			name: "AE3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "old-a", "/local/b.txt": "content-b" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "a.txt")
					renameLocal(world, "b.txt", "a.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		// /a.txt now holds b's content; /b.txt is gone; converged.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toBeUndefined()
		// The content at /a.txt is b's content (the local hash must match on both sides).
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AE4: conflicting moves of the same file to different directories keep both copies, no loss", async () => {
		const result = await runScenario({
			name: "AE4",
			mode: "twoWay",
			initialLocal: { "/local/x.txt": "x-content", "/local/dir1/.keep": "k1", "/local/dir2/.keep": "k2" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "x.txt", "dir1/x.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/x.txt", "/dir2/x.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Symmetric to Y9 (conflicting renames): neither move is silently dropped — the file ends up at
		// both targets, converged, with no data loss.
		expect(result.finalRemote["/dir1/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/x.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AE5: move a file into a brand-new directory while the remote adds a different file there", async () => {
		const result = await runScenario({
			name: "AE5",
			mode: "twoWay",
			initialLocal: { "/local/loose.txt": "loose" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "loose.txt", "fresh/loose.txt")),
				remoteMutate(world => world.cloud.controls.addFile("/fresh/remote.txt", "remote-content")),
				runCycle(),
				runCycle()
			]
		})

		// The new directory ends up holding BOTH the moved-in local file and the remote-added file.
		expect(result.finalRemote["/fresh/loose.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/fresh/remote.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/fresh/loose.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/fresh/remote.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/loose.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		// Settled idempotence.
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
