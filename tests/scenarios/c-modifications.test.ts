import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, transferOps } from "../harness/snapshot"
import { writeLocal, writeLocalAt } from "../harness/mutations"

/**
 * Category C — modifications (behavioral spec §C, §4). Conflict policy is latest-mtime-wins compared
 * at whole-second precision; uploads are additionally gated on the md5 differing from the stored
 * hash, and downloads on the remote uuid having actually changed.
 */
const SECOND = 1000

describe("Category C — modifications", () => {
	it("C1: a locally modified file (newer mtime + changed content) uploads", async () => {
		const result = await runScenario({
			name: "C1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [runCycle(), localMutate(world => writeLocal(world, "a.txt", "modified-longer")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "modified-longer".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("C2: a remotely modified file (newer mtime, new uuid) downloads", async () => {
		const result = await runScenario({
			name: "C2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "remote-modified")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("download")
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "remote-modified".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("C3: a touch (newer mtime, identical content) does NOT upload (md5 guard)", async () => {
		const result = await runScenario({
			name: "C3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			// Rewrite identical content at a newer mtime.
			steps: [runCycle(), localMutate(world => writeLocal(world, "a.txt", "original")), runCycle(), runCycle()]
		})

		// A touch does not upload; content stays identical on both sides, but the local mtime is now
		// newer than the (un-reuploaded) remote — so only content, not the whole snapshot, converges.
		expect(transferOps(result.cycles[1]!.messages)).toEqual([])
		expect(transferOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
		expect(result.finalLocal["/a.txt"]!.size).toBe(result.finalRemote["/a.txt"]!.size)
	})

	it("C4: both sides modified, local newer → local wins (upload)", async () => {
		const result = await runScenario({
			name: "C4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LLLLLLLLLL", BASE_TIME + 2 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "RRR", { mtimeMs: BASE_TIME + 1 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: 10 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("C5: both sides modified, remote newer → remote wins (download)", async () => {
		const result = await runScenario({
			name: "C5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LLL", BASE_TIME + 1 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "RRRRRRRRRR", { mtimeMs: BASE_TIME + 2 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: 10 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("C6: both sides modified with equal whole-second mtime → no transfer (worlds diverge)", async () => {
		const result = await runScenario({
			name: "C6",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL6", BASE_TIME + 1 * SECOND + 200)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-6", { mtimeMs: BASE_TIME + 1 * SECOND + 800 })),
				runCycle(),
				runCycle()
			]
		})

		// Equal floor-to-seconds mtime ⇒ neither side is "newer" ⇒ the modify cycle does no transfer
		// ⇒ the worlds diverge (the codified second-precision limitation).
		expect(transferOps(result.cycles[1]!.messages)).toEqual([])
		expect(result.finalLocal["/a.txt"]!.size).toBe("LOCAL6".length)
		expect(result.finalRemote["/a.txt"]!.size).toBe("REMOTE-6".length)
	})

	it("C7: a remote mtime bump with an unchanged uuid does NOT download (uuid guard)", async () => {
		const result = await runScenario({
			name: "C7",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.touchRemote("/a.txt", BASE_TIME + 5 * SECOND)), runCycle(), runCycle()]
		})

		expect(transferOps(result.cycles[1]!.messages)).toEqual([])
		expect(transferOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "original".length })
	})
})
