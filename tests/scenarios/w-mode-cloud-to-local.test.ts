import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, restart } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, transferOps } from "../harness/snapshot"
import { writeLocalAt, readLocal, existsLocal } from "../harness/mutations"

/**
 * Category W — the FULL cloudToLocal operation matrix, the mirror image of Category U. cloudToLocal is a
 * strict one-way MIRROR with the REMOTE authoritative; the local side is forced to match it every cycle:
 *   • remote adds / modifies / deletes / renames / moves / type-changes all propagate down to local;
 *   • a local-only item is mirror-DELETED (it is not on the remote);
 *   • a foreign LOCAL edit to a synced file is REVERTED — remote is re-downloaded over it (F6);
 *   • a remote change always wins, even against a newer-mtime foreign local edit (F5);
 *   • local is never pushed up to the remote.
 * The worlds CONVERGE (finalLocal === finalRemote) once settled. Contrast with cloudBackup (Category X),
 * which is additive: it never deletes the local copy and tolerates local edits.
 */
const SECOND = 1000

describe("Category W — cloudToLocal (strict mirror remote→local)", () => {
	it("W1: remote files and directories are downloaded to local", async () => {
		const result = await runScenario({
			name: "W1",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "alpha", "/dir/b.txt": "bravo", "/dir/empty": null },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(existsLocal(result.world, "a.txt")).toBe(true)
		expect(readLocal(result.world, "dir/b.txt")).toBe("bravo")
		expect(result.finalLocal["/dir/empty"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W2: a remote modification is pulled down to local", async () => {
		const result = await runScenario({
			name: "W2",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "v1" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "v2-longer", { mtimeMs: BASE_TIME + 5 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("download")
		expect(readLocal(result.world, "a.txt")).toBe("v2-longer")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W3: a remote file deletion is mirrored to local", async () => {
		const result = await runScenario({
			name: "W3",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "data" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.trashPath("/a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("deleteLocalFile")
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W4: a remote directory deletion mirrors as ONE collapsed local delete", async () => {
		const result = await runScenario({
			name: "W4",
			mode: "cloudToLocal",
			initialRemote: { "/dir/a.txt": "a", "/dir/sub/c.txt": "c" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.trashPath("/dir")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		expect(kinds.filter(kind => kind === "deleteLocalDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("deleteLocalFile")
		expect(result.finalLocal["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W5: a remote file rename is mirrored as a local rename (no re-download)", async () => {
		const result = await runScenario({
			name: "W5",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "data" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameLocalFile")
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("download")
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W6: a remote directory rename mirrors as ONE collapsed local rename", async () => {
		const result = await runScenario({
			name: "W6",
			mode: "cloudToLocal",
			initialRemote: { "/dir/a.txt": "a", "/dir/b.txt": "b" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		expect(kinds.filter(kind => kind === "renameLocalDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("download")
		expect(result.finalLocal["/dir"]).toBeUndefined()
		expect(result.finalLocal["/dir2/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W7: a remote cross-directory move is mirrored to local", async () => {
		const result = await runScenario({
			name: "W7",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "data", "/sub/keep.txt": "k" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/sub/a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameLocalFile")
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/sub/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W8: a remote directory→file type change replaces the local tree with the file", async () => {
		const result = await runScenario({
			name: "W8",
			mode: "cloudToLocal",
			initialRemote: { "/x/inner.txt": "inner" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/x")
					world.cloud.controls.addFile("/x", "now-a-file")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/x"]).toMatchObject({ type: "file", size: "now-a-file".length })
		expect(result.finalLocal["/x/inner.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W9: a local-only file is mirror-DELETED (not pushed, not kept)", async () => {
		const result = await runScenario({
			name: "W9",
			mode: "cloudToLocal",
			initialLocal: { "/local/local-only.txt": "mine" },
			initialRemote: { "/r.txt": "remote" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[0]!.messages)).toContain("deleteLocalFile")
		expect(result.finalLocal["/local-only.txt"]).toBeUndefined()
		expect(result.finalLocal["/r.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W10: a local-only directory subtree is mirror-DELETED", async () => {
		const result = await runScenario({
			name: "W10",
			mode: "cloudToLocal",
			initialLocal: { "/local/localdir/x.txt": "x", "/local/localdir/sub/y.txt": "y" },
			initialRemote: { "/r.txt": "remote" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalLocal["/localdir"]).toBeUndefined()
		expect(result.finalLocal["/localdir/x.txt"]).toBeUndefined()
		expect(result.finalLocal["/r.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W11: a foreign local edit to a synced file is REVERTED by re-downloading the remote (F6)", async () => {
		const result = await runScenario({
			name: "W11",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "remote-content" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-EDIT", BASE_TIME + 9 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("download")
		expect(readLocal(result.world, "a.txt")).toBe("remote-content")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W12: a remote edit wins over a newer-mtime foreign local edit (F5)", async () => {
		const result = await runScenario({
			name: "W12",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "orig" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-EDIT", { mtimeMs: BASE_TIME + 3 * SECOND })),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-NEWER", BASE_TIME + 9 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		expect(readLocal(result.world, "a.txt")).toBe("REMOTE-EDIT")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W13: a 0-byte remote file is mirrored to local", async () => {
		const result = await runScenario({
			name: "W13",
			mode: "cloudToLocal",
			initialRemote: { "/empty.txt": "", "/nonempty.txt": "x" },
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalLocal["/empty.txt"]).toMatchObject({ type: "file", size: 0 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W14: a local-only file is deleted WHILE a new remote file downloads in the same cycle", async () => {
		const result = await runScenario({
			name: "W14",
			mode: "cloudToLocal",
			initialLocal: { "/local/local-only.txt": "mine" },
			initialRemote: { "/keep.txt": "keep" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.addFile("/added.txt", "added", { mtimeMs: BASE_TIME + 3 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/local-only.txt"]).toBeUndefined()
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/added.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W15: a settled cloudToLocal is idempotent and survives a restart with no work", async () => {
		const result = await runScenario({
			name: "W15",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "alpha", "/dir/b.txt": "bravo" },
			steps: [runCycle(), runCycle(), restart(), runCycle(), runCycle()]
		})

		expect(transferOps(result.cycles[2]!.messages)).toEqual([])
		expect(transferOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W17: a local stray at a remote path (no base, newer mtime, differing size) is overwritten by the remote (F9)", async () => {
		const result = await runScenario({
			name: "W17",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "authoritative-remote" },
			steps: [
				// A local stray appears at the same path BEFORE the first sync, with a NEWER mtime — so there
				// is no base and the mtime tiebreak favors local. Only the size-divergence rule (F9) lets the
				// authoritative remote win and pull its copy down over the stray.
				localMutate(world => writeLocalAt(world, "a.txt", "X", BASE_TIME + 9 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		expect(readLocal(result.world, "a.txt")).toBe("authoritative-remote")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("W16: a long-lived run of varied remote edits stays converged each settle", async () => {
		const result = await runScenario({
			name: "W16",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "a0", "/d/b.txt": "b0" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "a1-edit", { mtimeMs: BASE_TIME + 2 * SECOND })),
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/d/b.txt", "/d/b2.txt")),
				runCycle(),
				remoteMutate(world => world.cloud.controls.addFile("/d/c.txt", "c0", { mtimeMs: BASE_TIME + 3 * SECOND })),
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/d/b2.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/d/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(transferOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
