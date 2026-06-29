import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { allOps } from "../harness/snapshot"
import { writeLocal, rmLocal } from "../harness/mutations"
import { genNoise, mergeSpecs } from "../harness/scale"

/**
 * Category LT — the file↔directory TYPE-CHANGE pass at SCALE. The pass walks both current trees, attributes
 * each cross-type path against the base, emits delete-old-type + create-new-type, inflates the raw delete
 * counts, and (for a dir→file change) marks the WHOLE subtree "added" so its now-obsolete children don't
 * sync. T/AI/AX pin this with one path; what is unpinned is many simultaneous type changes (the loop and
 * the count bookkeeping at scale) and a single type change over a directory with MANY descendants (the
 * markSubtreeAdded walk at scale). twoWay; asserts every item's final type + convergence + idempotence.
 */
describe("Category LT — type-change pass, at scale", () => {
	const N = 12

	it("LT1: many file→dir AND dir→file changes in ONE local cycle all propagate", async () => {
		const initialLocal: Record<string, string> = {}

		for (let i = 0; i < N; i++) {
			initialLocal[`/local/ff/f${i}.txt`] = `file-${i}` // these become directories
			initialLocal[`/local/dd/d${i}/inner.txt`] = `inner-${i}` // these (d${i}) become files
		}

		const result = await runScenario({
			name: "LT1",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("calm", 30)),
			steps: [
				runCycle(),
				localMutate(world => {
					for (let i = 0; i < N; i++) {
						// file f${i}.txt → directory holding a child
						rmLocal(world, `ff/f${i}.txt`)
						writeLocal(world, `ff/f${i}.txt/now-dir.txt`, `became-dir-${i}`)
						// directory d${i} → file
						rmLocal(world, `dd/d${i}`)
						writeLocal(world, `dd/d${i}`, `became-file-${i}`)
					}
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		for (let i = 0; i < N; i++) {
			expect(result.finalRemote[`/ff/f${i}.txt`], `ff f${i} is now a dir`).toMatchObject({ type: "directory" })
			expect(result.finalRemote[`/ff/f${i}.txt/now-dir.txt`], `ff f${i} child`).toMatchObject({ type: "file" })
			expect(result.finalRemote[`/dd/d${i}`], `dd d${i} is now a file`).toMatchObject({ type: "file" })
			expect(result.finalRemote[`/dd/d${i}/inner.txt`], `dd d${i} old child gone`).toBeUndefined()
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LT2: cross-side — half the paths type-change locally, half remotely, in one cycle", async () => {
		const initialLocal: Record<string, string> = {}

		for (let i = 0; i < N; i++) {
			initialLocal[`/local/x/p${i}.txt`] = `p-${i}`
		}

		const result = await runScenario({
			name: "LT2",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("calm", 20)),
			steps: [
				runCycle(),
				localMutate(world => {
					// Even paths: local turns the file into a directory.
					for (let i = 0; i < N; i += 2) {
						rmLocal(world, `x/p${i}.txt`)
						writeLocal(world, `x/p${i}.txt/child.txt`, `local-dir-${i}`)
					}
				}),
				remoteMutate(world => {
					// Odd paths: remote turns the file into a directory.
					for (let i = 1; i < N; i += 2) {
						world.cloud.controls.trashPath(`/x/p${i}.txt`)
						world.cloud.controls.addDir(`/x/p${i}.txt`)
						world.cloud.controls.addFile(`/x/p${i}.txt/child.txt`, `remote-dir-${i}`)
					}
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		for (let i = 0; i < N; i++) {
			expect(result.finalRemote[`/x/p${i}.txt`], `p${i} became a dir`).toMatchObject({ type: "directory" })
			expect(result.finalRemote[`/x/p${i}.txt/child.txt`], `p${i} child`).toMatchObject({ type: "file" })
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LT3: a directory with MANY descendants is replaced by a file — the whole subtree is removed (markSubtreeAdded at scale)", async () => {
		const initialLocal: Record<string, string> = {}

		// /local/big with 30 nested descendants across a couple of levels.
		for (let i = 0; i < 24; i++) {
			initialLocal[`/local/big/file-${i}.txt`] = `b-${i}`
		}

		for (let i = 0; i < 6; i++) {
			initialLocal[`/local/big/nested/deep-${i}.txt`] = `d-${i}`
		}

		const result = await runScenario({
			name: "LT3",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("keep", 20)),
			steps: [
				runCycle(),
				localMutate(world => {
					// Replace the whole /big directory with a single file.
					rmLocal(world, "big")
					writeLocal(world, "big", "big is now a file")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/big"]).toMatchObject({ type: "file", size: "big is now a file".length })

		// Every former descendant is gone on both sides.
		for (let i = 0; i < 24; i++) {
			expect(result.finalRemote[`/big/file-${i}.txt`], `descendant ${i}`).toBeUndefined()
		}

		expect(result.finalRemote["/big/nested"]).toBeUndefined()
		expect(result.finalRemote["/big/nested/deep-0.txt"]).toBeUndefined()

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
