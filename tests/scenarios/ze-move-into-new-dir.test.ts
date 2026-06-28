import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { renameLocal } from "../harness/mutations"
import { messagesOfType } from "../harness/snapshot"
import { type SyncMessage } from "../../src/types"

/**
 * Category ZE — moving an item INTO a newly-created nested directory.
 *
 * remote.mkdir() must be able to create a directory whose missing parent is the sync ROOT. The
 * intermediate-directory loop used to skip any level whose parent was the root (the `if (!parentItem)
 * continue` fired before the `parentIsBase` branch that supplies remoteParentUUID), so mkdir('/x/y')
 * threw whenever '/x' did not already exist. A cross-parent rename builds its destination parent inline
 * (BEFORE the createRemoteDirectory tasks run), so moving a file into a NEW >=2-level folder made the
 * rename throw; for a TOP-LEVEL source that throw was then swallowed by fileExists() (which returned
 * false for every top-level file because tree['/'] is never a cache key) -> zero task errors -> a skewed
 * base was persisted -> the file was silently DUPLICATED (original resurrected + a copy at the new path).
 */

function taskErrorCount(messages: SyncMessage[]): number {
	return messagesOfType(messages, "taskErrors").reduce((sum, m) => sum + m.data.errors.length, 0)
}

describe("Category ZE — move into a newly-created nested directory", () => {
	it("ZE1: twoWay — move a top-level file into a NEW 2-level dir converges (no duplication)", async () => {
		const result = await runScenario({
			name: "ZE1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "hello", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "x/y/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"], "the moved-away original must NOT survive").toBeUndefined()
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/x/y/a.txt"]).toMatchObject({ type: "file", size: "hello".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZE2: twoWay — move a top-level file into a NEW 3-level dir converges", async () => {
		const result = await runScenario({
			name: "ZE2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "deep", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "p/q/r/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/p/q/r/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZE3: twoWay — move a top-level DIRECTORY into a NEW 2-level dir converges", async () => {
		const result = await runScenario({
			name: "ZE3",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "c", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "x/y/dir")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/x/y/dir/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZE4: localToCloud — move a top-level file into a NEW 2-level dir converges", async () => {
		const result = await runScenario({
			name: "ZE4",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "mirror", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "x/y/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/x/y/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZE5: a TRANSIENT error on a top-level remote file op SURFACES (not swallowed) and retries to convergence", async () => {
		const result = await runScenario({
			name: "ZE5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "x", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				control(world => world.cloud.controls.setError("renameFile", new Error("transient rename failure"))),
				runCycle(),
				control(world => {
					world.cloud.controls.clearError("renameFile")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		// The failing cycle must REPORT a task error (the top-level rename failure must not be swallowed as
		// "target vanished" — fileExists has to see the still-present top-level file).
		expect(taskErrorCount(result.cycles[1]!.messages)).toBeGreaterThan(0)
		// After recovery: the rename completed, no resurrection of the old name, both sides converge.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
