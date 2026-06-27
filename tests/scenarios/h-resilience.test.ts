import { describe, it, expect } from "vitest"
import { APIError } from "@filen/sdk"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { messagesOfType, transferKinds } from "../harness/snapshot"
import { writeLocalAt, rmLocal, mkdirLocal, writeLocal } from "../harness/mutations"
import { type SyncMessage } from "../../src/types"

/**
 * Category H — resilience / races (behavioral spec §H, §7). A task whose source vanished before it
 * runs is skipped without error; an `APIError{file_not_found|folder_not_found}` on a remote unlink is
 * treated as already-deleted; a real task failure is recorded and the cycle restarts WITHOUT
 * persisting new state, so a retry recovers. Several true mid-I/O races (modify-during-upload, a
 * vanish strictly between delta-computation and the task) are only fully reproducible against real
 * I/O — those are deferred to the Phase 3 live e2e suite; here we pin the deterministic guarantees.
 */
const SECOND = 1000

/** Total number of individual task errors reported across the message stream. */
function taskErrorCount(messages: SyncMessage[]): number {
	return messagesOfType(messages, "taskErrors").reduce((sum, message) => sum + message.data.errors.length, 0)
}

describe("Category H — resilience / races", () => {
	it("H1: a delete whose remote target already vanished is a silent no-op (no task error)", async () => {
		const result = await runScenario({
			name: "H1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "content" },
			steps: [
				runCycle(),
				// The local delete produces a deleteRemote delta, but the remote copy is ALSO already gone
				// (trashed externally in the same beat) — the unlink must find nothing and skip cleanly.
				localMutate(world => rmLocal(world, "a.txt")),
				control(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(taskErrorCount(result.messages)).toBe(0)
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("H2: successive edits to a file always converge to the latest content (no lost update)", async () => {
		const result = await runScenario({
			name: "H2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "v2", BASE_TIME + 2 * SECOND)),
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "v3-final", BASE_TIME + 4 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		expect(taskErrorCount(result.messages)).toBe(0)
		// The remote reflects the LAST write, not an earlier one — no edit was lost across the overlap.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "v3-final".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("H3: an APIError file_not_found on the remote unlink is treated as already-deleted (no error)", async () => {
		// The file lives in a subdirectory: the delete task's existence re-check resolves a parent, and
		// the two settle cycles seed both previous trees + the engine's remote uuid cache before the delete.
		const result = await runScenario({
			name: "H3",
			mode: "twoWay",
			initialRemote: { "/dir/a.txt": "content" },
			steps: [
				runCycle(),
				runCycle(),
				localMutate(world => rmLocal(world, "dir/a.txt")),
				// The backend reports the file as already gone when we try to trash it.
				control(world =>
					world.cloud.controls.setError("trashFile", new APIError({ code: "file_not_found", message: "File not found." }))
				),
				runCycle(),
				runCycle()
			]
		})

		// file_not_found is swallowed and the unlink is reported as a SUCCESSFUL delete — never an error.
		// (We assert the success signal rather than final convergence: injecting not_found leaves the node
		// live in the fake — the backend would actually have removed it — so the two would otherwise
		// re-diverge. The guarantee under test is purely that not_found does not surface as a failure.)
		const deleteMessages = messagesOfType(result.cycles[2]!.messages, "transfer").filter(message => message.data.of === "deleteRemoteFile")

		expect(deleteMessages.some(message => message.data.type === "success")).toBe(true)
		expect(deleteMessages.some(message => message.data.type === "error")).toBe(false)
		expect(taskErrorCount(result.messages)).toBe(0)
	})

	it("H4: a real (non-not_found) error on a delete is recorded, the cycle restarts, and a retry recovers", async () => {
		const result = await runScenario({
			name: "H4",
			mode: "twoWay",
			initialRemote: { "/dir/a.txt": "content" },
			steps: [
				runCycle(),
				runCycle(),
				localMutate(world => rmLocal(world, "dir/a.txt")),
				control(world => world.cloud.controls.setError("trashFile", new Error("backend unavailable"))),
				runCycle(),
				// Recover: clear the fault and the gating task error, then re-run.
				control(world => {
					world.cloud.controls.clearError("trashFile")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		// The failed cycle surfaced the error (a deleteRemoteFile that errored) and recorded a task error.
		expect(taskErrorCount(result.cycles[2]!.messages)).toBeGreaterThan(0)
		expect(transferKinds(result.cycles[2]!.messages)).toContain("deleteRemoteFile")
		// After recovery the delete completes and the worlds converge.
		expect(result.finalRemote["/dir/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/dir/a.txt"]).toBeUndefined()
	})

	it("H5: when one upload fails, an independent op still proceeds and the failure is retried to convergence", async () => {
		const result = await runScenario({
			name: "H5",
			mode: "twoWay",
			steps: [
				runCycle(),
				localMutate(world => {
					// A new empty directory (createRemoteDirectory — succeeds) alongside a file whose upload
					// is forced to fail. The independent directory op must not be blocked by the failure.
					mkdirLocal(world, "survives")
					writeLocal(world, "bad.txt", "payload")
				}),
				control(world => world.cloud.controls.setError("uploadLocalFile", new Error("upload boom"))),
				runCycle(),
				control(world => {
					world.cloud.controls.clearError("uploadLocalFile")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		// The upload failed and was recorded…
		expect(taskErrorCount(result.cycles[1]!.messages)).toBeGreaterThan(0)
		const failedKinds = transferKinds(result.cycles[1]!.messages)

		expect(failedKinds).toContain("uploadFile")
		// …but the independent directory creation still went through in that same cycle.
		expect(result.cycles[1]!.remote["/survives"]).toMatchObject({ type: "directory" })
		expect(result.cycles[1]!.remote["/bad.txt"]).toBeUndefined()

		// After recovery the previously-failed upload completes and everything converges.
		expect(result.finalRemote["/bad.txt"]).toMatchObject({ type: "file", size: "payload".length })
		expect(result.finalRemote["/survives"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
