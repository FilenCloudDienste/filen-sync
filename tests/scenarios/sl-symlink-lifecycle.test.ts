import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control, localMutate, remoteMutate } from "../harness/runner"
import { messagesOfType, transferKinds } from "../harness/snapshot"
import { rmLocal, writeLocal } from "../harness/mutations"
import { type SyncMessage } from "../../src/types"

/** Total task errors across a message stream — a wedge (re-download onto a symlink) shows up here. */
function taskErrorCount(messages: SyncMessage[]): number {
	return messagesOfType(messages, "taskErrors").reduce((sum, m) => sum + m.data.errors.length, 0)
}

/**
 * Category SL — symlink lifecycle. The engine lstats every entry, so a symlink is recognized and SKIPPED
 * structurally (never followed onto its target's inode) and — being "ignored", not "deleted" — its already-
 * synced cloud counterpart is preserved (BUG-006). Category F pins a file→symlink transition (F9/F15); these
 * pin the remaining unambiguous shapes: a symlink pointing at a DIRECTORY, and a symlink later REPLACED by a
 * real file (which must then sync). All must leave the cycle error-free and converge on the real entries.
 */
describe("Category SL — symlink lifecycle", () => {
	it("SL1: a symlink pointing at a directory is skipped; real siblings still sync", async () => {
		const result = await runScenario({
			name: "SL1",
			mode: "twoWay",
			initialLocal: { "/local/realdir/file.txt": "R", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				control(world => {
					// A symlink whose target is a directory must not be followed and uploaded as a directory.
					world.vfs.ifs.symlinkSync("/local/realdir", "/local/linkdir")
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		// The symlink is not synced; the genuine directory and file are.
		expect(result.finalRemote["/linkdir"]).toBeUndefined()
		expect(result.finalRemote["/realdir/file.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		// No task error was produced by encountering the symlink.
		const taskErrors = messagesOfType(result.messages, "taskErrors").reduce((sum, m) => sum + m.data.errors.length, 0)
		expect(taskErrors).toBe(0)
	})

	it("SL2: a symlink later replaced by a REAL file now syncs that file", async () => {
		const result = await runScenario({
			name: "SL2",
			mode: "twoWay",
			initialLocal: { "/local/target.txt": "T", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				control(world => {
					world.vfs.ifs.symlinkSync("/local/target.txt", "/local/slot.txt")
					world.triggerWatcher()
				}),
				runCycle(),
				// Replace the symlink with a genuine file at the same path.
				localMutate(world => {
					rmLocal(world, "slot.txt")
					writeLocal(world, "slot.txt", "REAL-FILE-NOW")
				}),
				runCycle(),
				runCycle()
			]
		})

		// Once it is a real file it is no longer skipped and uploads with its content.
		expect(result.finalRemote["/slot.txt"]).toMatchObject({ type: "file", size: "REAL-FILE-NOW".length })
		expect(result.finalLocal["/slot.txt"]).toMatchObject({ type: "file", size: "REAL-FILE-NOW".length })
		expect(result.finalLocal["/slot.txt"]!.contentHash).toBe(result.finalRemote["/slot.txt"]!.contentHash)
	})

	it("SL3: a synced file → symlink → file round-trip keeps the cloud copy throughout and re-converges", async () => {
		const result = await runScenario({
			name: "SL3",
			mode: "twoWay",
			initialLocal: { "/local/doc.txt": "v1", "/local/target.txt": "T" },
			steps: [
				runCycle(),
				// doc.txt becomes a symlink — its cloud copy must survive (ignore ≠ delete).
				control(world => {
					rmLocal(world, "doc.txt")
					world.vfs.ifs.symlinkSync("/local/target.txt", "/local/doc.txt")
					world.triggerWatcher()
				}),
				runCycle(),
				// …then becomes a real file again with new content.
				localMutate(world => {
					rmLocal(world, "doc.txt")
					writeLocal(world, "doc.txt", "v2-restored")
				}),
				runCycle(),
				runCycle()
			]
		})

		// The cloud copy was preserved across the symlink phase, then updated to the restored content.
		expect(result.finalRemote["/doc.txt"]).toMatchObject({ type: "file", size: "v2-restored".length })
		expect(result.finalLocal["/doc.txt"]).toMatchObject({ type: "file", size: "v2-restored".length })
		expect(result.finalLocal["/doc.txt"]!.contentHash).toBe(result.finalRemote["/doc.txt"]!.contentHash)
	})

	it("SL4: replacing a synced DIRECTORY with a symlink KEEPS the cloud copies of its children (ignore ≠ delete)", async () => {
		const result = await runScenario({
			name: "SL4",
			mode: "twoWay",
			initialLocal: { "/local/projects/a.txt": "A", "/local/projects/b.txt": "B", "/local/target.txt": "T" },
			steps: [
				runCycle(),
				// The user moves the real folder away and symlinks it back (a common dev reorg). The whole
				// subtree is now behind a skipped symlink — its cloud backup must NOT be deleted.
				control(world => {
					rmLocal(world, "projects")
					world.vfs.ifs.symlinkSync("/local/target.txt", "/local/projects")
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The cloud copies of the children survive (consistent with file→symlink, F15) — no silent data loss.
		expect(result.finalRemote["/projects/a.txt"]).toMatchObject({ type: "file", size: "A".length })
		expect(result.finalRemote["/projects/b.txt"]).toMatchObject({ type: "file", size: "B".length })
		expect(result.finalRemote["/projects"]).toMatchObject({ type: "directory" })
		// And the engine does NOT wedge trying to re-create/download the hidden subtree onto the symlink.
		expect(taskErrorCount(result.messages)).toBe(0)
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("SL5: localToCloud — a synced folder replaced by a symlink keeps its remote subtree (no mirror-delete, no wedge)", async () => {
		const result = await runScenario({
			name: "SL5",
			mode: "localToCloud",
			initialLocal: { "/local/projects/a.txt": "A", "/local/projects/b.txt": "B", "/local/target.txt": "T" },
			steps: [
				runCycle(),
				control(world => {
					rmLocal(world, "projects")
					world.vfs.ifs.symlinkSync("/local/target.txt", "/local/projects")
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Even a strict local→cloud MIRROR must not mirror-delete a subtree that is merely behind a symlink.
		expect(result.finalRemote["/projects/a.txt"]).toMatchObject({ type: "file", size: "A".length })
		expect(result.finalRemote["/projects/b.txt"]).toMatchObject({ type: "file", size: "B".length })
		expect(taskErrorCount(result.messages)).toBe(0)
	})

	it("SL6: cloudToLocal — a local folder replaced by a symlink does not re-download its remote subtree onto it (no wedge)", async () => {
		const result = await runScenario({
			name: "SL6",
			mode: "cloudToLocal",
			// target.txt exists on BOTH sides so the strict mirror keeps it (a local-only target would be
			// mirror-deleted, leaving the symlink dangling — a test artifact, not the behavior under test).
			initialRemote: { "/projects/a.txt": "A", "/projects/b.txt": "B", "/target.txt": "T" },
			initialLocal: { "/local/target.txt": "T" },
			steps: [
				runCycle(),
				control(world => {
					rmLocal(world, "projects")
					world.vfs.ifs.symlinkSync("/local/target.txt", "/local/projects")
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote subtree is left intact and the engine never wedges trying to write under the local symlink.
		expect(result.finalRemote["/projects/a.txt"]).toMatchObject({ type: "file", size: "A".length })
		expect(result.finalRemote["/projects/b.txt"]).toMatchObject({ type: "file", size: "B".length })
		expect(taskErrorCount(result.messages)).toBe(0)
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("SL7: a remote child deleted under a locally-symlinked folder is not propagated as a local delete (no error)", async () => {
		const result = await runScenario({
			name: "SL7",
			mode: "twoWay",
			initialLocal: { "/local/projects/a.txt": "A", "/local/projects/b.txt": "B", "/local/target.txt": "T" },
			steps: [
				runCycle(),
				// Replace the synced folder with a symlink, THEN another device deletes one child remotely.
				control(world => {
					rmLocal(world, "projects")
					world.vfs.ifs.symlinkSync("/local/target.txt", "/local/projects")
					world.triggerWatcher()
				}),
				remoteMutate(world => world.cloud.controls.trashPath("/projects/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote deletion of a hidden descendant must not error or wedge; the surviving child stays.
		expect(result.finalRemote["/projects/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/projects/b.txt"]).toMatchObject({ type: "file", size: "B".length })
		expect(taskErrorCount(result.messages)).toBe(0)
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
