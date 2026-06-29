import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal } from "../harness/mutations"

/**
 * Category ZQ — case-only renames. Renaming "readme.txt" -> "README.txt" changes ONLY the casing of one
 * path component. The local inode (and remote uuid) is unchanged, so this is a rename of a stable identity
 * whose path differs only in case. The risk: any case-insensitive path comparison inside the engine would
 * judge the two paths "equal" and silently DROP the rename, leaving the two sides showing different casings
 * forever (a real, user-visible divergence on case-preserving filesystems). These probe that a case-only
 * rename propagates and converges in both directions, for files and directories. add-only.
 */
describe("Category ZQ — case-only renames", () => {
	it("ZQ1: a local case-only file rename propagates to the remote and converges", async () => {
		const result = await runScenario({
			name: "ZQ1",
			mode: "twoWay",
			initialLocal: { "/local/readme.txt": "doc" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "readme.txt", "README.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/README.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/README.txt"]).toMatchObject({ type: "file" })
		// The old casing must be gone on both sides (not kept alongside the new one).
		expect(Object.keys(result.finalRemote)).not.toContain("/readme.txt")
		expect(Object.keys(result.finalLocal)).not.toContain("/readme.txt")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZQ2: a local case-only directory rename propagates with its child and converges", async () => {
		const result = await runScenario({
			name: "ZQ2",
			mode: "twoWay",
			initialLocal: { "/local/docs/file.txt": "x" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "docs", "Docs")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/Docs/file.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/Docs/file.txt"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalRemote)).not.toContain("/docs/file.txt")
		expect(Object.keys(result.finalLocal)).not.toContain("/docs/file.txt")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZQ3: a remote case-only file rename propagates down to the local side and converges", async () => {
		const result = await runScenario({
			name: "ZQ3",
			mode: "twoWay",
			initialLocal: { "/local/notes.md": "n" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/notes.md", "/Notes.md")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/Notes.md"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/Notes.md"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalLocal)).not.toContain("/notes.md")
		expect(Object.keys(result.finalRemote)).not.toContain("/notes.md")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
