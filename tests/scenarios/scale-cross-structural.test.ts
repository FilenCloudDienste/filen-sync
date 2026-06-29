import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { allOps } from "../harness/snapshot"
import { renameLocal, writeLocal } from "../harness/mutations"
import { genNoise, mergeSpecs } from "../harness/scale"

/**
 * Category LS — the rename-aware rebase (BUG-A / BUG-B — the worst silent-data-loss family) at SCALE.
 *
 * A directory renamed on ONE side while many descendants are independently changed on the OTHER side: the
 * rebase block must realign the WHOLE moved subtree (base both sides + the other side's current) so each
 * per-descendant pass attributes change at the post-rename path — else a stale same-path upload/download/
 * delete clobbers the edit (BUG-A) or resurrects a deletion (BUG-B). Category ZB pins this with one child;
 * here a big subtree is renamed while DOZENS of children are modified / added / deleted on the other side at
 * once, stressing the rebaseTree map rebuild + the per-child rebased attribution together. twoWay; asserts
 * every child fate + convergence + idempotence.
 */
describe("Category LS — cross-side dir rename + concurrent child ops, at scale", () => {
	const FILES = 12

	function bigData(): Record<string, string> {
		const spec: Record<string, string> = {}

		for (let i = 0; i < FILES; i++) {
			spec[`/local/data/file-${i}.txt`] = `data-base-${i}`
		}

		// A couple of nested subdirs with their own files (depth within the renamed subtree).
		spec["/local/data/sub1/a.txt"] = "sub1-a"
		spec["/local/data/sub1/b.txt"] = "sub1-b"
		spec["/local/data/sub2/c.txt"] = "sub2-c"

		return spec
	}

	it("LS1: LOCAL renames a big dir while REMOTE modifies/adds/deletes many of its children at the old paths", async () => {
		const result = await runScenario({
			name: "LS1",
			mode: "twoWay",
			initialLocal: mergeSpecs(bigData(), genNoise("outside", 35)),
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "data", "data2")),
				remoteMutate(world => {
					// Modify 4 children, add 3, delete 2 — all at the PRE-rename paths.
					for (let i = 0; i < 4; i++) {
						world.cloud.controls.updateFile(`/data/file-${i}.txt`, `REMOTE-edited-${i}-longerbody`)
					}

					for (let i = 0; i < 3; i++) {
						world.cloud.controls.addFile(`/data/added-${i}.txt`, `remote-added-${i}`)
					}

					world.cloud.controls.trashPath("/data/file-10.txt")
					world.cloud.controls.trashPath("/data/file-11.txt")
					world.cloud.controls.updateFile("/data/sub1/a.txt", "REMOTE-edited-sub1-a-longer")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The whole subtree moved to /data2 and the old path is empty.
		expect(result.finalRemote["/data"]).toBeUndefined()
		expect(result.finalRemote["/data2"]).toMatchObject({ type: "directory" })

		// Remote edits survived at the rebased paths (no stale clobber — BUG-A).
		for (let i = 0; i < 4; i++) {
			expect(result.finalRemote[`/data2/file-${i}.txt`], `edited ${i}`).toMatchObject({
				type: "file",
				size: `REMOTE-edited-${i}-longerbody`.length
			})
		}

		expect(result.finalRemote["/data2/sub1/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-edited-sub1-a-longer".length })

		// Remote adds landed under the renamed dir.
		for (let i = 0; i < 3; i++) {
			expect(result.finalRemote[`/data2/added-${i}.txt`], `added ${i}`).toMatchObject({ type: "file" })
		}

		// Remote deletes applied (no resurrection — BUG-B); untouched children carried along.
		expect(result.finalRemote["/data2/file-10.txt"]).toBeUndefined()
		expect(result.finalRemote["/data2/file-11.txt"]).toBeUndefined()
		expect(result.finalRemote["/data2/file-5.txt"]).toMatchObject({ type: "file", size: "data-base-5".length })
		expect(result.finalRemote["/data2/sub2/c.txt"]).toMatchObject({ type: "file" })

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LS2: REMOTE renames a big dir while LOCAL modifies/adds/deletes many of its children (symmetric)", async () => {
		const result = await runScenario({
			name: "LS2",
			mode: "twoWay",
			initialLocal: mergeSpecs(bigData(), genNoise("outside", 35)),
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/data", "/data2")),
				localMutate(world => {
					for (let i = 0; i < 4; i++) {
						writeLocal(world, `data/file-${i}.txt`, `LOCAL-edited-${i}-longerbody`)
					}

					for (let i = 0; i < 3; i++) {
						writeLocal(world, `data/added-${i}.txt`, `local-added-${i}`)
					}

					// (delete two at the old local paths)
					world.vfs.ifs.rmSync(`${world.localPath}/data/file-10.txt`, { force: true })
					world.vfs.ifs.rmSync(`${world.localPath}/data/file-11.txt`, { force: true })
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/data"]).toBeUndefined()
		expect(result.finalLocal["/data2"]).toMatchObject({ type: "directory" })

		for (let i = 0; i < 4; i++) {
			expect(result.finalLocal[`/data2/file-${i}.txt`], `edited ${i}`).toMatchObject({
				type: "file",
				size: `LOCAL-edited-${i}-longerbody`.length
			})
		}

		for (let i = 0; i < 3; i++) {
			expect(result.finalLocal[`/data2/added-${i}.txt`], `added ${i}`).toMatchObject({ type: "file" })
		}

		expect(result.finalLocal["/data2/file-10.txt"]).toBeUndefined()
		expect(result.finalLocal["/data2/file-11.txt"]).toBeUndefined()
		expect(result.finalLocal["/data2/file-5.txt"]).toMatchObject({ type: "file" })

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LS3: NESTED cross-side renames — local renames the OUTER dir, remote renames an INNER dir, children change", async () => {
		const initialLocal: Record<string, string> = {
			"/local/root/mid/x.txt": "x",
			"/local/root/mid/y.txt": "y",
			"/local/root/mid/deep/z.txt": "z",
			"/local/root/top.txt": "top"
		}

		const result = await runScenario({
			name: "LS3",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("noise", 25)),
			steps: [
				runCycle(),
				// Local renames the OUTER dir root→root2; remote renames the INNER dir mid→mid2 (at old path).
				localMutate(world => renameLocal(world, "root", "root2")),
				remoteMutate(world => {
					world.cloud.controls.movePath("/root/mid", "/root/mid2")
					world.cloud.controls.updateFile("/root/mid2/x.txt", "REMOTE-edited-x-longer")
				}),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Both renames compose: outer root→root2 AND inner mid→mid2 → /root2/mid2/...
		expect(result.finalRemote["/root2/mid2/x.txt"]).toMatchObject({ type: "file", size: "REMOTE-edited-x-longer".length })
		expect(result.finalRemote["/root2/mid2/y.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/root2/mid2/deep/z.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/root2/top.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/root"]).toBeUndefined()
		expect(result.finalRemote["/root2/mid"]).toBeUndefined()

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
