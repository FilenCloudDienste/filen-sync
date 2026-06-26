import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { countMessages, transferKinds } from "../harness/snapshot"
import { type SyncMessage } from "../../src/types"

const TRANSFER_OPS = ["upload", "uploadFile", "download", "downloadFile"]

function transferOps(messages: SyncMessage[]): string[] {
	return transferKinds(messages).filter(kind => TRANSFER_OPS.includes(kind))
}

describe("Category A — baseline & convergence", () => {
	it("A2: a local-only file uploads on the first cycle, then the sync converges (twoWay)", async () => {
		const result = await runScenario({
			name: "A2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "0123456789" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		// Cycle 1 uploads the local-only file to the remote.
		expect(result.cycles[0]!.remote["/a.txt"]).toMatchObject({ type: "file", size: 10 })
		expect(transferKinds(result.cycles[0]!.messages)).toContain("upload")

		// No further transfers occur once the file exists on both sides (convergence).
		expect(transferOps(result.cycles[1]!.messages)).toEqual([])
		expect(transferOps(result.cycles[2]!.messages)).toEqual([])

		// Steady state reports no changes.
		expect(countMessages(result.messages, "cycleNoChanges")).toBeGreaterThanOrEqual(1)

		// twoWay equivalence: the file persists identically on both sides.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: 10 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
