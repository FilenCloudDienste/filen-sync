import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, touchLocal } from "../harness/mutations"

/**
 * Category AT — structural changes (renames/rotations) under the directional modes (not twoWay). The
 * authoritative side's structure must win: a foreign rename on the non-authoritative side is undone,
 * and a rename rotation on the authoritative side propagates. Complements the per-op mode suites
 * (U/V/W/X) with the harder structural cases. Add-only.
 */
describe("Category AT — mode structural integrity", () => {
	it("AT1: localToCloud undoes a foreign REMOTE rename (local structure re-asserted)", async () => {
		const result = await runScenario({
			name: "AT1",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "A", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/renamed.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Local is authoritative: the file is back under its original name, the foreign name is gone.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/renamed.txt"]).toBeUndefined()
		expect(result.finalRemote).toEqual(result.finalLocal)
	})

	it("AT2: cloudToLocal undoes a foreign LOCAL rename (remote structure re-asserted)", async () => {
		const result = await runScenario({
			name: "AT2",
			mode: "cloudToLocal",
			// Remote is authoritative in cloudToLocal — seed it so the first cycle mirrors it down to local.
			initialRemote: { "/a.txt": "A", "/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "renamed.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Remote is authoritative: the local rename is reverted back to the remote's name.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/renamed.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AT3: localBackup propagates a local 3-way rename rotation to the remote", async () => {
		const result = await runScenario({
			name: "AT3",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "AAA", "/local/b.txt": "BBB", "/local/c.txt": "CCC" },
			steps: [
				localMutate(world => {
					touchLocal(world, "a.txt", 1_700_000_000_000)
					touchLocal(world, "b.txt", 1_700_000_100_000)
					touchLocal(world, "c.txt", 1_700_000_200_000)
				}),
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "tmp.txt")
					renameLocal(world, "c.txt", "a.txt")
					renameLocal(world, "b.txt", "c.txt")
					renameLocal(world, "tmp.txt", "b.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		// Additive push mode: the rotated content is reflected remotely (a=oldC, b=oldA, c=oldB).
		expect(result.finalRemote["/a.txt"]!.contentHash).toBe(result.finalLocal["/a.txt"]!.contentHash)
		expect(result.finalRemote["/b.txt"]!.contentHash).toBe(result.finalLocal["/b.txt"]!.contentHash)
		expect(result.finalRemote["/c.txt"]!.contentHash).toBe(result.finalLocal["/c.txt"]!.contentHash)
		const hashes = new Set([
			result.finalRemote["/a.txt"]!.contentHash,
			result.finalRemote["/b.txt"]!.contentHash,
			result.finalRemote["/c.txt"]!.contentHash
		])
		expect(hashes.size).toBe(3)
	})

	it("AT4: cloudToLocal mirrors a remote 3-way rename rotation down to local", async () => {
		const result = await runScenario({
			name: "AT4",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "AAA", "/b.txt": "BBB", "/c.txt": "CCC" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.movePath("/a.txt", "/tmp.txt")
					world.cloud.controls.movePath("/c.txt", "/a.txt")
					world.cloud.controls.movePath("/b.txt", "/c.txt")
					world.cloud.controls.movePath("/tmp.txt", "/b.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		const hashes = new Set([
			result.finalLocal["/a.txt"]!.contentHash,
			result.finalLocal["/b.txt"]!.contentHash,
			result.finalLocal["/c.txt"]!.contentHash
		])
		expect(hashes.size).toBe(3)
	})
})
