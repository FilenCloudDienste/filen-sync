import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { renameLocal, writeLocal } from "../harness/mutations"

/**
 * Category ZW — cross-side DIRECTORY rename racing a child RENAME / MOVE on the OTHER side.
 *
 * The ZB family pins a directory renamed on one side while a descendant is MODIFIED / DELETED / ADDED on
 * the other. The remaining shape is a descendant that is itself RENAMED or MOVED on the other side, in the
 * same cycle. The interaction is subtle: the dir rename relocates the whole subtree (rename-aware rebase),
 * but the cross-side child rename keys on the child's PRE-rename path — which no longer exists on the
 * dir-renaming side — so the child rename can NOT propagate as a cheap server-side rename. The engine must
 * still converge with no data loss: the child rename collapses into delete-old-name + transfer-new-name at
 * the post-dir-rename location. These pin that convergence (it must keep the child's content and land it at
 * the new name inside the renamed directory), and guard the rebase against a future regression.
 *
 * twoWay is symmetric (either side may own the dir rename); the mirror modes assert authoritative-side wins.
 */
describe("Category ZW — cross-side dir rename + child rename/move", () => {
	it("ZW1: local dir rename + remote child rename (same dir) → converges to the new child name in the renamed dir", async () => {
		const result = await runScenario({
			name: "ZW1",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "AAA", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				// Remote renames the child within the (still /dir) directory — a uuid-preserving move.
				remoteMutate(world => world.cloud.controls.movePath("/dir/a.txt", "/dir/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The directory rename wins, and the child arrives under its NEW name with its ORIGINAL content.
		expect(result.finalRemote["/dir2/b.txt"]).toMatchObject({ size: "AAA".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/dir2/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		// Content really survived (not just same size).
		expect(result.finalLocal["/dir2/b.txt"]!.contentHash).toBe(result.finalRemote["/dir2/b.txt"]!.contentHash)
	})

	it("ZW2: remote dir rename + local child rename (same dir) → converges (symmetric)", async () => {
		const result = await runScenario({
			name: "ZW2",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "AAA", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				localMutate(world => renameLocal(world, "dir/a.txt", "dir/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/b.txt"]).toMatchObject({ size: "AAA".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/dir2/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/dir2/b.txt"]!.contentHash).toBe(result.finalRemote["/dir2/b.txt"]!.contentHash)
	})

	it("ZW3: local dir rename + remote MOVES a child OUT of the dir → the child escapes, the dir is renamed", async () => {
		const result = await runScenario({
			name: "ZW3",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "AAA", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				// Remote moves the child out to the sync root (uuid preserved).
				remoteMutate(world => world.cloud.controls.movePath("/dir/a.txt", "/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ size: "AAA".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/dir2/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("ZW4: remote dir rename + local MOVES a child INTO the renamed dir from outside → converges", async () => {
		const result = await runScenario({
			name: "ZW4",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "k", "/local/outside.txt": "OUT" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				// Local moves a root-level file into the directory the other device just renamed.
				localMutate(world => renameLocal(world, "outside.txt", "dir/inside.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The moved file lands inside the renamed directory and converges; nothing is left at the old paths.
		expect(result.finalRemote["/dir2/inside.txt"]).toMatchObject({ size: "OUT".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/outside.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir/inside.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/dir2/inside.txt"]!.contentHash).toBe(result.finalRemote["/dir2/inside.txt"]!.contentHash)
	})

	it("ZW5: NESTED — rename a top dir + remote renames a DEEPLY nested child → converges at the new path", async () => {
		const result = await runScenario({
			name: "ZW5",
			mode: "twoWay",
			initialLocal: { "/local/top/mid/deep/a.txt": "AAA", "/local/top/other.txt": "o" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "top", "top2")),
				remoteMutate(world => world.cloud.controls.movePath("/top/mid/deep/a.txt", "/top/mid/deep/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/top2/mid/deep/b.txt"]).toMatchObject({ size: "AAA".length })
		expect(result.finalRemote["/top2/other.txt"]).toMatchObject({ size: "o".length })
		expect(result.finalRemote["/top2/mid/deep/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZW6: localToCloud — local dir rename + a foreign remote child rename → local structure wins, converges", async () => {
		const result = await runScenario({
			name: "ZW6",
			mode: "localToCloud",
			initialLocal: { "/local/dir/a.txt": "AAA", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.movePath("/dir/a.txt", "/dir/foreign.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Local is authoritative: the file keeps the LOCAL name (a.txt) at the renamed dir; the foreign
		// remote rename to foreign.txt is undone (mirror strictness).
		expect(result.finalRemote["/dir2/a.txt"]).toMatchObject({ size: "AAA".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/dir2/foreign.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir/foreign.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZW8: local dir rename + remote MOVES a file INTO the renamed dir from outside → converges (no duplication)", async () => {
		const result = await runScenario({
			name: "ZW8",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "k", "/local/outside.txt": "OUT" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				// Remote moves a root-level file INTO the directory that the local just renamed.
				remoteMutate(world => world.cloud.controls.movePath("/outside.txt", "/dir/inside.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/inside.txt"]).toMatchObject({ size: "OUT".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/outside.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir/inside.txt"]).toBeUndefined()
		// No phantom old directory and no duplicate copy of the moved file.
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/dir2/inside.txt"]!.contentHash).toBe(result.finalRemote["/dir2/inside.txt"]!.contentHash)
	})

	it("ZW9: local dir rename + remote MOVES a whole sub-directory INTO the renamed dir → converges (no duplication)", async () => {
		const result = await runScenario({
			name: "ZW9",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "k", "/local/sub/child.txt": "C" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				// Remote moves the whole /sub directory INTO the directory the local just renamed.
				remoteMutate(world => world.cloud.controls.movePath("/sub", "/dir/sub")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/sub/child.txt"]).toMatchObject({ size: "C".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		// The sub-directory must land ONCE inside the renamed dir — not duplicated, no phantom /dir, no stray /sub.
		expect(result.finalRemote["/dir/sub/child.txt"]).toBeUndefined()
		expect(result.finalRemote["/sub/child.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/dir2/sub/child.txt"]!.contentHash).toBe(result.finalRemote["/dir2/sub/child.txt"]!.contentHash)
	})

	it("ZW10: local MOVES a file into a remotely-renamed dir AND modifies it → the modified content wins (no loss)", async () => {
		// NOTE: memfs REPLACES the inode on the in-place write, so the mock reaches this via delete+add (still a
		// valid move+modify-into-renamed-dir case). On a REAL fs the inode is preserved → the rename+modify (F1)
		// path fires, where the F1 `uploadFile` had to be rebased onto the renamed dir too or the edit was LOST
		// — a live-only data-loss bug caught by `weird-edge-2.e2e` and fixed in deltas.ts (see that e2e test).
		const result = await runScenario({
			name: "ZW10",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "k", "/local/outside.txt": "ORIG" },
			steps: [
				runCycle(),
				// Local moves outside.txt INTO /dir AND edits it (new, longer content) in the same window;
				// remote renames /dir → /dir2. The move's content edit must land at the rebased path.
				localMutate(world => {
					renameLocal(world, "outside.txt", "dir/inside.txt")
					writeLocal(world, "dir/inside.txt", "MODIFIED-AFTER-MOVE-LONGER")
				}),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The MODIFIED content (not the pre-move original) must survive at the renamed-dir path on both sides.
		expect(result.finalRemote["/dir2/inside.txt"]).toMatchObject({ type: "file", size: "MODIFIED-AFTER-MOVE-LONGER".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/inside.txt"]).toBeUndefined()
		expect(result.finalRemote["/outside.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/dir2/inside.txt"]!.contentHash).toBe(result.finalRemote["/dir2/inside.txt"]!.contentHash)
	})

	it("ZW7: after a cross-side dir-rename + child-rename converges, an extra cycle is a no-op (stability)", async () => {
		const result = await runScenario({
			name: "ZW7",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "AAA" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.movePath("/dir/a.txt", "/dir/b.txt")),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)
		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
		expect(result.finalRemote["/dir2/b.txt"]).toMatchObject({ size: "AAA".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
