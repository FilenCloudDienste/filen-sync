import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, rmLocal } from "../harness/mutations"

/**
 * Category DR — a directory rename on one side racing a delete of an ANCESTOR (or descendant) directory on
 * the OTHER side, at DIFFERENT levels. CC1/CC2 pin delete-vs-rename of the SAME directory (rename wins).
 * The gap here: the delete targets a different level than the rename.
 *
 *  - DR1/DR2: one side renames an INNER directory /a/b → /a/B while the other deletes the OUTER /a. The
 *    actively-renamed subtree is "newer data" and must survive (re-created at its new path), while the
 *    parts of /a the user did NOT touch follow the delete. Net: /a/B/<children> survive, /a/<untouched
 *    siblings> are gone.
 *  - DR3: the mirror level pairing — one side renames the OUTER /a → /A while the other deletes an INNER
 *    /a/b. The outer rename relocates the whole subtree; the inner delete still removes /A/b.
 *
 * Every case must converge with the renamed content preserved and no wedge.
 */
describe("Category DR — dir rename vs cross-side ancestor/descendant delete", () => {
	it("DR1: local renames INNER /a/b→/a/B while remote DELETES OUTER /a → renamed subtree survives, untouched sibling deleted", async () => {
		const result = await runScenario({
			name: "DR1",
			mode: "twoWay",
			initialLocal: {
				"/local/a/b/c.txt": "C",
				"/local/a/b/d.txt": "D",
				"/local/a/other.txt": "OTHER"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a/b", "a/B")),
				remoteMutate(world => world.cloud.controls.trashPath("/a")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The actively-renamed subtree survives (newer data beats the delete) at its new path…
		expect(result.finalRemote["/a/B/c.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/a/B/d.txt"]).toMatchObject({ type: "file", size: "D".length })
		// …while the sibling the user never touched follows the remote delete.
		expect(result.finalRemote["/a/other.txt"]).toBeUndefined()
		expect(result.finalRemote["/a/b/c.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a/B/c.txt"]!.contentHash).toBe(result.finalRemote["/a/B/c.txt"]!.contentHash)
	})

	it("DR2: remote renames INNER /a/b→/a/B while local DELETES OUTER /a → renamed subtree survives (symmetric)", async () => {
		const result = await runScenario({
			name: "DR2",
			mode: "twoWay",
			initialLocal: {
				"/local/a/b/c.txt": "C",
				"/local/a/b/d.txt": "D",
				"/local/a/other.txt": "OTHER"
			},
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/a/b", "/a/B")),
				localMutate(world => rmLocal(world, "a")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a/B/c.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/a/B/d.txt"]).toMatchObject({ type: "file", size: "D".length })
		expect(result.finalRemote["/a/other.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("DR3: local renames OUTER /a→/A while remote DELETES INNER /a/b → outer rename applies, inner delete applies", async () => {
		const result = await runScenario({
			name: "DR3",
			mode: "twoWay",
			initialLocal: {
				"/local/a/b/c.txt": "C",
				"/local/a/keep.txt": "K"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a", "A")),
				remoteMutate(world => world.cloud.controls.trashPath("/a/b")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The outer rename relocates the surviving content; the inner /b subtree is gone (deleted on remote).
		expect(result.finalRemote["/A/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalRemote["/A/b/c.txt"]).toBeUndefined()
		expect(result.finalRemote["/A/b"]).toBeUndefined()
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("DR4: after a dir-rename-vs-ancestor-delete converges, an extra cycle is a no-op (stability)", async () => {
		const result = await runScenario({
			name: "DR4",
			mode: "twoWay",
			initialLocal: {
				"/local/a/b/c.txt": "C",
				"/local/a/other.txt": "OTHER"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a/b", "a/B")),
				remoteMutate(world => world.cloud.controls.trashPath("/a")),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		const lastCycle = result.cycles[result.cycles.length - 1]!
		const kinds = lastCycle.messages.filter(m => m.type === "transfer").map(m => (m as Extract<typeof m, { type: "transfer" }>).data.of)

		expect(kinds).not.toContain("upload")
		expect(kinds).not.toContain("download")
		expect(result.finalRemote["/a/B/c.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
