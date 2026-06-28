import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category ZH — a directory deletion must not cascade over live content the OTHER side did not delete.
 *
 * When one side removes a directory while the other adds (or keeps a modified) child inside it in the same
 * cycle, the raw delta set holds both `deleteXDirectory <dir>` and the child's own add. The dir-delete used
 * to win — collapse subsumed the child's sibling deletes under it and the dir-delete then wiped the
 * brand-new file at execution time, before it was ever propagated (silent data loss). Newer content beats a
 * delete (the same rule the per-file passes apply), so the directory survives: its delete is dropped and
 * the surviving child's own add re-creates it. A child that is merely RENAMED out of the directory does NOT
 * keep it alive (that is a normal dir rename, which deletes the now-empty old directory).
 */
describe("Category ZH — directory delete vs a live child", () => {
	it("ZH1: remote deletes a dir while local adds a new child — the child survives, the dir is kept (twoWay)", async () => {
		const result = await runScenario({
			name: "ZH1",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "keep", "/local/other.txt": "o" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/dir")),
				localMutate(world => writeLocal(world, "dir/new.txt", "new-child")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The new child survives and is uploaded; the dir is re-asserted; the unmodified base child the
		// remote deleted is gone; both sides converge.
		expect(result.finalLocal["/dir/new.txt"]).toMatchObject({ type: "file", size: "new-child".length })
		expect(result.finalRemote["/dir/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/dir/keep.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZH2: local deletes a dir while remote adds a new child — the child survives (symmetric)", async () => {
		const result = await runScenario({
			name: "ZH2",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "keep", "/local/other.txt": "o" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "dir")),
				remoteMutate(world => world.cloud.controls.addFile("/dir/new.txt", "remote-new")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir/new.txt"]).toMatchObject({ type: "file", size: "remote-new".length })
		expect(result.finalLocal["/dir/new.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/keep.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZH3: remote deletes a dir while local MODIFIES a base child — the modified child wins, dir kept", async () => {
		const result = await runScenario({
			name: "ZH3",
			mode: "twoWay",
			initialLocal: { "/local/dir/keep.txt": "v1", "/local/other.txt": "o" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/dir")),
				localMutate(world => writeLocal(world, "dir/keep.txt", "v2-modified-bigger")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Newer-modify-wins: the locally-modified child is resurrected (re-uploaded), keeping its directory.
		expect(result.finalRemote["/dir/keep.txt"]).toMatchObject({ type: "file", size: "v2-modified-bigger".length })
		expect(result.finalLocal["/dir/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZH4: deleting a dir whose ONLY child is moved out still deletes the dir (no false-keep on rename)", async () => {
		const result = await runScenario({
			name: "ZH4",
			mode: "twoWay",
			initialLocal: { "/local/dir/only.txt": "x", "/local/other.txt": "o" },
			steps: [
				runCycle(),
				localMutate(world => {
					// Move the only child OUT to the root, then remove the now-empty directory.
					writeLocal(world, "moved.txt", "x")
					rmLocal(world, "dir")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/moved.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
