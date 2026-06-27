import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control, type Step } from "../harness/runner"
import { writeLocalAt, rmLocal, renameLocal } from "../harness/mutations"
import { transferKinds } from "../harness/snapshot"
import { BASE_TIME } from "../harness/world"

const SECOND = 1000

/**
 * Category ZD — inode reuse must not be misread as a rename.
 *
 * The local rename pass keys on inode: an inode that sat at path P in the base but now sits at path Q is
 * treated as "P renamed to Q". But the OS RECYCLES inode numbers — ext4 hands a just-freed inode to the
 * very next created file — so "delete a.txt + create c.txt" can put c.txt on a.txt's old inode and be
 * misread as "rename a.txt -> c.txt". That phantom rename propagates as a REMOTE rename and deletes the
 * original: silent data loss in modes that keep deletions (localBackup), and invisible in twoWay only
 * because the stale path was going to be deleted anyway. This is exactly why the live `lifecycle.e2e` I6
 * test flaked on Linux (ext4) while passing on macOS/Windows and in this fake-fs suite — memfs does not
 * surface the reuse on its own, so these tests force it with the `setInode` control.
 *
 * The fix additionally requires the creation/birthtime to match: a genuine rename (even a rename+modify)
 * preserves birthtime, whereas a reused inode belongs to a freshly-created file with a newer one.
 */

function settle(): Step[] {
	return [runCycle(), runCycle()]
}

describe("Category ZD — inode reuse is not a rename", () => {
	it("ZD1: localBackup — a NEW file on a deleted file's recycled inode does NOT delete the original (no phantom rename)", async () => {
		let reusedInode = 0

		const result = await runScenario({
			name: "ZD1",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "a", "/local/keep.txt": "k" },
			steps: [
				...settle(),
				// Capture a.txt's inode, delete it (freeing the inode), create a brand-new c.txt, then force
				// c.txt onto a.txt's freed inode — exactly what ext4 does and memfs will not do on its own.
				control(world => {
					reusedInode = world.vfs.controls.getInode("/local/a.txt")!
				}),
				localMutate(world => rmLocal(world, "a.txt")),
				localMutate(world => writeLocalAt(world, "c.txt", "c", BASE_TIME + 30 * SECOND)),
				control(world => world.vfs.controls.setInode("/local/c.txt", reusedInode)),
				runCycle(),
				runCycle()
			]
		})

		const reuseCycle = result.cycles[2]!

		// The reuse must NOT be propagated as a rename of the remote original.
		expect(transferKinds(reuseCycle.messages)).not.toContain("renameRemoteFile")
		// localBackup keeps remote-only files: the original survives, and the genuinely new file is uploaded.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("ZD2: twoWay — inode reuse is a delete+add, never a phantom rename", async () => {
		let reusedInode = 0

		const result = await runScenario({
			name: "ZD2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "aaaa", "/local/keep.txt": "k" },
			steps: [
				...settle(),
				control(world => {
					reusedInode = world.vfs.controls.getInode("/local/a.txt")!
				}),
				localMutate(world => rmLocal(world, "a.txt")),
				localMutate(world => writeLocalAt(world, "c.txt", "cc", BASE_TIME + 30 * SECOND)),
				control(world => world.vfs.controls.setInode("/local/c.txt", reusedInode)),
				runCycle(),
				runCycle()
			]
		})

		const reuseCycle = result.cycles[2]!

		// twoWay would also end up with a.txt gone and c.txt present even WITH the phantom rename (the rename
		// + a follow-up content upload coincidentally lands the same end state), so the meaningful guarantee
		// is the EMITTED intent: a delete + an add, never a rename of the unrelated original.
		expect(transferKinds(reuseCycle.messages)).not.toContain("renameRemoteFile")
		// The deletion genuinely propagated and the new file carries ITS OWN content ("cc" = 2 bytes), not
		// the original's ("aaaa" = 4 bytes).
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file", size: 2 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZD3: a genuine rename (inode AND birthtime preserved) is still detected as a rename, not a re-upload", async () => {
		const result = await runScenario({
			name: "ZD3",
			mode: "twoWay",
			initialLocal: { "/local/old.txt": "data", "/local/keep.txt": "k" },
			steps: [
				...settle(),
				localMutate(world => renameLocal(world, "old.txt", "new.txt")),
				runCycle(),
				runCycle()
			]
		})

		const renameCycle = result.cycles[2]!

		// The creation-match guard must NOT over-correct: a real move (memfs rename preserves inode AND
		// birthtime, like a real fs) still propagates as a rename — no content re-upload.
		expect(transferKinds(renameCycle.messages)).toContain("renameRemoteFile")
		expect(transferKinds(renameCycle.messages)).not.toContain("upload")
		expect(result.finalRemote["/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/old.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
