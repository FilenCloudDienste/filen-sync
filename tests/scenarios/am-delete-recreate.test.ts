import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferOps } from "../harness/snapshot"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category AM — delete-then-recreate at the same path (twoWay). Path reuse where the old node is gone
 * and a new node (new inode/uuid) takes its place. Probes that recreation after a propagated delete
 * re-syncs, and that recreating with new content is handled as a fresh file rather than confused with
 * the deleted one. Add-only.
 */
describe("Category AM — delete then recreate same path", () => {
	it("AM1: delete a file, let it propagate, then recreate it with the same content", async () => {
		const result = await runScenario({
			name: "AM1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "stable-content" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(), // delete propagates to remote
				localMutate(world => writeLocal(world, "a.txt", "stable-content")),
				runCycle(), // recreate propagates back up
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		// Settled: the last cycle does no transfers.
		expect(transferOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("AM2: delete and recreate a file with DIFFERENT (size-changing) content in one cycle", async () => {
		const result = await runScenario({
			name: "AM2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "a.txt")
					writeLocal(world, "a.txt", "a-brand-new-much-longer-body")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		// The new bytes won on both sides.
		expect(result.finalRemote["/a.txt"]!.contentHash).toBe(result.finalLocal["/a.txt"]!.contentHash)
		expect(result.finalRemote["/a.txt"]!.size).toBe("a-brand-new-much-longer-body".length)
	})

	it("AM3: local recreates a path the remote independently deleted in the same cycle — recreation wins", async () => {
		const result = await runScenario({
			name: "AM3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "a.txt")
					writeLocal(world, "a.txt", "recreated-after-both-touch-it-longer")
				}),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Local has a live (recreated) file; the remote deleted the old one. The live file must survive.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
