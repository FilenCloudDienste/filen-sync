import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { writeLocalAt, writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category AX — the type-change × content-op CONFLICT matrix (twoWay). Category T covers a type change
 * racing an UNCHANGED opposite side; AI4 covers exactly one type-change-vs-content-op direction. This
 * fills the remaining cells of the per-path triple table where ONE side changes a path's TYPE while the
 * OTHER side independently modifies / deletes / edits-a-child of it. Hard requirement: both replicas
 * must CONVERGE (a cross-type conflict must never crash or leave them permanently diverged) with no
 * loss of the surviving side's data. Add-only.
 */
describe("Category AX — type-change vs content-op conflicts", () => {
	// B = file -----------------------------------------------------------------------------------------
	it("AX1: local edits a file while the remote replaces it with a directory (mirror of AI4)", async () => {
		const result = await runScenario({
			name: "AX1",
			mode: "twoWay",
			initialLocal: { "/x": "v1" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "x", "locally-edited-longer-body", 1_700_000_500_000)),
				remoteMutate(world => {
					world.cloud.controls.trashPath("/x")
					world.cloud.controls.addDir("/x")
					world.cloud.controls.addFile("/x/inner.txt", "remote dir child")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AX2: local replaces a file with a directory while the remote deletes the file", async () => {
		const result = await runScenario({
			name: "AX2",
			mode: "twoWay",
			initialLocal: { "/x": "v1" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					writeLocal(world, "x/inner.txt", "now a dir")
				}),
				remoteMutate(world => world.cloud.controls.trashPath("/x")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The local type-change is newer information than the remote delete → the directory survives.
		expect(result.finalRemote["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/x/inner.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AX3: local deletes a file while the remote replaces it with a directory", async () => {
		const result = await runScenario({
			name: "AX3",
			mode: "twoWay",
			initialLocal: { "/x": "v1" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "x")),
				remoteMutate(world => {
					world.cloud.controls.trashPath("/x")
					world.cloud.controls.addDir("/x")
					world.cloud.controls.addFile("/x/inner.txt", "remote dir child")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote type-change is newer information than the local delete → the directory survives.
		expect(result.finalLocal["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/x/inner.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// B = directory ------------------------------------------------------------------------------------
	it("AX4: local replaces a directory with a file while the remote edits a child in it", async () => {
		const result = await runScenario({
			name: "AX4",
			mode: "twoWay",
			initialLocal: { "/d/child.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "d")
					writeLocal(world, "d", "now a file")
				}),
				remoteMutate(world => world.cloud.controls.updateFile("/d/child.txt", "remote-edited-child-longer")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Conflict: local made /d a file; remote kept /d a directory (with a live, edited child). Must converge.
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AX5: local deletes a directory while the remote replaces it with a file", async () => {
		const result = await runScenario({
			name: "AX5",
			mode: "twoWay",
			initialLocal: { "/d/child.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "d")),
				remoteMutate(world => {
					world.cloud.controls.trashPath("/d")
					world.cloud.controls.addFile("/d", "now a remote file")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote type-change (d→f) is newer than the local delete → the file survives.
		expect(result.finalLocal["/d"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AX6: local replaces a directory with a file while the remote deletes the directory", async () => {
		const result = await runScenario({
			name: "AX6",
			mode: "twoWay",
			initialLocal: { "/d/child.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "d")
					writeLocal(world, "d", "now a local file")
				}),
				remoteMutate(world => world.cloud.controls.trashPath("/d")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The local type-change (d→f) is newer than the remote delete → the file survives.
		expect(result.finalRemote["/d"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// Both sides change the SAME type the SAME way (the remaining type-change cells) -----------------
	it("AX7: both sides independently replace a file with a directory (different children)", async () => {
		const result = await runScenario({
			name: "AX7",
			mode: "twoWay",
			initialLocal: { "/x": "v1" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					writeLocal(world, "x/local-inner.txt", "local child")
				}),
				remoteMutate(world => {
					world.cloud.controls.trashPath("/x")
					world.cloud.controls.addDir("/x")
					world.cloud.controls.addFile("/x/remote-inner.txt", "remote child")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// /x converges to a directory; neither side's child is lost (the two adds merge).
		expect(result.finalRemote["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/x/local-inner.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/x/remote-inner.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AX8: both sides independently replace a directory with a file (different content)", async () => {
		const result = await runScenario({
			name: "AX8",
			mode: "twoWay",
			initialLocal: { "/d/child.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "d")
					writeLocalAt(world, "d", "local file content", 1_700_000_500_000)
				}),
				remoteMutate(world => {
					world.cloud.controls.trashPath("/d")
					world.cloud.controls.addFile("/d", "remote file content")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// /d converges to a single file (conflict resolution picks one copy); both sides agree.
		expect(result.finalRemote["/d"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AX9: remote replaces a directory with a file while the local edits a child (mirror of AX4)", async () => {
		const result = await runScenario({
			name: "AX9",
			mode: "twoWay",
			initialLocal: { "/d/child.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "d/child.txt", "locally-edited-child-longer", 1_700_000_500_000)),
				remoteMutate(world => {
					world.cloud.controls.trashPath("/d")
					world.cloud.controls.addFile("/d", "remote made it a file")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
