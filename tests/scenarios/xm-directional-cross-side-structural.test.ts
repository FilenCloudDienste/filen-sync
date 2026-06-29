import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category XM — cross-side STRUCTURAL reconciliation under the strict-MIRROR modes (cloudToLocal here, the
 * under-tested direction; ZW6 already pins the localToCloud mirror of a dir-rename vs a foreign child
 * rename). In a mirror mode the authoritative side ALWAYS wins and the other side is forced to match, even
 * when the non-authoritative side performed a structural change of its own. These pin that the rename-aware
 * rebase composes correctly with the directional `mirrorRevert` / `directionalPull` logic: the authoritative
 * (remote) structure is reproduced exactly, and the foreign local structural change is undone — no foreign
 * leftovers, no wedge, full convergence.
 *
 * Files are seeded on the AUTHORITATIVE (remote) side and the first cycle establishes the synced base by
 * downloading them — seeding only locally would (correctly) have cloudToLocal delete the local-only files
 * on the first cycle, before any structural change is even made.
 */
const SECOND = 1000

describe("Category XM — cross-side structural under cloudToLocal (remote authoritative)", () => {
	it("XM1: remote renames OUTER dir; a foreign LOCAL inner rename is reverted to mirror remote", async () => {
		const result = await runScenario({
			name: "XM1",
			mode: "cloudToLocal",
			initialRemote: { "/top/mid/file.txt": "FILE", "/top/keep.txt": "K" },
			steps: [
				runCycle(), // download remote → local: establishes the synced base on both sides
				remoteMutate(world => world.cloud.controls.movePath("/top", "/top2")),
				localMutate(world => renameLocal(world, "top/mid", "top/midLocal")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Remote is authoritative: outer renamed to top2, inner keeps the remote name "mid"; the foreign
		// local inner rename to midLocal is undone.
		expect(result.finalLocal["/top2/mid/file.txt"]).toMatchObject({ type: "file", size: "FILE".length })
		expect(result.finalLocal["/top2/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalLocal["/top2/midLocal"]).toBeUndefined()
		expect(result.finalLocal["/top"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XM2: cross-side swap under cloudToLocal → remote half wins, local half reverted", async () => {
		const result = await runScenario({
			name: "XM2",
			mode: "cloudToLocal",
			initialRemote: {
				"/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 50 * SECOND },
				"/b.txt": { content: "BBBBBB", mtimeMs: BASE_TIME + 60 * SECOND }
			},
			steps: [
				runCycle(),
				// Remote (authoritative) does a→b (overwriting remote b); local foreign does b→a (overwriting local a).
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				localMutate(world => renameLocal(world, "b.txt", "a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Remote truth is { b: old-a }. The mirror forces local to match: b carries old-a, the foreign local a is removed.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XM3: remote renames a dir; a foreign LOCAL same-dir child rename is reverted (remote wins)", async () => {
		const result = await runScenario({
			name: "XM3",
			mode: "cloudToLocal",
			initialRemote: { "/dir/a.txt": "AAA", "/dir/keep.txt": "k" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/dir", "/dir2")),
				localMutate(world => renameLocal(world, "dir/a.txt", "dir/foreignLocal.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Remote authoritative: the dir is dir2 and the child keeps the remote name a.txt; the foreign local
		// rename to foreignLocal.txt is undone.
		expect(result.finalLocal["/dir2/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalLocal["/dir2/keep.txt"]).toMatchObject({ type: "file", size: "k".length })
		expect(result.finalLocal["/dir2/foreignLocal.txt"]).toBeUndefined()
		expect(result.finalLocal["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XM4: remote DELETES a dir; a foreign LOCAL child rename inside it does not save it (remote wins)", async () => {
		const result = await runScenario({
			name: "XM4",
			mode: "cloudToLocal",
			initialRemote: { "/d/a.txt": "CONTENT-A", "/keep.txt": "k" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/d")),
				localMutate(world => renameLocal(world, "d/a.txt", "d/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// In a strict cloud→local mirror the authoritative remote delete wins outright — the directory is gone
		// locally despite the foreign local rename (unlike twoWay's "newer data beats delete" in DC2).
		expect(result.finalLocal["/d"]).toBeUndefined()
		expect(result.finalLocal["/d/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/d/b.txt"]).toBeUndefined()
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
