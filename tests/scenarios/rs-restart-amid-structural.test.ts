import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, writeLocal } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category RS — a process RESTART interleaved with a cross-side STRUCTURAL reconciliation. ZC pins crash
 * recovery via a faulted cycle; J/S pin the state round-trip on a settled tree. This pins the harder
 * combination: a restart (reload the persisted base from disk, rebuild the engine, re-scan both sides)
 * DURING a multi-cycle cross-side rename/swap/move that has only PARTIALLY reconciled. The base persisted
 * after a partial cycle is reloaded and the outstanding work re-derived against the actual current state —
 * recovery is at-least-once, so it must still converge with no data loss, duplication, or resurrection.
 */
const SECOND = 1000

describe("Category RS — restart amid a cross-side structural reconciliation", () => {
	it("RS1: restart in the middle of a nested cross-side dir rename → still converges", async () => {
		const result = await runScenario({
			name: "RS1",
			mode: "twoWay",
			initialLocal: { "/local/top/mid/file.txt": "FILE", "/local/top/keep.txt": "K" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "top", "top2")),
				remoteMutate(world => world.cloud.controls.movePath("/top/mid", "/top/mid2")),
				runCycle(), // partial reconciliation
				restart(), // reload persisted base, rebuild engine, re-scan
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "FILE".length })
		expect(result.finalRemote["/top2/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalRemote["/top"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/top2/mid2/file.txt"]!.contentHash).toBe(result.finalRemote["/top2/mid2/file.txt"]!.contentHash)
	})

	it("RS2: restart in the middle of a cross-side swap → still converges to the swapped state", async () => {
		const result = await runScenario({
			name: "RS2",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 50 * SECOND },
				"/local/b.txt": { content: "BBBBBB", mtimeMs: BASE_TIME + 60 * SECOND }
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/b.txt", "/a.txt")),
				runCycle(),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "BBBBBB".length })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).not.toBe(result.finalLocal["/b.txt"]!.contentHash)
	})

	it("RS3: restart immediately AFTER the structural mutation, before any reconciling cycle → still converges", async () => {
		const result = await runScenario({
			name: "RS3",
			mode: "twoWay",
			initialLocal: { "/local/dir/a.txt": "AAA", "/local/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				remoteMutate(world => world.cloud.controls.movePath("/dir/a.txt", "/dir/b.txt")),
				restart(), // reload base BEFORE the cross-side change has been reconciled at all
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir2/b.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalRemote["/dir2/keep.txt"]).toMatchObject({ type: "file", size: "k".length })
		expect(result.finalRemote["/dir2/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("RS4: restart amid a rename-away + recreate-source reconciliation → both files survive", async () => {
		const result = await runScenario({
			name: "RS4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "ORIGINAL-A" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "b.txt")
					writeLocal(world, "a.txt", "BRAND-NEW-A")
				}),
				runCycle(),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "ORIGINAL-A".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "BRAND-NEW-A".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).not.toBe(result.finalLocal["/b.txt"]!.contentHash)
	})
})
