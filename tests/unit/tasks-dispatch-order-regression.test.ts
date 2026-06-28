import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { messagesOfType } from "../harness/snapshot"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Added regression test pinning the tasks.process dispatch ORDER after the bucketing optimization (the
 * 12 filter-passes were replaced with a single partition-then-drain). The fixed type order — deletes
 * before directory creations before uploads — is load-bearing: an upload into a not-yet-created
 * directory would fail. This drives a mixed one-cycle batch and asserts the completion order, on top of
 * convergence.
 *
 * NEW FILE — does not touch the existing scenario tests.
 */
describe("tasks.process — dispatch order preserved by bucketing", () => {
	it("completes deleteRemoteFile before createRemoteDirectory before uploadFile in one cycle", async () => {
		const result = await runScenario({
			name: "dispatch-order",
			mode: "twoWay",
			initialLocal: { "/local/old.txt": "old", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					// One cycle that produces a delete, a directory creation, and an upload into it.
					rmLocal(world, "old.txt")
					writeLocal(world, "newdir/new.txt", "new-content")
				}),
				runCycle(),
				runCycle()
			]
		})

		const opCycle = result.cycles[1]!.messages
		const completions: string[] = messagesOfType(opCycle, "transfer")
			.filter(message => message.data.type === "success")
			.map(message => message.data.of)

		const firstIndex = (of: string): number => completions.indexOf(of)

		expect(firstIndex("deleteRemoteFile")).toBeGreaterThanOrEqual(0)
		expect(firstIndex("createRemoteDirectory")).toBeGreaterThanOrEqual(0)
		expect(firstIndex("uploadFile")).toBeGreaterThanOrEqual(0)

		// Deletes run before directory creations, which run before uploads.
		expect(firstIndex("deleteRemoteFile")).toBeLessThan(firstIndex("createRemoteDirectory"))
		expect(firstIndex("createRemoteDirectory")).toBeLessThan(firstIndex("uploadFile"))

		// And the cycle still converges.
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/newdir/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/old.txt"]).toBeUndefined()
	})
})
