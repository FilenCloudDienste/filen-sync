import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps, transferKinds } from "../harness/snapshot"
import { renameLocal, writeLocalAt } from "../harness/mutations"

/**
 * Category R — rename/move stress (BUG-004 reproduction net). The delta engine collapses child
 * rename/move/delete ops into their parent directory op (deltas.ts ~553-612). This pass composes
 * nested and chained renames; these deterministic cases hammer that composition to surface any
 * mis-collapse (a duplicated op, a dropped op, or a wrong from-path) that a black-box cycle CAN
 * reproduce. The catalogued BUG-004 also has a pure mid-cycle timing component (mutations landing
 * between tree-read and task-exec) which only the Phase 3 live e2e can exercise; this file pins the
 * deterministic half so a regression there is caught here.
 *
 * Every case asserts convergence (worlds identical) and idempotence (a settled cycle does no work).
 */
const SECOND = 1000

function expectConverged(result: { finalLocal: Record<string, unknown>; finalRemote: Record<string, unknown>; cycles: { messages: unknown[] }[] }): void {
	expect(result.finalLocal).toEqual(result.finalRemote)

	const lastCycle = result.cycles[result.cycles.length - 1]!

	expect(allOps(lastCycle.messages as never)).toEqual([])
}

describe("Category R — rename/move stress (BUG-004 net)", () => {
	it("RS1: a parent-dir rename composed with a child rename converges (child from-path rewritten)", async () => {
		const result = await runScenario({
			name: "RS1",
			mode: "twoWay",
			initialLocal: { "/local/a/c.txt": "x" },
			steps: [
				runCycle(),
				runCycle(),
				// Rename the parent dir, THEN rename the (now-moved) child to a new name in the same beat.
				localMutate(world => {
					renameLocal(world, "a", "b")
					renameLocal(world, "b/c.txt", "b/d.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/b/d.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalRemote["/b/c.txt"]).toBeUndefined()
		expectConverged(result)
	})

	it("RS2: a chained directory rename within one beat (a -> b -> e) converges", async () => {
		const result = await runScenario({
			name: "RS2",
			mode: "twoWay",
			initialLocal: { "/local/a/c.txt": "x", "/local/a/deep/d.txt": "y" },
			steps: [
				runCycle(),
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a", "b")
					renameLocal(world, "b", "e")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/e/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/e/deep/d.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalRemote["/b"]).toBeUndefined()
		expectConverged(result)
	})

	it("RS3: a three-level nested directory rename collapses to a single parent op", async () => {
		const result = await runScenario({
			name: "RS3",
			mode: "twoWay",
			initialLocal: { "/local/x/y/z/file.txt": "deep" },
			steps: [
				runCycle(),
				runCycle(),
				localMutate(world => renameLocal(world, "x", "x2")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x2/y/z/file.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/x"]).toBeUndefined()
		// Collapse: exactly one renameRemote op (the parent dir), not one per descendant.
		const renameOps = transferKinds(result.cycles[2]!.messages).filter(kind => kind.startsWith("rename"))

		expect(renameOps.length).toBeLessThanOrEqual(1)
		expectConverged(result)
	})

	it("RS4: moving a child OUT of a renamed directory converges", async () => {
		const result = await runScenario({
			name: "RS4",
			mode: "twoWay",
			initialLocal: { "/local/a/c.txt": "x", "/local/other": null },
			steps: [
				runCycle(),
				runCycle(),
				localMutate(world => {
					// Move the child out to a sibling, THEN rename the now-empty-ish parent.
					renameLocal(world, "a/c.txt", "other/c.txt")
					renameLocal(world, "a", "b")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/other/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalRemote["/a/c.txt"]).toBeUndefined()
		expectConverged(result)
	})

	it("RS5: a rename concurrent with a sibling content change converges (both applied)", async () => {
		const result = await runScenario({
			name: "RS5",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "a", "/local/keep.txt": "keep-v1" },
			steps: [
				runCycle(),
				runCycle(),
				localMutate(world => {
					renameLocal(world, "dir", "dir-renamed")
					writeLocalAt(world, "keep.txt", "keep-v2-longer", BASE_TIME + 10 * SECOND)
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir-renamed/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file", size: "keep-v2-longer".length })
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expectConverged(result)
	})

	it("RS6: a deep subtree rename plus an in-subtree child rename converges", async () => {
		const steps: Step[] = [
			runCycle(),
			runCycle(),
			localMutate(world => {
				// Rename the top dir, then rename a deep descendant to a new basename.
				renameLocal(world, "root", "root2")
				renameLocal(world, "root2/mid/leaf.txt", "root2/mid/leaf-renamed.txt")
			}),
			runCycle(),
			runCycle()
		]

		const result = await runScenario({
			name: "RS6",
			mode: "twoWay",
			initialLocal: { "/local/root/mid/leaf.txt": "L", "/local/root/mid/other.txt": "O" },
			steps
		})

		expect(result.finalRemote["/root2/mid/leaf-renamed.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/root2/mid/other.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/root"]).toBeUndefined()
		expect(result.finalRemote["/root2/mid/leaf.txt"]).toBeUndefined()
		expectConverged(result)
	})

	it("RS7: a child under TWO overlapping renamed parents converges (sibling edit preserved)", async () => {
		// Full-cycle guard for the multi-overlapping-parent collapse case (BUG-004's deterministic half).
		// Two overlapping parent renames in one beat (/a -> /x then /x/b -> /x/y) make the child
		// /a/b/c.txt match both, and a sibling edit adds an unrelated delta that must survive. NOTE: the
		// engine re-runs and self-heals, so a corrupt FIRST cycle would still converge here — the
		// deterministic corruption (dropped/duplicated op) is pinned directly at
		// tests/unit/collapse-deltas.test.ts. This case proves the end-to-end path still converges.
		const result = await runScenario({
			name: "RS7",
			mode: "twoWay",
			initialLocal: {
				"/local/a/b/c.txt": "child",
				"/local/sibling.txt": "sib"
			},
			steps: [
				runCycle(),
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a", "x")
					renameLocal(world, "x/b", "x/y")
					writeLocalAt(world, "sibling.txt", "sib-v2-longer", BASE_TIME + 10 * SECOND)
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x/y/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/sibling.txt"]).toMatchObject({ type: "file", size: "sib-v2-longer".length })
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalRemote["/x/b"]).toBeUndefined()
		expectConverged(result)
	})
})
