import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { renameLocal, rmLocal, writeLocal, writeLocalAt } from "../harness/mutations"

/**
 * Category CC — cross-side DELETE × RENAME / replace collisions that none of the existing categories hit
 * head-on. Y/AJ pin modify-vs-delete; AE pins move-vs-delete of a FILE; ZB pins dir-rename + child change.
 * The gaps here: a whole DIRECTORY renamed on one side while DELETED on the other (rename must win — newer
 * data beats a delete, like modify-vs-delete); a rename whose destination is a path the other side deleted;
 * both sides independently replacing a directory's contents; and a remote rename+modify racing a local
 * modify of the same identity. Every case must converge with no data loss and no duplication.
 */
const SECOND = 1000

describe("Category CC — cross-side delete/rename collisions", () => {
	it("CC1: local DELETES a directory while remote RENAMES it → the rename wins (data preserved at the new path)", async () => {
		const result = await runScenario({
			name: "CC1",
			mode: "twoWay",
			initialLocal: { "/local/D/child.txt": "C", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "D")),
				remoteMutate(world => world.cloud.controls.movePath("/D", "/E")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Newer data beats a delete: the renamed directory survives at its new path on both sides.
		expect(result.finalRemote["/E/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/D"]).toBeUndefined()
		expect(result.finalRemote["/D/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("CC2: remote DELETES a directory while local RENAMES it → the rename wins (symmetric)", async () => {
		const result = await runScenario({
			name: "CC2",
			mode: "twoWay",
			initialLocal: { "/local/D/child.txt": "C", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "D", "E")),
				remoteMutate(world => world.cloud.controls.trashPath("/D")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/E/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/D"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("CC3: local renames a→b (over local b) while remote DELETES b → converges to b with a's content", async () => {
		const result = await runScenario({
			name: "CC3",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 100 * SECOND },
				"/local/b.txt": { content: "BB", mtimeMs: BASE_TIME + 100 * SECOND }
			},
			steps: [
				runCycle(),
				// Local overwrites b by renaming a onto it; remote independently deletes b.
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.trashPath("/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// a's content lands at b; a is consumed; the old b content is gone (deleted on one side, overwritten on the other).
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/b.txt"]!.contentHash).toBe(result.finalRemote["/b.txt"]!.contentHash)
	})

	it("CC4: both sides independently replace a directory's contents → the union of the new children survives", async () => {
		const result = await runScenario({
			name: "CC4",
			mode: "twoWay",
			initialLocal: { "/local/dir/old.txt": "old" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "dir/old.txt")
					writeLocal(world, "dir/local-new.txt", "L")
				}),
				remoteMutate(world => {
					world.cloud.controls.trashPath("/dir/old.txt")
					world.cloud.controls.addFile("/dir/remote-new.txt", "R", { mtimeMs: BASE_TIME + 100 * SECOND })
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir/local-new.txt"]).toMatchObject({ type: "file", size: "L".length })
		expect(result.finalRemote["/dir/remote-new.txt"]).toMatchObject({ type: "file", size: "R".length })
		expect(result.finalRemote["/dir/old.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("CC5: remote rename+modify of a file vs a local modify of the same file → keeps both", async () => {
		const result = await runScenario({
			name: "CC5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "orig" },
			steps: [
				runCycle(),
				// Local edits a.txt in place; remote moves it to b.txt AND re-uploads new content there.
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-EDITED", BASE_TIME + 100 * SECOND)),
				remoteMutate(world => {
					world.cloud.controls.movePath("/a.txt", "/b.txt")
					world.cloud.controls.updateFile("/b.txt", "REMOTE-MOVED-AND-EDITED", { mtimeMs: BASE_TIME + 200 * SECOND })
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The local edit survives at a.txt; the remote's moved+edited content survives at b.txt — no loss.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-EDITED".length })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "REMOTE-MOVED-AND-EDITED".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
