import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { renameLocal } from "../harness/mutations"
import { transferKinds } from "../harness/snapshot"

/**
 * Category HL — RENAMING one of two files that share an inode (a hardlink pair). Category AU pins add +
 * delete of shared-inode files; the unexplored seam is a RENAME of one link, which is what the inode-keyed
 * rename detector is most likely to mis-handle — the shared inode collides in the inode→path map (one slot,
 * two live paths), so the rename can be attributed to the "wrong" path.
 *
 * KEY REALISM POINT: real hardlinks share the SAME bytes (editing/owning one inode), so both links always
 * carry IDENTICAL content. The mock forces the shared inode with `setInode`; these use IDENTICAL content on
 * both links to match a real hardlink. Under that (realistic) condition the inode→path "misfire" is BENIGN:
 * whichever path wins the slot, the content uploaded is the same, so the two sides converge in structure AND
 * content and the sync SETTLES — no file dropped, no data loss, no perpetual churn. (A mtime-only metadata
 * difference can remain — an accepted hardlink limitation, same family as AU; it does not re-transfer because
 * the bytes match.) This pins that graceful degradation; a regression that dropped the other link or churned
 * forever would fail the presence / settle assertions.
 */
const SHARED = "shared-hardlink-content"

/** Did the final settled cycle do any file transfer? (A non-settling churn would be non-empty.) */
function lastCycleTransfers(cycles: { messages: import("../../src/types").SyncMessage[] }[]): string[] {
	return transferKinds(cycles[cycles.length - 1]!.messages).filter(k => ["upload", "download", "uploadFile", "downloadFile"].includes(k))
}

describe("Category HL — rename one of two hardlinked files (shared inode)", () => {
	it("HL1: renaming one link keeps BOTH links, converges in content, and settles (twoWay)", async () => {
		const result = await runScenario({
			name: "HL1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": SHARED, "/local/b.txt": SHARED, "/local/keep.txt": "k" },
			steps: [
				// Force b.txt onto a.txt's inode → a hardlink pair (one inode, identical bytes).
				control(world => {
					const ino = world.vfs.controls.getInode("/local/a.txt")!
					world.vfs.controls.setInode("/local/b.txt", ino)
				}),
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "c.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// No file dropped: the renamed link is at its new path, the other link survives, the old name is gone.
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		// Content converges on both sides for each surviving link (real hardlinks share bytes).
		expect(result.finalLocal["/c.txt"]!.contentHash).toBe(result.finalRemote["/c.txt"]!.contentHash)
		expect(result.finalLocal["/b.txt"]!.contentHash).toBe(result.finalRemote["/b.txt"]!.contentHash)
		// And it SETTLED — no perpetual re-transfer churn from the inode collision.
		expect(lastCycleTransfers(result.cycles)).toEqual([])
	})

	it("HL2: localToCloud mirrors a one-link rename to the cloud, keeps both links, and settles", async () => {
		const result = await runScenario({
			name: "HL2",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": SHARED, "/local/b.txt": SHARED },
			steps: [
				control(world => {
					const ino = world.vfs.controls.getInode("/local/a.txt")!
					world.vfs.controls.setInode("/local/b.txt", ino)
				}),
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "c.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/c.txt"]!.contentHash).toBe(result.finalRemote["/c.txt"]!.contentHash)
		expect(lastCycleTransfers(result.cycles)).toEqual([])
	})
})
