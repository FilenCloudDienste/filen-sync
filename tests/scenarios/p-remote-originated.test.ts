import { describe, it, expect } from "vitest"
import { runScenario, runCycle, remoteMutate, localMutate, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, allOps } from "../harness/snapshot"
import { renameLocal, readLocal, existsLocal } from "../harness/mutations"

/**
 * Category P — remote-originated propagation (the download direction) and cross-directory moves.
 *
 * The bulk of the suite is LOCAL-originated (uploads). This file deliberately drives the cloud→local
 * direction (`mode:"cloudToLocal"`) so the engine has to CREATE/DOWNLOAD/DELETE/RENAME on the local
 * side, plus the local→cloud cross-parent MOVE branches.
 *
 * Cache timing: the previous local/remote trees are observed at cycle START, and a just-downloaded
 * file only enters the previous LOCAL tree on the following scan. So remote-originated mutations are
 * applied after TWO settle cycles (the item is then present in both previous trees), which lands the
 * mutation's propagation in `result.cycles[2]`. Local-originated moves settle in ONE cycle (the local
 * inode is already known), landing in `result.cycles[1]`.
 *
 * Identity: a rename/move keeps the node identity (remote uuid / local inode) — it is NOT a
 * delete+add — and a directory rename/move/delete collapses its children into the single parent op.
 */
const SECOND = 1000

describe("Category P — remote-originated & cross-directory moves", () => {
	// ===== DOWNLOAD direction (cloudToLocal) =====

	it("P1: a new remote file downloads to local with its content (downloadFile)", async () => {
		const result = await runScenario({
			name: "P1",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": { content: "hello-remote", mtimeMs: BASE_TIME + 1 * SECOND } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[0]!.messages)).toContain("downloadFile")
		expect(result.cycles[0]!.local["/a.txt"]).toMatchObject({ type: "file", size: "hello-remote".length })
		// The content actually landed on disk, not just a tree entry.
		expect(readLocal(result.world, "a.txt")).toBe("hello-remote")
		// Idempotence: no further transfers once converged.
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("P2: a remote directory tree creates the local dirs and downloads its files", async () => {
		const result = await runScenario({
			name: "P2",
			mode: "cloudToLocal",
			initialRemote: {
				"/sub/a.txt": { content: "A", mtimeMs: BASE_TIME + 1 * SECOND },
				"/sub/deep/b.txt": { content: "B", mtimeMs: BASE_TIME + 2 * SECOND }
			},
			steps: [runCycle(), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[0]!.messages)

		// Both the intermediate directory and the nested directory are created locally…
		expect(kinds).toContain("createLocalDirectory")
		// …and the files are downloaded (not the dirs masquerading as files).
		expect(kinds).toContain("downloadFile")

		expect(result.finalLocal["/sub"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/sub/deep"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/sub/a.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalLocal["/sub/deep/b.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(readLocal(result.world, "sub/deep/b.txt")).toBe("B")
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("P3: deleting a remote file deletes the local copy (to .filen.trash.local)", async () => {
		const result = await runScenario({
			name: "P3",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": { content: "content", mtimeMs: BASE_TIME + 1 * SECOND } },
			steps: [
				runCycle(),
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[2]!.messages)).toContain("deleteLocalFile")
		// Gone from the synced tree on both sides…
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		// …but moved to the local trash (no data loss), not hard-deleted.
		expect(existsLocal(result.world, ".filen.trash.local/a.txt")).toBe(true)
		expect(allOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("P4: deleting a remote directory subtree emits ONE local delete (children collapsed)", async () => {
		const result = await runScenario({
			name: "P4",
			mode: "cloudToLocal",
			initialRemote: {
				"/d/a.txt": { content: "a", mtimeMs: BASE_TIME + 1 * SECOND },
				"/d/deep/b.txt": { content: "b", mtimeMs: BASE_TIME + 2 * SECOND }
			},
			steps: [
				runCycle(),
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/d")),
				runCycle(),
				runCycle()
			]
		})

		const kinds = transferKinds(result.cycles[2]!.messages)

		// Exercises local.ts' subtree cache-prune loop + the deltas collapse: only the parent dir is
		// deleted, the per-child deletes are collapsed away.
		expect(kinds.filter(kind => kind === "deleteLocalDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("deleteLocalFile")

		expect(result.finalLocal["/d"]).toBeUndefined()
		expect(result.finalLocal["/d/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/d/deep/b.txt"]).toBeUndefined()
		expect(allOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// ===== RENAME / MOVE direction =====

	it("P5: a remote file rename renames the local copy (same identity, no re-download)", async () => {
		let originalUUID: string | undefined
		let originalInode: number | null = null

		const result = await runScenario({
			name: "P5",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": { content: "content", mtimeMs: BASE_TIME + 1 * SECOND } },
			steps: [
				runCycle(),
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/a.txt")?.uuid
					originalInode = world.vfs.controls.getInode("/local/a.txt")
				}),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[2]!.messages)).toContain("renameLocalFile")
		// A rename is not a transfer: the content is not re-downloaded.
		expect(transferKinds(result.cycles[2]!.messages)).not.toContain("downloadFile")

		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file", size: "content".length })
		expect(readLocal(result.world, "b.txt")).toBe("content")

		// The remote node kept its uuid (a move, not a re-create)…
		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/b.txt")?.uuid).toBe(originalUUID)
		// …and the LOCAL file kept its inode (renamed in place, not deleted+re-downloaded).
		expect(originalInode).not.toBeNull()
		expect(result.world.vfs.controls.getInode("/local/b.txt")).toBe(originalInode)

		expect(allOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("P6: a remote directory rename renames the subtree locally (ONE op, children reparented)", async () => {
		const result = await runScenario({
			name: "P6",
			mode: "cloudToLocal",
			initialRemote: {
				"/d/a.txt": { content: "a", mtimeMs: BASE_TIME + 1 * SECOND },
				"/d/deep/b.txt": { content: "b", mtimeMs: BASE_TIME + 2 * SECOND }
			},
			steps: [
				runCycle(),
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/d", "/e")),
				runCycle(),
				runCycle()
			]
		})

		const kinds = transferKinds(result.cycles[2]!.messages)

		// Exercises local.ts' subtree reparent loop + the deltas collapse: one parent rename carries
		// the whole subtree — no per-child renames and (crucially) no re-downloads.
		expect(kinds.filter(kind => kind === "renameLocalDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("renameLocalFile")
		expect(kinds).not.toContain("downloadFile")

		expect(result.finalLocal["/d"]).toBeUndefined()
		expect(result.finalLocal["/d/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/e"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/e/a.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalLocal["/e/deep/b.txt"]).toMatchObject({ type: "file", size: 1 })
		// The children were carried, not re-fetched — content intact.
		expect(readLocal(result.world, "e/deep/b.txt")).toBe("b")
		expect(allOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("P7: a local move into a subdirectory moves the remote node (same uuid, no re-upload)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "P7",
			mode: "twoWay",
			initialLocal: {
				"/local/dir1/a.txt": "content",
				// An already-settled empty destination directory, so the move's mkdir is a no-op.
				"/local/dir2": null
			},
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/dir1/a.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "dir1/a.txt", "dir2/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Move-into-subdir branch of remote.rename (basename unchanged → straight move).
		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("upload")

		expect(result.finalRemote["/dir1/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir2/a.txt"]).toMatchObject({ type: "file", size: "content".length })

		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/dir2/a.txt")?.uuid).toBe(originalUUID)
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("P8: a local move to the sync ROOT moves the remote node (same uuid)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "P8",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "content" },
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/dir/a.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "dir/a.txt", "a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Move-to-root branch of remote.rename.
		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("upload")

		expect(result.finalRemote["/dir/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "content".length })
		// The (now empty) source directory is untouched on both sides.
		expect(result.finalRemote["/dir"]).toMatchObject({ type: "directory" })

		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/a.txt")?.uuid).toBe(originalUUID)
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("P9: a local move that also renames across parents moves the remote node (same uuid)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "P9",
			mode: "twoWay",
			initialLocal: {
				"/local/dir1/a.txt": "content",
				"/local/dir2": null
			},
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/dir1/a.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "dir1/a.txt", "dir2/b.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Rename-then-move branch of remote.rename (basename changes AND parent changes).
		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("upload")

		expect(result.finalRemote["/dir1/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir2/b.txt"]).toMatchObject({ type: "file", size: "content".length })

		expect(originalUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/dir2/b.txt")?.uuid).toBe(originalUUID)
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
