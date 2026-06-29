import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotRemoteReal, snapshotLocalReal } from "./harness/assert"
import { writeLocal, renameLocal, rmLocal, mkdirLocal, modifyLocal, symlinkLocal, linkLocal, uploadRemote, deleteRemote, renameRemote, renameRemoteDir } from "./harness/mutations"
import { type SyncMessage } from "../../src/types"

/**
 * Phase 4 e2e — live-backend parity for the hardening round (ZW / RT / ZA / ATC / ZX / ZY / SL).
 *
 * These validate, against the REAL local filesystem + Filen backend, the three engine fixes this round
 * landed (all mocked-proven first):
 *   - ZW: a file/dir moved INTO a directory the other device renamed in the same window must NOT duplicate
 *     (the rename-destination rebase). Validated live with a local move into a remotely-renamed dir.
 *   - ATC: additive backup modes TOLERATE a foreign file⇄dir type change (never revert/delete the target).
 *   - SL: replacing a synced FOLDER with a symlink keeps the cloud subtree and never wedges (re-download).
 * plus the mirror-revert (ZA), rename-vs-type-change keep-both (RT), mode-switch authority (ZX), and the
 * no-base newer-wins reconciliation (ZY) — confirming the fake cloud matched the real backend on each.
 */
function taskErrorCount(messages: SyncMessage[]): number {
	return messages.filter((m): m is Extract<SyncMessage, { type: "taskErrors" }> => m.type === "taskErrors").reduce((sum, m) => sum + m.data.errors.length, 0)
}

describe.skipIf(!E2E_ENABLED)("E2E — hardening-round parity (ZW/RT/ZA/ATC/ZX/ZY/SL)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 900_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("ZW-live: a local file moved INTO a remotely-renamed directory converges with no duplicate", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/keep.txt", "k")
			await writeLocal(world, "outside.txt", "OUT")
			await settle(world)

			// Remote renames the dir; locally we move a root file INTO it (its old name) in the same window.
			await renameRemoteDir(world, "dir", "dir2")
			await renameLocal(world, "outside.txt", "dir/inside.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir2/inside.txt"]).toMatchObject({ type: "file", size: "OUT".length })
			expect(remote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
			// No duplicate copy and no resurrected old directory.
			expect(remote["/dir/inside.txt"]).toBeUndefined()
			expect(remote["/outside.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 900_000)

	it("ZW-live: a local SUBDIRECTORY moved INTO a remotely-renamed directory converges with no duplicate", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/keep.txt", "k")
			await writeLocal(world, "sub/child.txt", "C")
			await settle(world)

			await renameRemoteDir(world, "dir", "dir2")
			await renameLocal(world, "sub", "dir/sub")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir2/sub/child.txt"]).toMatchObject({ type: "file", size: "C".length })
			expect(remote["/dir/sub/child.txt"]).toBeUndefined()
			expect(remote["/sub/child.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 900_000)

	it("ZW-live: a local dir rename + a remote same-dir child rename converges keeping the renamed child", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/a.txt", "AAA")
			await writeLocal(world, "dir/keep.txt", "k")
			await settle(world)

			await renameLocal(world, "dir", "dir2")
			await renameRemote(world, "dir/a.txt", "dir/b.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir2/b.txt"]).toMatchObject({ type: "file", size: "AAA".length })
			expect(remote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir2/a.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 900_000)

	it("ATC-live: localBackup TOLERATES a foreign remote file→directory (cloud folder kept, local file kept)", async () => {
		await withE2EWorld({ sdk, mode: "localBackup" }, async world => {
			await writeLocal(world, "report.txt", "AAA")
			await settle(world)

			// Another device turns the backed-up file into a directory; the local file is untouched.
			await deleteRemote(world, "report.txt")
			await uploadRemote(world, "report.txt/x.txt", "C")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			// The foreign cloud directory + child survive (additive never deletes the target)…
			expect(remote["/report.txt"]).toMatchObject({ type: "directory" })
			expect(remote["/report.txt/x.txt"]).toMatchObject({ type: "file" })
			// …and the local file is left untouched (the sides diverge — that is the tolerance).
			expect(local["/report.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		})
	}, 900_000)

	it("ATC-live: cloudBackup TOLERATES a foreign local file→directory (local folder kept, remote file kept)", async () => {
		await withE2EWorld({ sdk, mode: "cloudBackup" }, async world => {
			await uploadRemote(world, "report.txt", "AAA")
			await settle(world)

			// The user locally turns the backed-up file into a directory; the remote file is untouched.
			await rmLocal(world, "report.txt")
			await mkdirLocal(world, "report.txt")
			await writeLocal(world, "report.txt/x.txt", "C")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			expect(local["/report.txt"]).toMatchObject({ type: "directory" })
			expect(local["/report.txt/x.txt"]).toMatchObject({ type: "file" })
			expect(remote["/report.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		})
	}, 900_000)

	it("ZA-live: cloudToLocal REVERTS a foreign local file→directory back to the remote file", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "a.txt", "AAA")
			await settle(world)

			await rmLocal(world, "a.txt")
			await mkdirLocal(world, "a.txt")
			await writeLocal(world, "a.txt/child.txt", "C")
			await settle(world)

			const local = await snapshotLocalReal(world)

			// Strict mirror: the foreign local directory is reverted to the authoritative remote file.
			expect(local["/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
			expect(local["/a.txt/child.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 900_000)

	it("RT-live: a local file rename racing a remote file→directory keeps BOTH", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "AAA")
			await settle(world)

			await renameLocal(world, "a.txt", "b.txt")
			await deleteRemote(world, "a.txt")
			await uploadRemote(world, "a.txt/child.txt", "C")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/b.txt"]).toMatchObject({ type: "file", size: "AAA".length })
			expect(remote["/a.txt"]).toMatchObject({ type: "directory" })
			expect(remote["/a.txt/child.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	}, 900_000)

	it("ZX-live: switching twoWay→cloudToLocal reverts a still-pending local edit", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "orig")
			await settle(world)

			// A pending local edit, then the pair becomes a strict cloud→local mirror before it syncs.
			await modifyLocal(world, "a.txt", "LOCAL-EDIT-LONGER")
			world.worker.updateMode(world.syncPair.uuid, "cloudToLocal")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: "orig".length })
			expect(local["/a.txt"]).toMatchObject({ type: "file", size: "orig".length })
		})
	}, 900_000)

	it("ZY-live: no common base, both sides hold the path with divergent content → newer wins", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Seed BOTH sides independently (no prior sync = no base), local clearly newer.
			await uploadRemote(world, "a.txt", "REMOTE")
			await writeLocal(world, "a.txt", "LOCAL-NEWER-CONTENT")
			const future = new Date(Date.now() + 60_000)
			await (await import("fs-extra")).utimes(`${world.localRoot}/a.txt`, future, future)
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// The strictly-newer local copy wins on both sides; nothing duplicated.
			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-NEWER-CONTENT".length })
			await expectConverged(world)
		})
	}, 900_000)

	it("SL-live: replacing a synced FOLDER with a symlink keeps the cloud subtree and never wedges", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "projects/a.txt", "A")
			await writeLocal(world, "projects/b.txt", "B")
			await writeLocal(world, "target.txt", "T")
			await settle(world)

			// Move the real folder away and symlink it back (a common dev reorg). Skip where symlinks are
			// unavailable (e.g. Windows without Developer Mode).
			await rmLocal(world, "projects")
			try {
				await symlinkLocal(world, "projects", `${world.localRoot}/target.txt`)
			} catch {
				return
			}

			const messagesBefore = world.messages.length
			await settle(world)
			const cycleMessages = world.messages.slice(messagesBefore)

			const remote = await snapshotRemoteReal(world)

			// The cloud subtree survives (no silent data loss) and the engine does not wedge on re-download.
			expect(remote["/projects/a.txt"]).toMatchObject({ type: "file", size: "A".length })
			expect(remote["/projects/b.txt"]).toMatchObject({ type: "file", size: "B".length })
			expect(taskErrorCount(cycleMessages)).toBe(0)
		})
	}, 900_000)

	it("SL-live: a settled file→symlink→file round-trip keeps the cloud copy and re-converges", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "doc.txt", "v1")
			await writeLocal(world, "target.txt", "T")
			await settle(world)

			await rmLocal(world, "doc.txt")
			try {
				await symlinkLocal(world, "doc.txt", `${world.localRoot}/target.txt`)
			} catch {
				return
			}
			await settle(world)

			// The cloud copy must survive the symlink phase.
			expect((await snapshotRemoteReal(world))["/doc.txt"]).toMatchObject({ type: "file" })

			// Restore a real file with new content; it must sync.
			await rmLocal(world, "doc.txt")
			await writeLocal(world, "doc.txt", "v2-restored")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			expect(remote["/doc.txt"]).toMatchObject({ type: "file", size: "v2-restored".length })
		})
	}, 900_000)

	it("CC-live: local DELETES a directory while remote RENAMES it → the rename wins (data preserved)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "D/child.txt", "C")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			await rmLocal(world, "D")
			await renameRemoteDir(world, "D", "E")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// Newer data beats a delete: the renamed directory survives at its new path.
			expect(remote["/E/child.txt"]).toMatchObject({ type: "file", size: "C".length })
			expect(remote["/D"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 900_000)

	it("ZW-live: a local MOVE+MODIFY into a remotely-renamed dir keeps the MODIFIED content (real-fs inode preserved)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/keep.txt", "k")
			await writeLocal(world, "outside.txt", "ORIG")
			await settle(world)

			// On a real fs, move (rename) + in-place modify PRESERVES the inode+birthtime, so the engine sees a
			// rename+modify (F1) — not a delete+add (memfs replaces the inode, so the mock can't reach this).
			await renameLocal(world, "outside.txt", "dir/inside.txt")
			await modifyLocal(world, "dir/inside.txt", "MODIFIED-AFTER-MOVE-LONGER")
			await renameRemoteDir(world, "dir", "dir2")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// The MODIFIED content (not the pre-move ORIG) must land at the renamed-dir path.
			expect(remote["/dir2/inside.txt"]).toMatchObject({ type: "file", size: "MODIFIED-AFTER-MOVE-LONGER".length })
			expect(remote["/dir/inside.txt"]).toBeUndefined()
			expect(remote["/outside.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 900_000)

	it("HL-live: renaming one of two REAL hardlinks keeps both links and converges (no dropped file)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "shared-hardlink-content")
			// A genuine hardlink: same inode, identical bytes (skip where the FS forbids hardlinks).
			try {
				await linkLocal(world, "a.txt", "b.txt")
			} catch {
				return
			}
			await settle(world)

			await renameLocal(world, "a.txt", "c.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// Neither link is dropped; the old name is gone; both surviving links carry the shared content.
			expect(remote["/c.txt"]).toMatchObject({ type: "file", size: "shared-hardlink-content".length })
			expect(remote["/b.txt"]).toMatchObject({ type: "file", size: "shared-hardlink-content".length })
			expect(remote["/a.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 900_000)
})
