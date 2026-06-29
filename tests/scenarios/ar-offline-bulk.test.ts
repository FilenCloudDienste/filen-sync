import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, restart } from "../harness/runner"
import { writeLocal, writeLocalAt, rmLocal, renameLocal, mkdirLocal } from "../harness/mutations"

/**
 * Category AR — bulk "offline" accumulation reconciled in a single cycle, including across a restart
 * (twoWay). Many heterogeneous changes pile up with no intervening cycle (as if the app was closed),
 * then one cycle must reconcile them all at once; the restart variant additionally proves the persisted
 * base survives a process restart and the accumulated changes still reconcile correctly. Add-only.
 */
describe("Category AR — offline bulk reconciliation", () => {
	it("AR1: a batch of add/modify/delete/rename/move/mkdir reconciles in one cycle", async () => {
		const result = await runScenario({
			name: "AR1",
			mode: "twoWay",
			initialLocal: {
				"/local/keep.txt": "keep",
				"/local/mod.txt": "old",
				"/local/del.txt": "doomed",
				"/local/ren.txt": "renameme",
				"/local/dir/nested.txt": "nested"
			},
			steps: [
				runCycle(),
				localMutate(world => {
					writeLocal(world, "added.txt", "brand new")
					writeLocalAt(world, "mod.txt", "a-much-longer-modified-body", 1_700_000_900_000)
					rmLocal(world, "del.txt")
					renameLocal(world, "ren.txt", "renamed.txt")
					mkdirLocal(world, "freshdir")
					renameLocal(world, "dir/nested.txt", "dir/moved.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/added.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/del.txt"]).toBeUndefined()
		expect(result.finalRemote["/renamed.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/ren.txt"]).toBeUndefined()
		expect(result.finalRemote["/freshdir"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/dir/moved.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/nested.txt"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AR2: changes accumulated on BOTH sides reconcile after a restart", async () => {
		const result = await runScenario({
			name: "AR2",
			mode: "twoWay",
			initialLocal: {
				"/local/l.txt": "L",
				"/local/r.txt": "R",
				"/local/both-dir/x.txt": "x"
			},
			steps: [
				runCycle(),
				// Accumulate divergent, non-conflicting changes on each side with no cycle between them.
				localMutate(world => {
					writeLocal(world, "local-new.txt", "from local")
					writeLocalAt(world, "l.txt", "L-edited-much-longer", 1_700_000_900_000)
				}),
				remoteMutate(world => {
					world.cloud.controls.addFile("/remote-new.txt", "from remote")
					world.cloud.controls.updateFile("/r.txt", "R-edited-much-longer")
				}),
				// Simulate a process restart: reload persisted state, rebuild the engine over the same world.
				restart(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/local-new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/remote-new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/r.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/l.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
