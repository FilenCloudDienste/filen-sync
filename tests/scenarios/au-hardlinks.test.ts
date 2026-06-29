import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category AU — hardlinks (two distinct paths sharing ONE inode). A real fs gives hardlinked files the
 * same inode number; the cloud has no hardlink concept, so the correct outcome is that each path syncs as
 * an INDEPENDENT copy with no crash and no data loss. The engine's rename detector is inode-keyed, so a
 * shared inode collides in its inode→path map — this verifies that collision degrades gracefully rather
 * than dropping a file or misfiring a rename. The inode collision is forced with the `setInode` control
 * (memfs has no native hardlinks), the same mechanism category ZD uses for inode reuse. Add-only.
 *
 * Assertions stay on convergence + no-data-loss (not specific op kinds), since which of the two colliding
 * paths wins the inode→path slot depends on scan order.
 */
describe("Category AU — hardlinks (shared inode)", () => {
	it("AU1: two files sharing one inode both sync as independent copies", async () => {
		const result = await runScenario({
			name: "AU1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "alpha", "/local/b.txt": "bravo" },
			steps: [
				// Force b.txt onto a.txt's inode → two live paths, one inode (a hardlink pair).
				control(world => {
					const ino = world.vfs.controls.getInode("/local/a.txt")!
					world.vfs.controls.setInode("/local/b.txt", ino)
				}),
				runCycle(),
				runCycle()
			]
		})

		// Neither file is dropped; both reach the remote with their own content.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file" })
	})

	it("AU2: deleting one of two shared-inode files leaves the other intact", async () => {
		const result = await runScenario({
			name: "AU2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "alpha", "/local/b.txt": "bravo", "/local/keep.txt": "k" },
			steps: [
				control(world => {
					const ino = world.vfs.controls.getInode("/local/a.txt")!
					world.vfs.controls.setInode("/local/b.txt", ino)
				}),
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// a.txt's deletion propagates; b.txt (the surviving link) is NOT collaterally removed.
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AU3: a third hardlink added after the first sync syncs as another independent copy", async () => {
		const result = await runScenario({
			name: "AU3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "alpha" },
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "c.txt", "alpha")),
				control(world => {
					const ino = world.vfs.controls.getInode("/local/a.txt")!
					world.vfs.controls.setInode("/local/c.txt", ino)
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
