import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart } from "../harness/runner"
import { countMessages, transferKinds, allOps, hadTransfers } from "../harness/snapshot"

/**
 * Category A — baseline & convergence (behavioral spec §A).
 *
 * The exact cycle in which the steady-state `cycleNoChanges` message appears depends on the
 * deviceId-cache / cache-reset settling mechanics, so these assert the robust invariants: the
 * expected transfer happens on the first cycle, NO transfers happen afterwards, the worlds converge
 * to equality, and steady state is eventually reported.
 */
describe("Category A — baseline & convergence", () => {
	it("A1: empty ↔ empty converges with no operations", async () => {
		const result = await runScenario({
			name: "A1",
			mode: "twoWay",
			steps: [runCycle(), runCycle()]
		})

		expect(hadTransfers(result.messages)).toBe(false)
		expect(countMessages(result.messages, "cycleNoChanges")).toBeGreaterThanOrEqual(1)
		expect(result.finalLocal).toEqual({})
		expect(result.finalRemote).toEqual({})
	})

	it("A2: a local-only file uploads on the first cycle, then converges (twoWay)", async () => {
		const result = await runScenario({
			name: "A2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "0123456789" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.cycles[0]!.remote["/a.txt"]).toMatchObject({ type: "file", size: 10 })
		expect(transferKinds(result.cycles[0]!.messages)).toContain("upload")
		expect(allOps(result.cycles[1]!.messages)).toEqual([])
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(countMessages(result.messages, "cycleNoChanges")).toBeGreaterThanOrEqual(1)
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: 10 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("A3: a remote-only file downloads on the first cycle, then converges (twoWay)", async () => {
		const result = await runScenario({
			name: "A3",
			mode: "twoWay",
			initialRemote: { "/a.txt": "hello" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.cycles[0]!.local["/a.txt"]).toMatchObject({ type: "file", size: 5 })
		expect(transferKinds(result.cycles[0]!.messages)).toContain("download")
		expect(allOps(result.cycles[1]!.messages)).toEqual([])
		expect(allOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: 5 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("A4: identical content on both sides converges without any transfer", async () => {
		const result = await runScenario({
			name: "A4",
			mode: "twoWay",
			initialLocal: { "/local/same.txt": "identical" },
			initialRemote: { "/same.txt": "identical" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(hadTransfers(result.messages)).toBe(false)
		expect(result.finalLocal["/same.txt"]).toMatchObject({ type: "file", size: 9 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("A5: a converged world reports no operations after a restart (state persistence)", async () => {
		const result = await runScenario({
			name: "A5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "persisted" },
			steps: [runCycle(), runCycle(), runCycle(), restart(), runCycle(), runCycle()]
		})

		// The two cycles after the restart (indices 3 and 4) perform no transfers.
		expect(allOps(result.cycles[3]!.messages)).toEqual([])
		expect(allOps(result.cycles[4]!.messages)).toEqual([])
		expect(countMessages(result.messages, "cycleError")).toBe(0)
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: 9 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("A6: a deeply nested directory tree converges (twoWay)", async () => {
		const result = await runScenario({
			name: "A6",
			mode: "twoWay",
			initialLocal: {
				"/local/a/b/c/d/e/deep.txt": "deep",
				"/local/a/b/sibling.txt": "sibling",
				"/local/a/top.txt": "top"
			},
			steps: [runCycle(), runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a/b/c/d/e/deep.txt"]).toMatchObject({ type: "file", size: 4 })
		expect(result.finalRemote["/a/b/c/d/e"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/a/top.txt"]).toMatchObject({ type: "file", size: 3 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
