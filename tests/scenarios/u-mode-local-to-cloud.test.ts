import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, restart } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, allOps } from "../harness/snapshot"
import { writeLocal, writeLocalAt, rmLocal, renameLocal, readLocal } from "../harness/mutations"

/**
 * Category U — the FULL localToCloud operation matrix. localToCloud is a strict one-way MIRROR: the
 * local side is authoritative and the remote is forced to match it every cycle. So:
 *   • local adds / modifies / deletes / renames / moves / type-changes all propagate to the remote;
 *   • a remote-only item (added by another device) is mirror-DELETED (it is not in local);
 *   • a foreign edit to a synced file is REVERTED — local re-asserts its bytes (F6);
 *   • a local change always wins, even against a newer-mtime foreign remote edit (F5);
 *   • the remote is never pulled down to local.
 * Because it is a true mirror, the worlds CONVERGE (finalLocal === finalRemote) once settled. Contrast
 * with localBackup (Category V), which is additive: it never deletes the remote and tolerates foreign
 * edits.
 */
const SECOND = 1000

describe("Category U — localToCloud (strict mirror local→remote)", () => {
	it("U1: local files and directories are created on the remote", async () => {
		const result = await runScenario({
			name: "U1",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "alpha", "/local/dir/b.txt": "bravo", "/local/dir/empty": null },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "alpha".length })
		expect(result.finalRemote["/dir"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/dir/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/empty"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U2: a local modification is pushed to the remote", async () => {
		const result = await runScenario({
			name: "U2",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [runCycle(), localMutate(world => writeLocalAt(world, "a.txt", "v2-longer", BASE_TIME + 5 * SECOND)), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "v2-longer".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U3: a local file deletion is mirrored to the remote", async () => {
		const result = await runScenario({
			name: "U3",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "data" },
			steps: [runCycle(), localMutate(world => rmLocal(world, "a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("deleteRemoteFile")
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U4: a local directory deletion mirrors as ONE collapsed remote delete", async () => {
		const result = await runScenario({
			name: "U4",
			mode: "localToCloud",
			initialLocal: { "/local/dir/a.txt": "a", "/local/dir/sub/c.txt": "c" },
			steps: [runCycle(), localMutate(world => rmLocal(world, "dir")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		expect(kinds.filter(kind => kind === "deleteRemoteDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("deleteRemoteFile")
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U5: a local file rename is mirrored as a remote rename (identity preserved)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "U5",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "data" },
			steps: [
				runCycle(),
				localMutate(world => {
					originalUUID = world.cloud.controls.getByPath("/a.txt")?.uuid
					renameLocal(world, "a.txt", "b.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		// The rename cycle does NOT re-upload (identity is preserved, not re-created).
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("upload")
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.world.cloud.controls.getByPath("/b.txt")?.uuid).toBe(originalUUID)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U6: a local directory rename mirrors as ONE collapsed remote rename", async () => {
		const result = await runScenario({
			name: "U6",
			mode: "localToCloud",
			initialLocal: { "/local/dir/a.txt": "a", "/local/dir/b.txt": "b" },
			steps: [runCycle(), localMutate(world => renameLocal(world, "dir", "dir2")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("upload")
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir2/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U7: a local cross-directory move is mirrored to the remote (identity preserved)", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "U7",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "data", "/local/sub/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					originalUUID = world.cloud.controls.getByPath("/a.txt")?.uuid
					renameLocal(world, "a.txt", "sub/a.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/sub/a.txt"]).toMatchObject({ type: "file" })
		expect(result.world.cloud.controls.getByPath("/sub/a.txt")?.uuid).toBe(originalUUID)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U8: a local directory→file type change replaces the remote tree with the file", async () => {
		const result = await runScenario({
			name: "U8",
			mode: "localToCloud",
			initialLocal: { "/local/x/inner.txt": "inner" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					writeLocal(world, "x", "now-a-file")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x"]).toMatchObject({ type: "file", size: "now-a-file".length })
		expect(result.finalRemote["/x/inner.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U9: a remote-only file is mirror-DELETED (not pulled, not kept)", async () => {
		const result = await runScenario({
			name: "U9",
			mode: "localToCloud",
			initialLocal: { "/local/mine.txt": "mine" },
			initialRemote: { "/foreign.txt": "theirs" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[0]!.messages)).toContain("deleteRemoteFile")
		expect(result.finalRemote["/foreign.txt"]).toBeUndefined()
		expect(result.finalRemote["/mine.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U10: a remote-only directory subtree is mirror-DELETED", async () => {
		const result = await runScenario({
			name: "U10",
			mode: "localToCloud",
			initialLocal: { "/local/mine.txt": "mine" },
			initialRemote: { "/foreigndir/x.txt": "x", "/foreigndir/sub/y.txt": "y" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/foreigndir"]).toBeUndefined()
		expect(result.finalRemote["/foreigndir/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/mine.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U11: a foreign remote edit to a synced file is REVERTED to the local content (F6)", async () => {
		const result = await runScenario({
			name: "U11",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "local-content" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "FOREIGN-EDIT", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "local-content".length })
		expect(readLocal(result.world, "a.txt")).toBe("local-content")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U12: a local edit wins over a newer-mtime foreign remote edit (F5)", async () => {
		const result = await runScenario({
			name: "U12",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "orig" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-EDIT", BASE_TIME + 3 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-NEWER", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-EDIT".length })
		expect(readLocal(result.world, "a.txt")).toBe("LOCAL-EDIT")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U13: a 0-byte local file is mirrored to the remote", async () => {
		const result = await runScenario({
			name: "U13",
			mode: "localToCloud",
			initialLocal: { "/local/empty.txt": "" },
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/empty.txt"]).toMatchObject({ type: "file", size: 0 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U14: a rename + in-place modify in one cycle keeps the new name AND new content (F1)", async () => {
		const result = await runScenario({
			name: "U14",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "original-content" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "b.txt")
					writeLocalAt(world, "b.txt", "BRAND-NEW-CONTENT", BASE_TIME + 5 * SECOND)
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "BRAND-NEW-CONTENT".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U15: a settled localToCloud is idempotent and survives a restart with no work", async () => {
		const result = await runScenario({
			name: "U15",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "alpha", "/local/dir/b.txt": "bravo" },
			steps: [runCycle(), runCycle(), restart(), runCycle(), runCycle()]
		})

		// The two post-restart cycles do no file transfers.
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(allOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U16: a remote-only file is deleted WHILE a new local file uploads in the same cycle", async () => {
		const result = await runScenario({
			name: "U16",
			mode: "localToCloud",
			initialLocal: { "/local/keep.txt": "keep" },
			initialRemote: { "/foreign.txt": "theirs" },
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "added.txt", "added")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/foreign.txt"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/added.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U18: a remote stray at a local path (no base, newer mtime, differing size) is overwritten by local (F9)", async () => {
		const result = await runScenario({
			name: "U18",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "authoritative-local" },
			steps: [
				// A remote stray appears at the same path BEFORE the first sync, NEWER mtime, different size.
				// Only the size-divergence rule (F9) lets the authoritative local win and push over the stray.
				remoteMutate(world => world.cloud.controls.addFile("/a.txt", "X", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "authoritative-local".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("U17: a long-lived run of varied local edits stays converged each settle", async () => {
		const result = await runScenario({
			name: "U17",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "a0", "/local/d/b.txt": "b0" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "a1-edit", BASE_TIME + 2 * SECOND)),
				runCycle(),
				localMutate(world => renameLocal(world, "d/b.txt", "d/b2.txt")),
				runCycle(),
				localMutate(world => writeLocal(world, "d/c.txt", "c0")),
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/d/b2.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/d/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
