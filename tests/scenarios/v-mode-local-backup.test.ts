import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, restart } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, transferOps } from "../harness/snapshot"
import { writeLocal, writeLocalAt, rmLocal, renameLocal, readLocal } from "../harness/mutations"

/**
 * Category V — the FULL localBackup operation matrix. localBackup pushes the local side up but is
 * ADDITIVE, not a mirror: it NEVER deletes on the remote and deliberately TOLERATES foreign remote edits.
 * Contrast with localToCloud (Category U), which mirror-deletes and reverts foreign edits.
 *   • local adds / modifies / renames / moves / type-changes propagate up;
 *   • a local DELETE does NOT propagate — the remote keeps the file (the whole point of a backup);
 *   • a remote-only item SURVIVES (not deleted, not pulled);
 *   • a foreign remote edit to a synced file is left ALONE (tolerated);
 *   • a local change still always wins for the files it touches (F5), so a backup can't be silently
 *     suppressed by a newer-mtime foreign remote edit.
 * Because deletes don't propagate, the worlds do NOT generally converge — assertions target the
 * specific additive behavior.
 */
const SECOND = 1000

describe("Category V — localBackup (additive push local→remote)", () => {
	it("V1: a new local file is uploaded to the remote", async () => {
		const result = await runScenario({
			name: "V1",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "data", "/local/dir/b.txt": "b" },
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "data".length })
		expect(result.finalRemote["/dir/b.txt"]).toMatchObject({ type: "file" })
	})

	it("V2: a local modification is pushed to the remote", async () => {
		const result = await runScenario({
			name: "V2",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [runCycle(), localMutate(world => writeLocalAt(world, "a.txt", "v2-longer", BASE_TIME + 5 * SECOND)), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "v2-longer".length })
	})

	it("V3: a local file deletion does NOT propagate — the remote keeps the backup", async () => {
		const result = await runScenario({
			name: "V3",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "data" },
			steps: [runCycle(), localMutate(world => rmLocal(world, "a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.messages)).not.toContain("deleteRemoteFile")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "data".length })
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		// And it is idempotent: the last cycle does no work despite the local/remote difference.
		expect(transferOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("V4: deleting a whole local directory does NOT propagate — the remote keeps the tree", async () => {
		const result = await runScenario({
			name: "V4",
			mode: "localBackup",
			initialLocal: { "/local/dir/a.txt": "a", "/local/dir/sub/c.txt": "c" },
			steps: [runCycle(), localMutate(world => rmLocal(world, "dir")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.messages)).not.toContain("deleteRemoteDirectory")
		expect(transferKinds(result.messages)).not.toContain("deleteRemoteFile")
		expect(result.finalRemote["/dir/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/sub/c.txt"]).toMatchObject({ type: "file" })
	})

	it("V5: a local rename propagates as a remote rename (the move follows; no data lost)", async () => {
		const result = await runScenario({
			name: "V5",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "data" },
			steps: [runCycle(), localMutate(world => renameLocal(world, "a.txt", "b.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
	})

	it("V6: a local cross-directory move propagates to the remote", async () => {
		const result = await runScenario({
			name: "V6",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "data", "/local/sub/keep.txt": "k" },
			steps: [runCycle(), localMutate(world => renameLocal(world, "a.txt", "sub/a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameRemoteFile")
		expect(result.finalRemote["/sub/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
	})

	it("V7: a remote-only file SURVIVES (additive — not deleted, not pulled)", async () => {
		const result = await runScenario({
			name: "V7",
			mode: "localBackup",
			initialLocal: { "/local/mine.txt": "mine" },
			initialRemote: { "/foreign.txt": "theirs" },
			steps: [runCycle(), runCycle()]
		})

		expect(transferKinds(result.messages)).not.toContain("deleteRemoteFile")
		expect(result.finalRemote["/foreign.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/mine.txt"]).toMatchObject({ type: "file" })
		// Not pulled to local.
		expect(result.finalLocal["/foreign.txt"]).toBeUndefined()
	})

	it("V8: a foreign remote edit to a synced file is TOLERATED (not reverted)", async () => {
		const result = await runScenario({
			name: "V8",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "local-content" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "FOREIGN-EDIT", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		// No upload to revert it (the cycles after the foreign edit do nothing); the remote keeps the
		// foreign edit and the local copy is untouched.
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("upload")
		expect(transferKinds(result.cycles[2]!.messages)).not.toContain("upload")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "FOREIGN-EDIT".length })
		expect(readLocal(result.world, "a.txt")).toBe("local-content")
	})

	it("V9: a local edit wins over a newer-mtime foreign remote edit (F5)", async () => {
		const result = await runScenario({
			name: "V9",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "orig" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-EDIT", BASE_TIME + 3 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-NEWER", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-EDIT".length })
	})

	it("V10: a local file→directory type change replaces the remote file with the directory", async () => {
		const result = await runScenario({
			name: "V10",
			mode: "localBackup",
			initialLocal: { "/local/x": "a-file" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					writeLocal(world, "x/inner.txt", "inner")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/x/inner.txt"]).toMatchObject({ type: "file" })
	})

	it("V11: a 0-byte local file is backed up", async () => {
		const result = await runScenario({
			name: "V11",
			mode: "localBackup",
			initialLocal: { "/local/empty.txt": "" },
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/empty.txt"]).toMatchObject({ type: "file", size: 0 })
	})

	it("V12: a settled localBackup is idempotent across a restart", async () => {
		const result = await runScenario({
			name: "V12",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "alpha", "/local/dir/b.txt": "bravo" },
			steps: [runCycle(), runCycle(), restart(), runCycle(), runCycle()]
		})

		expect(transferOps(result.cycles[2]!.messages)).toEqual([])
		expect(transferOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/b.txt"]).toMatchObject({ type: "file" })
	})
})
