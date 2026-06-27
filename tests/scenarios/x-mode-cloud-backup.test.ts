import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, restart } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, transferOps } from "../harness/snapshot"
import { writeLocalAt, readLocal, existsLocal } from "../harness/mutations"

/**
 * Category X — the FULL cloudBackup operation matrix, the mirror image of Category V. cloudBackup pulls
 * the remote side down but is ADDITIVE, not a mirror: it NEVER deletes the local copy and deliberately
 * TOLERATES foreign local edits. Contrast with cloudToLocal (Category W), which mirror-deletes and
 * reverts foreign local edits.
 *   • remote adds / modifies / renames / moves / type-changes propagate down;
 *   • a remote DELETE does NOT propagate — the local copy is kept;
 *   • a local-only item SURVIVES (not deleted, not pushed);
 *   • a foreign local edit to a synced file is left ALONE (tolerated);
 *   • a remote change still always wins for the files it touches (F5).
 */
const SECOND = 1000

describe("Category X — cloudBackup (additive pull remote→local)", () => {
	it("X1: a new remote file is downloaded to local", async () => {
		const result = await runScenario({
			name: "X1",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "data", "/dir/b.txt": "b" },
			steps: [runCycle(), runCycle()]
		})

		expect(readLocal(result.world, "a.txt")).toBe("data")
		expect(existsLocal(result.world, "dir/b.txt")).toBe(true)
	})

	it("X2: a remote modification is pulled down to local", async () => {
		const result = await runScenario({
			name: "X2",
			mode: "cloudBackup",
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
	})

	it("X3: a remote file deletion does NOT propagate — the local copy is kept", async () => {
		const result = await runScenario({
			name: "X3",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "data" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.trashPath("/a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.messages)).not.toContain("deleteLocalFile")
		expect(existsLocal(result.world, "a.txt")).toBe(true)
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(transferOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("X4: deleting a whole remote directory does NOT propagate — the local tree is kept", async () => {
		const result = await runScenario({
			name: "X4",
			mode: "cloudBackup",
			initialRemote: { "/dir/a.txt": "a", "/dir/sub/c.txt": "c" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.trashPath("/dir")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.messages)).not.toContain("deleteLocalDirectory")
		expect(transferKinds(result.messages)).not.toContain("deleteLocalFile")
		expect(existsLocal(result.world, "dir/a.txt")).toBe(true)
		expect(existsLocal(result.world, "dir/sub/c.txt")).toBe(true)
	})

	it("X5: a remote rename propagates as a local rename (the move follows; no data lost)", async () => {
		const result = await runScenario({
			name: "X5",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "data" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameLocalFile")
		expect(existsLocal(result.world, "b.txt")).toBe(true)
		expect(existsLocal(result.world, "a.txt")).toBe(false)
	})

	it("X6: a remote cross-directory move propagates to local", async () => {
		const result = await runScenario({
			name: "X6",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "data", "/sub/keep.txt": "k" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/sub/a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("renameLocalFile")
		expect(existsLocal(result.world, "sub/a.txt")).toBe(true)
		expect(existsLocal(result.world, "a.txt")).toBe(false)
	})

	it("X7: a local-only file SURVIVES (additive — not deleted, not pushed)", async () => {
		const result = await runScenario({
			name: "X7",
			mode: "cloudBackup",
			initialLocal: { "/local/mine.txt": "mine" },
			initialRemote: { "/r.txt": "remote" },
			steps: [runCycle(), runCycle()]
		})

		expect(transferKinds(result.messages)).not.toContain("deleteLocalFile")
		expect(existsLocal(result.world, "mine.txt")).toBe(true)
		expect(existsLocal(result.world, "r.txt")).toBe(true)
		// Not pushed to the remote.
		expect(result.finalRemote["/mine.txt"]).toBeUndefined()
	})

	it("X8: a foreign local edit to a synced file is TOLERATED (not reverted)", async () => {
		const result = await runScenario({
			name: "X8",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "remote-content" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-EDIT", BASE_TIME + 9 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		// No download to revert it (the cycles after the foreign edit do nothing); the local copy keeps it.
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("download")
		expect(transferKinds(result.cycles[2]!.messages)).not.toContain("download")
		expect(readLocal(result.world, "a.txt")).toBe("LOCAL-EDIT")
	})

	it("X9: a remote edit wins over a newer-mtime foreign local edit (F5)", async () => {
		const result = await runScenario({
			name: "X9",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "orig" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-EDIT", { mtimeMs: BASE_TIME + 3 * SECOND })),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-NEWER", BASE_TIME + 9 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("download")
		expect(readLocal(result.world, "a.txt")).toBe("REMOTE-EDIT")
	})

	it("X10: a remote file→directory type change replaces the local file with the directory", async () => {
		const result = await runScenario({
			name: "X10",
			mode: "cloudBackup",
			initialRemote: { "/x": "a-file" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/x")
					world.cloud.controls.addFile("/x/inner.txt", "inner")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/x"]).toMatchObject({ type: "directory" })
		expect(existsLocal(result.world, "x/inner.txt")).toBe(true)
	})

	it("X11: a 0-byte remote file is backed up to local", async () => {
		const result = await runScenario({
			name: "X11",
			mode: "cloudBackup",
			initialRemote: { "/empty.txt": "", "/nonempty.txt": "x" },
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalLocal["/empty.txt"]).toMatchObject({ type: "file", size: 0 })
	})

	it("X12: a settled cloudBackup is idempotent across a restart", async () => {
		const result = await runScenario({
			name: "X12",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "alpha", "/dir/b.txt": "bravo" },
			steps: [runCycle(), runCycle(), restart(), runCycle(), runCycle()]
		})

		expect(transferOps(result.cycles[2]!.messages)).toEqual([])
		expect(transferOps(result.cycles[3]!.messages)).toEqual([])
		expect(existsLocal(result.world, "a.txt")).toBe(true)
		expect(existsLocal(result.world, "dir/b.txt")).toBe(true)
	})
})
