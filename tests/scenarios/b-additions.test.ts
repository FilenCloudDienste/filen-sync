import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds, transferOps, hadTransfers } from "../harness/snapshot"
import { writeLocal } from "../harness/mutations"
import { knownBug } from "../harness/known-bug"

/**
 * Category B — additions (behavioral spec §B). Additions are applied dynamically (after an initial
 * converged cycle) so the delta-vs-previous-state path and the watcher trigger are exercised.
 */
describe("Category B — additions", () => {
	it("B1: a file added locally uploads on the next cycle (twoWay)", async () => {
		const result = await runScenario({
			name: "B1",
			mode: "twoWay",
			steps: [runCycle(), localMutate(world => writeLocal(world, "a.txt", "added")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")
		expect(result.cycles[1]!.remote["/a.txt"]).toMatchObject({ type: "file", size: 5 })
		expect(transferOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("B2: a directory tree added locally creates the remote dirs and uploads its files", async () => {
		const result = await runScenario({
			name: "B2",
			mode: "twoWay",
			steps: [
				runCycle(),
				localMutate(world => {
					writeLocal(world, "docs/x.txt", "x")
					writeLocal(world, "docs/y.txt", "y")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/docs"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/docs/x.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalRemote["/docs/y.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("B3: a file added remotely downloads on the next cycle (twoWay)", async () => {
		const result = await runScenario({
			name: "B3",
			mode: "twoWay",
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.addFile("/r.txt", "remote")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("download")
		expect(result.cycles[1]!.local["/r.txt"]).toMatchObject({ type: "file", size: 6 })
		expect(transferOps(result.cycles[2]!.messages)).toEqual([])
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("B4: a directory tree added remotely creates the local dirs and downloads its files", async () => {
		const result = await runScenario({
			name: "B4",
			mode: "twoWay",
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.addDir("/album")
					world.cloud.controls.addFile("/album/p.txt", "pixels")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/album"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/album/p.txt"]).toMatchObject({ type: "file", size: 6 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("B5: a deeply nested new path creates all intermediate directories", async () => {
		const result = await runScenario({
			name: "B5",
			mode: "twoWay",
			steps: [runCycle(), localMutate(world => writeLocal(world, "p/q/r/s/t.txt", "deep")), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/p/q/r/s"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/p/q/r/s/t.txt"]).toMatchObject({ type: "file", size: 4 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("B6: a bulk of new files all upload", async () => {
		const fileCount = 25

		const result = await runScenario({
			name: "B6",
			mode: "twoWay",
			steps: [
				runCycle(),
				localMutate(world => {
					for (let index = 0; index < fileCount; index++) {
						writeLocal(world, `bulk/file-${index}.txt`, `content-${index}`)
					}
				}),
				runCycle(),
				runCycle()
			]
		})

		for (let index = 0; index < fileCount; index++) {
			expect(result.finalRemote[`/bulk/file-${index}.txt`]).toMatchObject({ type: "file" })
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("B7: distinct additions on both sides in the same cycle produce the union (twoWay)", async () => {
		const result = await runScenario({
			name: "B7",
			mode: "twoWay",
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "local-only.txt", "L")),
				remoteMutate(world => world.cloud.controls.addFile("/remote-only.txt", "R")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/local-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/remote-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/local-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/remote-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// B8 — TARGET: 0-byte files sync normally. The engine currently ignores size<=0 entries during
	// tree build (local.ts and remote.ts), so an empty file is never uploaded. See BUG-002.
	knownBug("BUG-002", "B8: a new 0-byte file syncs to the remote", async () => {
		const result = await runScenario({
			name: "B8",
			mode: "twoWay",
			steps: [runCycle(), localMutate(world => writeLocal(world, "empty.txt", "")), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/empty.txt"]).toMatchObject({ type: "file", size: 0 })
		expect(hadTransfers(result.messages)).toBe(true)
	})
})
