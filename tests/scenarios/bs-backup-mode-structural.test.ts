import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, writeLocalAt } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category BS — STRUCTURAL changes under the ADDITIVE backup modes (localBackup / cloudBackup) racing a
 * foreign change on the target side. V/X/ATC pin single-op tolerance (foreign edits/type-changes are kept);
 * this pins a RENAME composed with a foreign change, where the "never delete the target" promise shapes the
 * outcome. Backup modes only detect ONE side's renames (localBackup the local side, cloudBackup the remote),
 * so the cross-side rebase never fires here — the interesting property is that the originated rename
 * propagates WITHOUT the additive side deleting the foreign content (the sides may legitimately diverge).
 */
const SECOND = 1000

describe("Category BS — backup-mode structural change vs foreign target change", () => {
	it("BS1: localBackup — local dir rename propagates; a foreign remote-only file is NOT deleted", async () => {
		const result = await runScenario({
			name: "BS1",
			mode: "localBackup",
			initialLocal: { "/local/dir/a.txt": "A", "/local/keep.txt": "k" },
			steps: [
				runCycle(), // push local → remote (additive)
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.addFile("/remoteOnly.txt", "FOREIGN")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The local rename propagates to the remote…
		expect(result.finalRemote["/dir2/a.txt"]).toMatchObject({ type: "file", size: "A".length })
		expect(result.finalRemote["/dir/a.txt"]).toBeUndefined()
		// …and the foreign remote-only file is preserved (localBackup never deletes the remote target).
		expect(result.finalRemote["/remoteOnly.txt"]).toMatchObject({ type: "file", size: "FOREIGN".length })
		// It is NOT pulled down locally (additive push is one-way).
		expect(result.finalLocal["/remoteOnly.txt"]).toBeUndefined()
		expect(result.finalLocal["/dir2/a.txt"]).toMatchObject({ type: "file" })
	})

	it("BS2: localBackup — local renames a→b while remote foreign-edits a → b is pushed, the foreign a survives", async () => {
		const result = await runScenario({
			name: "BS2",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "ORIG" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "FOREIGN-EDIT", { mtimeMs: BASE_TIME + 100 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The renamed file is pushed to its new name; the foreign edit at the old name is never deleted
		// (additive), so the remote keeps both — the local copy has only the new name.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "ORIG".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "FOREIGN-EDIT".length })
		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file", size: "ORIG".length })
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
	})

	it("BS3: cloudBackup — remote dir rename propagates; a foreign local-only file is NOT deleted", async () => {
		const result = await runScenario({
			name: "BS3",
			mode: "cloudBackup",
			initialRemote: { "/dir/a.txt": "A", "/keep.txt": "k" },
			steps: [
				runCycle(), // pull remote → local (additive)
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				localMutate(world => writeLocalAt(world, "localOnly.txt", "FOREIGN", BASE_TIME + 100 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote rename is pulled locally…
		expect(result.finalLocal["/dir2/a.txt"]).toMatchObject({ type: "file", size: "A".length })
		expect(result.finalLocal["/dir/a.txt"]).toBeUndefined()
		// …and the foreign local-only file is preserved (cloudBackup never deletes the local target).
		expect(result.finalLocal["/localOnly.txt"]).toMatchObject({ type: "file", size: "FOREIGN".length })
		// It is NOT pushed up to the remote (additive pull is one-way).
		expect(result.finalRemote["/localOnly.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir2/a.txt"]).toMatchObject({ type: "file" })
	})

	it("BS4: cloudBackup — remote renames a→b while local foreign-edits a → b is pulled, the foreign local a survives", async () => {
		const result = await runScenario({
			name: "BS4",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "ORIG" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				localMutate(world => writeLocalAt(world, "a.txt", "FOREIGN-LOCAL-EDIT", BASE_TIME + 100 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The renamed file is pulled to its new name; the foreign local edit at the old name is never
		// deleted (additive), so the local keeps both — the remote copy has only the new name.
		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file", size: "ORIG".length })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "FOREIGN-LOCAL-EDIT".length })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "ORIG".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
	})
})
