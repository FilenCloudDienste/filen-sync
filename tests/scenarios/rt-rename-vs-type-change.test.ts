import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, rmLocal, mkdirLocal, writeLocal } from "../harness/mutations"

/**
 * Category RT — one side RENAMES a path while the OTHER side changes that same path's TYPE (file⇄directory)
 * in the same cycle.
 *
 * Category AX pins type-change vs a content edit / delete; E/AF pin renames; T pins authoritative type
 * changes. The unexplored seam is rename-vs-type-change on the SAME identity: the rename detector refuses to
 * propagate because the source's other-side identity changed (a type change mints a new uuid / inode), so it
 * falls through to delete+recreate — but the type-change-beats-delete guard must keep the OTHER side's new
 * type from being deleted. The correct outcome KEEPS BOTH independent edits: the renamed file lands at its
 * new name AND the type-changed path becomes the new type, with no data loss and full convergence.
 */
describe("Category RT — cross-side rename vs type change", () => {
	it("RT1: local renames a FILE a→b while remote turns a into a DIRECTORY → both survive", async () => {
		const result = await runScenario({
			name: "RT1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "AAA" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/a.txt")
					world.cloud.controls.addFile("/a.txt/child.txt", "C")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The renamed file keeps its content at b.txt; the path 'a.txt' is now the remotely-created directory.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalRemote["/a.txt/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/b.txt"]!.contentHash).toBe(result.finalRemote["/b.txt"]!.contentHash)
	})

	it("RT2: local turns a FILE into a DIRECTORY while remote renames it a→b → both survive (symmetric)", async () => {
		const result = await runScenario({
			name: "RT2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "AAA" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "a.txt")
					mkdirLocal(world, "a.txt")
					writeLocal(world, "a.txt/child.txt", "C")
				}),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalRemote["/a.txt/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("RT3: local renames a DIRECTORY d→e while remote turns d into a FILE → both survive", async () => {
		const result = await runScenario({
			name: "RT3",
			mode: "twoWay",
			initialLocal: { "/local/d/child.txt": "C" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "d", "e")),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/d")
					world.cloud.controls.addFile("/d", "NOW-A-FILE")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The renamed directory survives at e/; the path 'd' is now the remotely-created file.
		expect(result.finalRemote["/e/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/d"]).toMatchObject({ type: "file", size: "NOW-A-FILE".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("RT4: local turns a DIRECTORY into a FILE while remote renames it d→e → both survive (symmetric)", async () => {
		const result = await runScenario({
			name: "RT4",
			mode: "twoWay",
			initialLocal: { "/local/d/child.txt": "C" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "d")
					writeLocal(world, "d", "NOW-A-FILE")
				}),
				remoteMutate(world => world.cloud.controls.movePath("/d", "/e")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/e/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/d"]).toMatchObject({ type: "file", size: "NOW-A-FILE".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
