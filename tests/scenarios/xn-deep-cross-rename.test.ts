import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, writeLocalAt } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category XN — DEEP and DIVERGENT cross-side rename composition, beyond the adjacent-level XD case.
 *
 *  - XN1/XN2: NON-ADJACENT levels. Local renames the level-1 directory while remote renames a level-3
 *    directory two levels below it, so the rebase must compose a rename with a non-parent/child rename
 *    deeper in the same chain and still land the leaf at /A/b/C/file.txt.
 *  - XN3/XN4: DIVERGENT parent rename (both sides rename the SAME directory to DIFFERENT names) while each
 *    side ALSO modifies a DIFFERENT child. AK pins the bare divergent rename (keep both); this adds the
 *    concurrent edits and asserts each modification survives inside its respective kept copy — no edit lost
 *    in the keep-both reconciliation.
 */
const SECOND = 1000

describe("Category XN — deep / divergent cross-side rename composition", () => {
	it("XN1: local renames level-1 dir + remote renames level-3 dir (non-adjacent) → composes to /A/b/C/file.txt", async () => {
		const result = await runScenario({
			name: "XN1",
			mode: "twoWay",
			initialLocal: { "/local/a/b/c/file.txt": "DEEP", "/local/a/top.txt": "T" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a", "A")),
				remoteMutate(world => world.cloud.controls.movePath("/a/b/c", "/a/b/C")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/A/b/C/file.txt"]).toMatchObject({ type: "file", size: "DEEP".length })
		expect(result.finalRemote["/A/top.txt"]).toMatchObject({ type: "file", size: "T".length })
		expect(result.finalRemote["/A/b/c"]).toBeUndefined()
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/A/b/C/file.txt"]!.contentHash).toBe(result.finalRemote["/A/b/C/file.txt"]!.contentHash)
	})

	it("XN2: remote renames level-1 dir + local renames level-3 dir (non-adjacent, symmetric) → composes", async () => {
		const result = await runScenario({
			name: "XN2",
			mode: "twoWay",
			initialLocal: { "/local/a/b/c/file.txt": "DEEP", "/local/a/top.txt": "T" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/a", "/A")),
				localMutate(world => renameLocal(world, "a/b/c", "a/b/C")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/A/b/C/file.txt"]).toMatchObject({ type: "file", size: "DEEP".length })
		expect(result.finalRemote["/A/top.txt"]).toMatchObject({ type: "file", size: "T".length })
		expect(result.finalRemote["/A/b/c"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XN3: divergent parent rename (/p→/PL local, /p→/PR remote) + each modifies a different child → keep both, edits survive", async () => {
		const result = await runScenario({
			name: "XN3",
			mode: "twoWay",
			initialLocal: { "/local/p/a.txt": "AAA", "/local/p/b.txt": "BBB" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "p", "PL")
					writeLocalAt(world, "PL/a.txt", "AAA-LOCAL-EDIT", BASE_TIME + 100 * SECOND)
				}),
				remoteMutate(world => {
					world.cloud.controls.movePath("/p", "/PR")
					world.cloud.controls.updateFile("/PR/b.txt", "BBB-REMOTE-EDIT", { mtimeMs: BASE_TIME + 100 * SECOND })
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Keep both renamed copies; each copy carries the edit made on its originating side.
		expect(result.finalRemote["/PL/a.txt"]).toMatchObject({ type: "file", size: "AAA-LOCAL-EDIT".length })
		expect(result.finalRemote["/PR/b.txt"]).toMatchObject({ type: "file", size: "BBB-REMOTE-EDIT".length })
		expect(result.finalRemote["/PL/b.txt"]).toMatchObject({ type: "file", size: "BBB".length })
		expect(result.finalRemote["/PR/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalRemote["/p"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		// The edited copies really hold the edited bytes.
		expect(result.finalLocal["/PL/a.txt"]!.contentHash).toBe(result.finalRemote["/PL/a.txt"]!.contentHash)
		expect(result.finalLocal["/PR/b.txt"]!.contentHash).toBe(result.finalRemote["/PR/b.txt"]!.contentHash)
	})

	it("XN4: after a deep non-adjacent cross-rename converges, an extra cycle is a no-op (stability)", async () => {
		const result = await runScenario({
			name: "XN4",
			mode: "twoWay",
			initialLocal: { "/local/a/b/c/file.txt": "DEEP" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a", "A")),
				remoteMutate(world => world.cloud.controls.movePath("/a/b/c", "/a/b/C")),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		const lastCycleKinds = result.cycles[result.cycles.length - 1]!.messages
			.filter(m => m.type === "transfer")
			.map(m => (m as Extract<typeof m, { type: "transfer" }>).data.of)

		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
		expect(lastCycleKinds).not.toContain("renameRemoteDirectory")
		expect(lastCycleKinds).not.toContain("renameLocalDirectory")
		expect(result.finalRemote["/A/b/C/file.txt"]).toMatchObject({ type: "file", size: "DEEP".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
