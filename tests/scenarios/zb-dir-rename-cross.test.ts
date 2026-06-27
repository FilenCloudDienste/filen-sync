import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds } from "../harness/snapshot"
import { renameLocal, writeLocalAt, rmLocal } from "../harness/mutations"

/**
 * Cross-side directory rename + concurrent child change (BUG-A / BUG-B). A directory renamed on ONE side
 * while a descendant is changed on the OTHER side is the hardest reconciliation case: the rename relocates
 * the whole subtree, but the per-descendant passes compare current-vs-base by PATH, so a child still sitting
 * at the pre-rename path on the other side is mis-attributed. Before the rename-aware rebase, this silently
 * destroyed the other-side modification (BUG-A) or resurrected an other-side deletion (BUG-B). Every case
 * must converge (finalLocal === finalRemote) with the NEWER change winning and no data loss.
 *
 * Category E covers same-side rename mechanics; Z covers same-side multi-op; Y covers same-path conflicts.
 * This file is specifically the cross-side directory-subtree race.
 */
const SECOND = 1000

describe("Cross-side directory rename + concurrent child change (BUG-A / BUG-B)", () => {
	it("ZB1: local dir rename + remote child MODIFY → the remote edit survives (BUG-A)", async () => {
		const result = await runScenario({
			name: "ZB1",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old", "/local/dir/sibling.txt": "sib" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world =>
					world.cloud.controls.updateFile("/dir/child.txt", "REMOTE-EDITED-NEW-CONTENT", { mtimeMs: BASE_TIME + 10 * SECOND })
				),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/child.txt"]).toMatchObject({ size: "REMOTE-EDITED-NEW-CONTENT".length })
		expect(result.finalRemote["/dir2/sibling.txt"]).toMatchObject({ size: "sib".length })
		expect(result.finalRemote["/dir/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB2: remote dir rename + local child MODIFY → the local edit survives (BUG-A symmetric)", async () => {
		const result = await runScenario({
			name: "ZB2",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old", "/local/dir/sibling.txt": "sib" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				localMutate(world => writeLocalAt(world, "dir/child.txt", "LOCAL-EDITED-NEW-CONTENT", BASE_TIME + 10 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/child.txt"]).toMatchObject({ size: "LOCAL-EDITED-NEW-CONTENT".length })
		expect(result.finalRemote["/dir2/sibling.txt"]).toMatchObject({ size: "sib".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB3: local dir rename + remote child DELETE → the child is deleted, not resurrected (BUG-B)", async () => {
		const result = await runScenario({
			name: "ZB3",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.trashPath("/dir/child.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The renamed directory survives with its un-touched child; the remotely-deleted child stays deleted.
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/dir2/child.txt"]).toBeUndefined()
		expect(result.finalLocal["/dir2/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB4: remote dir rename + local child DELETE → the child is deleted, not resurrected (BUG-B symmetric)", async () => {
		const result = await runScenario({
			name: "ZB4",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				// The user deletes a file inside a folder another device just renamed. Without the rebase the
				// remote copy (now at /dir2/child.txt) would be resurrected back down instead of deleted.
				localMutate(world => rmLocal(world, "dir/child.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/dir2/child.txt"]).toBeUndefined()
		expect(result.finalLocal["/dir2/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB5: NESTED — rename a top dir + remote modify of a DEEPLY nested child → edit survives at the new path", async () => {
		const result = await runScenario({
			name: "ZB5",
			mode: "twoWay",
			initialLocal: { "/local/top/mid/deep/child.txt": "old", "/local/top/other.txt": "o" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "top", "top2")),
				remoteMutate(world =>
					world.cloud.controls.updateFile("/top/mid/deep/child.txt", "DEEPLY-NESTED-NEW-CONTENT", {
						mtimeMs: BASE_TIME + 10 * SECOND
					})
				),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/top2/mid/deep/child.txt"]).toMatchObject({ size: "DEEPLY-NESTED-NEW-CONTENT".length })
		expect(result.finalRemote["/top2/other.txt"]).toMatchObject({ size: "o".length })
		expect(result.finalRemote["/top/mid/deep/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB6: MULTIPLE children — rename dir; remote modifies one, deletes one, leaves one", async () => {
		const result = await runScenario({
			name: "ZB6",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "a-old", "/local/dir/b.txt": "b-old", "/local/dir/c.txt": "c-old" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => {
					world.cloud.controls.updateFile("/dir/a.txt", "A-REMOTE-EDITED-NEW", { mtimeMs: BASE_TIME + 10 * SECOND })
					world.cloud.controls.trashPath("/dir/b.txt")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/a.txt"]).toMatchObject({ size: "A-REMOTE-EDITED-NEW".length })
		expect(result.finalRemote["/dir2/b.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir2/c.txt"]).toMatchObject({ size: "c-old".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB7: MOVE a dir into another dir + remote child modify → edit survives at the moved-into path", async () => {
		const result = await runScenario({
			name: "ZB7",
			mode: "twoWay",
			initialLocal: { "/local/src/data.txt": "old", "/local/dest/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "src", "dest/src")),
				remoteMutate(world =>
					world.cloud.controls.updateFile("/src/data.txt", "MOVED-DIR-CHILD-NEW-CONTENT", { mtimeMs: BASE_TIME + 10 * SECOND })
				),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dest/src/data.txt"]).toMatchObject({ size: "MOVED-DIR-CHILD-NEW-CONTENT".length })
		expect(result.finalRemote["/dest/keep.txt"]).toMatchObject({ size: "k".length })
		expect(result.finalRemote["/src/data.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB8: local dir rename + remote ADDS a new child under the old path → the new child lands in the renamed dir", async () => {
		const result = await runScenario({
			name: "ZB8",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.addFile("/dir/new.txt", "REMOTE-ADDED-CHILD", { mtimeMs: BASE_TIME + 10 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/child.txt"]).toMatchObject({ size: "old".length })
		expect(result.finalRemote["/dir2/new.txt"]).toMatchObject({ size: "REMOTE-ADDED-CHILD".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB9: a SIMPLE dir rename (no child change) converges with NO file transfer (regression guard)", async () => {
		const result = await runScenario({
			name: "ZB9",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old", "/local/dir/sibling.txt": "sib" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				runCycle(),
				runCycle()
			]
		})

		// The rename must NOT degrade into a re-upload/re-download of the unchanged children.
		const renameCycleKinds = transferKinds(result.cycles[1]!.messages)
		expect(renameCycleKinds).not.toContain("upload")
		expect(renameCycleKinds).not.toContain("download")
		expect(result.finalRemote["/dir2/child.txt"]).toMatchObject({ size: "old".length })
		expect(result.finalRemote["/dir2/sibling.txt"]).toMatchObject({ size: "sib".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB10: after a cross-side rename+modify converges, an extra cycle is a no-op (multi-cycle stability)", async () => {
		const result = await runScenario({
			name: "ZB10",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "old" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world =>
					world.cloud.controls.updateFile("/dir/child.txt", "REMOTE-EDITED-NEW-CONTENT", { mtimeMs: BASE_TIME + 10 * SECOND })
				),
				runCycle(),
				runCycle(),
				runCycle(),
				// A final settled cycle must produce no transfers.
				runCycle()
			]
		})

		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)
		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
		expect(result.finalRemote["/dir2/child.txt"]).toMatchObject({ size: "REMOTE-EDITED-NEW-CONTENT".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// Mirror-mode coverage: BUG-A's DATA LOSS is twoWay-specific (a mirror's authoritative side always wins
	// correctly), but the rename-aware rebase must still keep mirror modes CONVERGENT and the authoritative
	// side's content winning at the renamed path.

	it("ZB11: localToCloud — local dir rename + a foreign remote child edit → local content wins, converges", async () => {
		const result = await runScenario({
			name: "ZB11",
			mode: "localToCloud",
			initialLocal: { "/local/dir/child.txt": "old", "/local/dir/sibling.txt": "sib" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world =>
					world.cloud.controls.updateFile("/dir/child.txt", "FOREIGN-REMOTE-EDIT", { mtimeMs: BASE_TIME + 10 * SECOND })
				),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Local authoritative: the foreign remote edit is reverted to the local content at the renamed path.
		expect(result.finalRemote["/dir2/child.txt"]).toMatchObject({ size: "old".length })
		expect(result.finalRemote["/dir/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZB12: cloudToLocal — remote dir rename + a foreign local child edit → remote content wins, converges", async () => {
		const result = await runScenario({
			name: "ZB12",
			mode: "cloudToLocal",
			initialRemote: { "/dir/child.txt": "old", "/dir/sibling.txt": "sib" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				localMutate(world => writeLocalAt(world, "dir/child.txt", "FOREIGN-LOCAL-EDIT", BASE_TIME + 10 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Remote authoritative: the foreign local edit is reverted to the remote content at the renamed path.
		expect(result.finalLocal["/dir2/child.txt"]).toMatchObject({ size: "old".length })
		expect(result.finalLocal["/dir/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
