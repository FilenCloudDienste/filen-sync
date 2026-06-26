import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds } from "../harness/snapshot"
import { renameLocal, touchLocal } from "../harness/mutations"

/**
 * Category E — rename / move (behavioral spec §E, §4). Identity is the inode (local) / uuid (remote);
 * a path change with stable identity is a rename/move (NOT delete+add), so the remote node keeps its
 * uuid. A directory rename/move collapses its child renames into the single parent op.
 */
const SECOND = 1000

describe("Category E — rename / move", () => {
	it("E1: renaming a file in place renames the remote node (same uuid, no re-upload)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "E1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "content" },
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/a.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		// A rename is not a transfer: no upload/download of the content.
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("upload")
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "content".length })

		// Same remote identity at the new path → it was renamed, not re-created.
		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/b.txt")?.uuid).toBe(originalUUID)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E2: renaming a directory emits ONE parent rename (child renames collapsed)", async () => {
		const result = await runScenario({
			name: "E2",
			mode: "twoWay",
			initialLocal: {
				"/local/dir/a.txt": "a",
				"/local/dir/b.txt": "b",
				"/local/dir/sub/c.txt": "c"
			},
			steps: [runCycle(), localMutate(world => renameLocal(world, "dir", "dir2")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		// Children are carried by the parent rename — no per-child rename ops, no re-uploads.
		expect(kinds).not.toContain("renameRemoteFile")
		expect(kinds).not.toContain("upload")

		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir2/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/sub/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E3: moving a file across directories moves the remote node (same uuid)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "E3",
			mode: "twoWay",
			initialLocal: {
				"/local/x/a.txt": "content",
				"/local/y/keep.txt": "keep"
			},
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/x/a.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "x/a.txt", "y/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("upload")
		expect(result.finalRemote["/x/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/y/a.txt"]).toMatchObject({ type: "file", size: "content".length })
		expect(result.finalRemote["/y/keep.txt"]).toMatchObject({ type: "file" })

		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/y/a.txt")?.uuid).toBe(originalUUID)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E4: moving a directory subtree into another directory is a single move (children collapsed)", async () => {
		const result = await runScenario({
			name: "E4",
			mode: "twoWay",
			initialLocal: {
				"/local/src/a.txt": "a",
				"/local/src/sub/b.txt": "b",
				"/local/dest/keep.txt": "keep"
			},
			steps: [runCycle(), localMutate(world => renameLocal(world, "src", "dest/src")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("renameRemoteFile")
		expect(kinds).not.toContain("upload")

		expect(result.finalRemote["/src"]).toBeUndefined()
		expect(result.finalRemote["/dest/src/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dest/src/sub/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dest/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E5: moving a parent dir AND moving a child within it both resolve (parent + adjusted child op)", async () => {
		const result = await runScenario({
			name: "E5",
			mode: "twoWay",
			initialLocal: {
				"/local/dir/child.txt": "child",
				"/local/dir/keep.txt": "keep"
			},
			steps: [
				runCycle(),
				localMutate(world => {
					// Rename the parent, then independently move the child deeper within the renamed parent.
					renameLocal(world, "dir", "dir2")
					renameLocal(world, "dir2/child.txt", "dir2/sub/child.txt")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The parent rename carries keep.txt; the child's move is re-based onto the renamed parent.
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir2/sub/child.txt"]).toMatchObject({ type: "file", size: "child".length })
		expect(result.finalRemote["/dir2/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E6: swapping two file names converges with both contents preserved", async () => {
		const result = await runScenario({
			name: "E6",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": "AAA",
				"/local/b.txt": "BBB"
			},
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "tmp.txt")
					renameLocal(world, "b.txt", "a.txt")
					renameLocal(world, "tmp.txt", "b.txt")
					// A swap leaves both targets occupied, so the engine cannot rename onto them; it falls
					// back to content modify, which (like §C) needs a newer whole-second mtime to win. A real
					// swap happens after the initial sync, so stamp the swapped-in files as newer.
					touchLocal(world, "a.txt", BASE_TIME + 10 * SECOND)
					touchLocal(world, "b.txt", BASE_TIME + 10 * SECOND)
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// After the swap, a.txt holds the old b content and vice-versa; both sides agree.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: 3 })
		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file", size: 3 })
		expect(result.finalRemote["/a.txt"]!.contentHash).toBe(result.finalLocal["/a.txt"]!.contentHash)
		expect(result.finalRemote["/b.txt"]!.contentHash).toBe(result.finalLocal["/b.txt"]!.contentHash)
		// The swap actually happened: a.txt's content differs from b.txt's.
		expect(result.finalLocal["/a.txt"]!.contentHash).not.toBe(result.finalLocal["/b.txt"]!.contentHash)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E7: a case-only rename propagates to the remote (same uuid)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "E7",
			mode: "twoWay",
			initialLocal: { "/local/readme.txt": "content" },
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/readme.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "readme.txt", "README.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(result.finalRemote["/README.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/readme.txt"]).toBeUndefined()

		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/README.txt")?.uuid).toBe(originalUUID)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E8: renaming a file onto an existing name replaces it (renamed-in content wins)", async () => {
		const result = await runScenario({
			name: "E8",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": "from-a",
				"/local/b.txt": "old-b"
			},
			steps: [
				runCycle(),
				localMutate(world => {
					// Overwrite b.txt with a.txt; the renamed-in content must end up at b.txt on both sides.
					renameLocal(world, "a.txt", "b.txt")
					touchLocal(world, "b.txt", BASE_TIME + 10 * SECOND)
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "from-a".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("E9: the remote filesystem rejects moving a directory into its own subdirectory", async () => {
		const result = await runScenario({
			name: "E9",
			mode: "twoWay",
			initialLocal: { "/local/x/a.txt": "content" },
			steps: [runCycle()]
		})

		// The cycle has populated the remote tree cache with /x; an in-place move into its own subtree
		// is structurally invalid and must be refused rather than corrupt the tree.
		await expect(
			result.world.sync.remoteFileSystem.rename({ fromRelativePath: "/x", toRelativePath: "/x/sub" })
		).rejects.toThrow("Invalid paths")
	})

	it("E10: a rename chain across consecutive cycles ends at the final name (stable identity)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "E10",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "content" },
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/a.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				runCycle(),
				localMutate(world => renameLocal(world, "b.txt", "c.txt")),
				runCycle(),
				localMutate(world => renameLocal(world, "c.txt", "d.txt")),
				runCycle(),
				runCycle()
			]
		})

		// No duplicates and nothing lost: exactly one file, at the final name, with the original uuid.
		expect(Object.keys(result.finalRemote)).toEqual(["/d.txt"])
		expect(result.finalRemote["/d.txt"]).toMatchObject({ type: "file", size: "content".length })
		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/d.txt")?.uuid).toBe(originalUUID)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
