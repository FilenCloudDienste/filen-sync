import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { rmLocal, renameLocal, writeLocal } from "../harness/mutations"

/**
 * Category AG — directory-vs-child cross-side races (twoWay). One side restructures a directory
 * (delete / rename / move) while the OTHER side adds or modifies a child inside the same directory in
 * the same cycle. These probe the dir-delete-vs-surviving-child rule and "add into a renamed dir"
 * ordering for data loss / non-convergence. Add-only.
 */
describe("Category AG — directory-vs-child cross-side races", () => {
	it("AG1: local deletes a directory while the remote adds a new child into it — the child survives", async () => {
		const result = await runScenario({
			name: "AG1",
			mode: "twoWay",
			initialLocal: { "/local/dir/existing.txt": "e" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "dir")),
				remoteMutate(world => world.cloud.controls.addFile("/dir/new.txt", "n")),
				runCycle(),
				runCycle()
			]
		})

		// The remote add is newer information than the local delete: the freshly-added child must not be
		// lost, so the directory is kept holding it; the unmodified existing.txt is removed.
		expect(result.finalRemote["/dir/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/dir/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/existing.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AG2: remote deletes a directory while the local adds a new child into it — the child survives", async () => {
		const result = await runScenario({
			name: "AG2",
			mode: "twoWay",
			initialLocal: { "/local/dir/existing.txt": "e" },
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "dir/new.txt", "n")),
				remoteMutate(world => world.cloud.controls.trashPath("/dir")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/dir/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/existing.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AG3: local moves a directory while the remote adds a child into its old path — child follows the move", async () => {
		const result = await runScenario({
			name: "AG3",
			mode: "twoWay",
			initialLocal: { "/local/dir/existing.txt": "e" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.addFile("/dir/new.txt", "n")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The directory is renamed; both the pre-existing and the newly-added child end up under the new
		// name with nothing left behind at the old path.
		expect(result.finalRemote["/dir2/existing.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir/new.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AG4: local renames a directory while the remote modifies a child inside it — modification is kept", async () => {
		const result = await runScenario({
			name: "AG4",
			mode: "twoWay",
			initialLocal: { "/local/dir/existing.txt": "old" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.updateFile("/dir/existing.txt", "new-content")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/existing.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		// The remote modification (new-content) is preserved on both sides after the rename.
		expect(result.finalLocal["/dir2/existing.txt"]!.contentHash).toBe(result.finalRemote["/dir2/existing.txt"]!.contentHash)
	})
})
