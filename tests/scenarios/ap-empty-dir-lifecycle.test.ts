import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { mkdirLocal, rmLocal, writeLocal } from "../harness/mutations"

/**
 * Category AP — empty-directory lifecycle (twoWay). Empty directories carry no file payload, so they
 * are easy to drop; verify they are created, deleted, nested, and preserved-when-emptied symmetrically
 * on both sides. Add-only.
 */
describe("Category AP — empty-directory lifecycle", () => {
	it("AP1: a locally-created empty directory is synced to the remote", async () => {
		const result = await runScenario({
			name: "AP1",
			mode: "twoWay",
			initialLocal: {},
			steps: [runCycle(), localMutate(world => mkdirLocal(world, "empty")), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/empty"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AP2: creating then deleting an empty directory propagates the deletion", async () => {
		const result = await runScenario({
			name: "AP2",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				localMutate(world => mkdirLocal(world, "empty")),
				runCycle(),
				localMutate(world => rmLocal(world, "empty")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/empty"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AP3: a nested chain of empty directories is synced in full", async () => {
		const result = await runScenario({
			name: "AP3",
			mode: "twoWay",
			initialLocal: {},
			steps: [runCycle(), localMutate(world => mkdirLocal(world, "a/b/c")), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/a/b"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/a/b/c"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AP4: a directory that becomes empty (its only file deleted) is preserved as an empty dir", async () => {
		const result = await runScenario({
			name: "AP4",
			mode: "twoWay",
			initialLocal: { "/local/dir/only.txt": "x" },
			steps: [runCycle(), localMutate(world => rmLocal(world, "dir/only.txt")), runCycle(), runCycle()]
		})

		// The file delete propagates, but the now-empty directory itself is kept on both sides.
		expect(result.finalRemote["/dir/only.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AP5: a remotely-created empty directory is downloaded to local", async () => {
		const result = await runScenario({
			name: "AP5",
			mode: "twoWay",
			initialLocal: {},
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.addDir("/remote-empty")), runCycle(), runCycle()]
		})

		expect(result.finalLocal["/remote-empty"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AP6: filling a previously-empty synced directory uploads the new child", async () => {
		const result = await runScenario({
			name: "AP6",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				localMutate(world => mkdirLocal(world, "box")),
				runCycle(),
				localMutate(world => writeLocal(world, "box/item.txt", "filled")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/box"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/box/item.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
