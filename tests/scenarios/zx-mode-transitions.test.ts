import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { writeLocalAt } from "../harness/mutations"
import { allOps, transferKinds } from "../harness/snapshot"

/**
 * Category ZX — switching a pair's SyncMode between cycles. Category I6 pins a single twoWay→localBackup
 * switch; AT pins per-mode structural integrity. The missing shape is an AUTHORITY-direction switch (twoWay
 * ↔ a mirror, or a mirror → an additive backup) while a change is pending, and mode OSCILLATION. The mode is
 * snapshotted once per cycle (deltas.ts), so the cycle AFTER the switch must re-derive the outstanding work
 * entirely under the new mode — these pin that the new policy is what actually runs, and that flipping modes
 * back and forth causes no churn or data loss.
 */
const SECOND = 1000

describe("Category ZX — sync mode transitions", () => {
	it("ZX1: twoWay → cloudToLocal reverts a still-pending foreign LOCAL edit (new authority enforced)", async () => {
		const result = await runScenario({
			name: "ZX1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "orig" },
			steps: [
				runCycle(),
				// A local edit is made but not yet synced; THEN the pair becomes a strict cloud→local mirror.
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-EDIT-LONGER", BASE_TIME + 100 * SECOND)),
				control(world => world.worker.updateMode(world.syncPair.uuid, "cloudToLocal")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// cloudToLocal is now authoritative on the remote: the pending local edit is reverted to the remote copy.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "orig".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "orig".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZX2: twoWay → localToCloud reverts a still-pending foreign REMOTE edit (new authority enforced)", async () => {
		const result = await runScenario({
			name: "ZX2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "orig" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-EDIT-LONGER", { mtimeMs: BASE_TIME + 100 * SECOND })),
				control(world => world.worker.updateMode(world.syncPair.uuid, "localToCloud")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "orig".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "orig".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZX3: localToCloud → twoWay turns a would-be mirror-DELETE of a remote-only file into a DOWNLOAD", async () => {
		const result = await runScenario({
			name: "ZX3",
			mode: "localToCloud",
			initialLocal: { "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				// A remote-only file appears. Under localToCloud the next cycle would mirror-DELETE it; switch
				// to twoWay first so it is instead pulled down and kept.
				remoteMutate(world => world.cloud.controls.addFile("/remote-only.txt", "RO", { mtimeMs: BASE_TIME + 100 * SECOND })),
				control(world => world.worker.updateMode(world.syncPair.uuid, "twoWay")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/remote-only.txt"]).toMatchObject({ type: "file", size: "RO".length })
		expect(result.finalRemote["/remote-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZX4: oscillating twoWay → localToCloud → twoWay on a settled pair causes NO churn and no loss", async () => {
		const result = await runScenario({
			name: "ZX4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "a", "/local/dir/b.txt": "b" },
			steps: [
				runCycle(),
				runCycle(),
				control(world => world.worker.updateMode(world.syncPair.uuid, "localToCloud")),
				runCycle(),
				control(world => world.worker.updateMode(world.syncPair.uuid, "twoWay")),
				runCycle()
			]
		})

		// Each post-switch cycle on an already-settled pair must be a complete no-op.
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(allOps(result.cycles[3]!.messages)).toEqual([])
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/dir/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZX5: cloudToLocal → cloudBackup stops a pending remote DELETE from wiping the local copy", async () => {
		const result = await runScenario({
			name: "ZX5",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "A" },
			steps: [
				runCycle(),
				// Remote deletes the file. Under cloudToLocal the next cycle would mirror-delete it locally;
				// switch to additive cloudBackup first so the local copy is kept.
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				control(world => world.worker.updateMode(world.syncPair.uuid, "cloudBackup")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The local copy survives the remote deletion (additive backup never deletes the target).
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "A".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		// And no cycle ever derived a local deletion for it.
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("deleteLocalFile")
	})
})
