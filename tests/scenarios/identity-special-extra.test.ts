import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control, localMutate } from "../harness/runner"
import { messagesOfType } from "../harness/snapshot"
import { writeLocal, rmLocal } from "../harness/mutations"
import { type SyncMessage } from "../../src/types"

/** Total task errors across a message stream — a wedge (re-download/re-upload onto a skipped entry) shows up here. */
function taskErrorCount(messages: SyncMessage[]): number {
	return messagesOfType(messages, "taskErrors").reduce((sum, m) => sum + m.data.errors.length, 0)
}

/**
 * Category IX — identity / special-file edge cases beyond SL (symlink lifecycle) and AU/HL (hardlinks).
 * Pins the shapes the audit flagged: a synced file PERMANENTLY replaced by a symlink (held for many cycles,
 * not healed back like SL3) must keep its cloud copy and never wedge; a DIVERGENT edit to one of two
 * shared-inode paths must re-sync independently; and deleting one of THREE shared-inode paths must leave the
 * others. memfs has no native hardlinks, so the inode collision is forced with `setInode` (as AU/ZD do);
 * symlink targets are kept VALID (the mocked snapshot statSyncs, which would ELOOP/ENOENT on a broken link —
 * the loop + broken-link shapes are covered live where snapshotLocalReal uses lstat). Add-only.
 */
describe("Category IX — identity / special-file edge cases", () => {
	it("IX1: a synced file PERMANENTLY replaced by a symlink keeps its cloud copy across many cycles, no wedge", async () => {
		const result = await runScenario({
			name: "IX1",
			mode: "twoWay",
			initialLocal: { "/local/data.txt": "ORIGINAL", "/local/target.txt": "valid-target", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				control(world => {
					// Replace the synced data.txt with a symlink (to a VALID target so the mocked snapshot's
					// statSync doesn't ENOENT). It must be skipped structurally and never re-fetched onto the link.
					rmLocal(world, "data.txt")
					world.vfs.ifs.symlinkSync("/local/target.txt", "/local/data.txt")
					world.triggerWatcher()
				}),
				// Hold it as a symlink for many cycles — a wedge (re-download onto the link) would error EVERY cycle.
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The cloud copy of the now-symlinked path is PRESERVED (BUG-006: a symlink is ignored, not deleted)…
		expect(result.finalRemote["/data.txt"]).toMatchObject({ type: "file", size: "ORIGINAL".length })
		expect(result.finalRemote["/target.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		// …and no cycle ever wedged trying to write under the symlink.
		expect(taskErrorCount(result.messages)).toBe(0)
		// Idempotent across the sustained symlink phase — the last two cycles did no transfers.
		expect(messagesOfType(result.cycles[result.cycles.length - 1]!.messages, "transfer").length).toBe(0)
	})

	it("IX2: a DIVERGENT edit to one of two shared-inode files re-syncs that file alone", async () => {
		const result = await runScenario({
			name: "IX2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "alpha", "/local/b.txt": "bravo", "/local/keep.txt": "k" },
			steps: [
				control(world => {
					const ino = world.vfs.controls.getInode("/local/a.txt")!
					world.vfs.controls.setInode("/local/b.txt", ino)
				}),
				runCycle(),
				// Edit ONLY b.txt (still reporting a.txt's inode) — the shared-inode collision must not drag a.txt.
				localMutate(world => writeLocal(world, "b.txt", "bravo-EDITED-now-longer")),
				runCycle(),
				runCycle()
			]
		})

		// b.txt re-uploaded with its new bytes; a.txt is untouched; nothing lost.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "bravo-EDITED-now-longer".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "alpha".length })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("IX3: deleting ONE of three shared-inode files leaves the other two intact", async () => {
		const result = await runScenario({
			name: "IX3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "same", "/local/b.txt": "same", "/local/c.txt": "same", "/local/keep.txt": "k" },
			steps: [
				control(world => {
					// Force all three onto one inode (a 3-way hardlink set).
					const ino = world.vfs.controls.getInode("/local/a.txt")!
					world.vfs.controls.setInode("/local/b.txt", ino)
					world.vfs.controls.setInode("/local/c.txt", ino)
				}),
				runCycle(),
				localMutate(world => rmLocal(world, "b.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Only the deleted link is gone; the surviving two links + the unrelated file remain.
		expect(result.finalRemote["/b.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
