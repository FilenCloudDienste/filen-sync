import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal } from "../harness/mutations"

/**
 * Category AQ — local rename racing a remote edit of the SAME file (twoWay). Mirror of AJ5 (local edit
 * + remote rename) but exercising the OTHER rename pass: a local rename can't fire over a remotely
 * edited source (F2–F4), so the engine keeps BOTH — the remote edit stays at the original path and the
 * locally-renamed copy lands at the new path. No edit is silently dropped. Add-only.
 */
describe("Category AQ — rename vs cross-side edit", () => {
	it("AQ1: local renames a file while the remote edits it — keeps both", async () => {
		const result = await runScenario({
			name: "AQ1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "remote-edited-much-longer-body")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote edit survives at the original path; the local rename's copy survives at the new path.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AQ2: local moves a file to a subdirectory while the remote edits it — keeps both", async () => {
		const result = await runScenario({
			name: "AQ2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1", "/local/sub/.keep": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "sub/a.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "remote-edited-much-longer-body")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/sub/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AQ3: local renames a file while the remote renames the SAME file to a THIRD name — no loss", async () => {
		const result = await runScenario({
			name: "AQ3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "local-name.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/remote-name.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Conflicting renames to different names → both names survive (symmetric to Y9), nothing lost.
		expect(result.finalRemote["/local-name.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/remote-name.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
