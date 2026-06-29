import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { rmLocal, renameLocal } from "../harness/mutations"

/**
 * Category ZZ — a directory deleted on ONE side while the OTHER side reuses it via a MOVE (not a fresh add),
 * plus two distinct items moved onto the SAME destination path from different sides.
 *
 * Category AE pins the local-move/remote-delete-directory direction; AG/ZH pin dir-delete vs a child ADD.
 * The remaining shapes: the OTHER side moves an existing item (uuid-preserving) INTO a directory this side is
 * deleting (the surviving child arrives by MOVE, not a new upload — `directoriesWithSurvivingChildren` must
 * still keep the directory), moves the only child OUT (the now-empty directory must still delete), and two
 * different files renamed onto one path from opposite sides (a same-target collision the rename detector
 * refuses, resolved by newer-wins). All must converge with no duplication, no phantom directory, no loss of
 * the surviving item.
 */
const SECOND = 1000

describe("Category ZZ — dir delete vs cross-side move reuse", () => {
	it("ZZ1: local deletes a directory while remote MOVES a file INTO it → directory survives with the moved file", async () => {
		const result = await runScenario({
			name: "ZZ1",
			mode: "twoWay",
			initialLocal: { "/local/D/keep.txt": "k", "/local/f.txt": "F" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "D")),
				remoteMutate(world => world.cloud.controls.movePath("/f.txt", "/D/f.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The directory survives because the moved-in file lives there now; the originally-deleted child is gone.
		expect(result.finalRemote["/D/f.txt"]).toMatchObject({ type: "file", size: "F".length })
		expect(result.finalRemote["/D/keep.txt"]).toBeUndefined()
		expect(result.finalRemote["/f.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/D/f.txt"]!.contentHash).toBe(result.finalRemote["/D/f.txt"]!.contentHash)
	})

	it("ZZ2: local deletes a directory while remote MOVES its only child OUT → directory deletes, child survives", async () => {
		const result = await runScenario({
			name: "ZZ2",
			mode: "twoWay",
			initialLocal: { "/local/D/x.txt": "X" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "D")),
				remoteMutate(world => world.cloud.controls.movePath("/D/x.txt", "/x.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The child escaped before the directory was removed, so it survives at the new path and D is gone.
		expect(result.finalRemote["/x.txt"]).toMatchObject({ type: "file", size: "X".length })
		expect(result.finalRemote["/D"]).toBeUndefined()
		expect(result.finalRemote["/D/x.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZZ3: local deletes a directory while remote MOVES a whole sub-directory INTO it → directory survives with the subtree", async () => {
		const result = await runScenario({
			name: "ZZ3",
			mode: "twoWay",
			initialLocal: { "/local/D/keep.txt": "k", "/local/sub/child.txt": "C" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "D")),
				remoteMutate(world => world.cloud.controls.movePath("/sub", "/D/sub")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/D/sub/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/D/keep.txt"]).toBeUndefined()
		expect(result.finalRemote["/sub/child.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZZ4: two different files renamed onto the SAME path from opposite sides → converges to one (newer wins)", async () => {
		const result = await runScenario({
			name: "ZZ4",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 200 * SECOND },
				"/local/b.txt": { content: "BBB", mtimeMs: BASE_TIME + 100 * SECOND }
			},
			initialRemote: {
				"/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 200 * SECOND },
				"/b.txt": { content: "BBB", mtimeMs: BASE_TIME + 100 * SECOND }
			},
			steps: [
				runCycle(),
				// Local renames a→c (c inherits a's NEWER mtime); remote renames b→c (c inherits b's older mtime).
				localMutate(world => renameLocal(world, "a.txt", "c.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/b.txt", "/c.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The rename detector refuses a rename onto an occupied target, so the collision resolves by newer-wins:
		// the newer 'a' content lands at /c.txt; /a.txt and /b.txt are both consumed.
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/c.txt"]!.contentHash).toBe(result.finalRemote["/c.txt"]!.contentHash)
	})
})
