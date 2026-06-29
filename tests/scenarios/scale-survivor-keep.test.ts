import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { allOps } from "../harness/snapshot"
import { writeLocal } from "../harness/mutations"
import { genDirs, genNoise, mergeSpecs, countUnder } from "../harness/scale"

/**
 * Category LK — the directory-delete-vs-surviving-child rule (H5 / ZH / AG) at SCALE.
 *
 * `directoriesWithSurvivingChildren` and its splice maintenance (deltas.ts) are intricate AGGREGATE
 * logic — they walk the whole tree, build a keep-set, splice kept dirs out of the deleted-dir
 * bookkeeping so collapseDeltas does not subsume their LEGITIMATELY-deleted children, and decrement the
 * raw delete counts. Today this only ever runs with ONE deleted directory and one survivor (zh/ag). A
 * many-directory cycle stresses the keep-set, the per-survivor ancestor walk, the reverse-index splice,
 * and the collapse interaction together — exactly where an index/ordering bug would hide. Add-only;
 * every case asserts twoWay convergence + idempotence (a settled trailing cycle does no work).
 */
describe("Category LK — dir-delete vs surviving child, at scale", () => {
	const DIRS = 16
	const FILES = 3

	it("LK1: many dirs deleted remote + a NEW child added local to each — every dir kept, base children gone", async () => {
		const result = await runScenario({
			name: "LK1",
			mode: "twoWay",
			initialLocal: mergeSpecs(genDirs("g", DIRS, FILES), genNoise("keep", 40)),
			steps: [
				runCycle(),
				remoteMutate(world => {
					for (let d = 0; d < DIRS; d++) {
						world.cloud.controls.trashPath(`/g/d${d}`)
					}
				}),
				localMutate(world => {
					for (let d = 0; d < DIRS; d++) {
						writeLocal(world, `g/d${d}/added.txt`, `added-${d}`)
					}
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		for (let d = 0; d < DIRS; d++) {
			// The directory survives, holding ONLY the newly-added child; the base files (deleted remote,
			// unmodified local) are gone on both sides.
			expect(result.finalRemote[`/g/d${d}/added.txt`], `d${d} added child`).toMatchObject({ type: "file" })

			for (let f = 0; f < FILES; f++) {
				expect(result.finalRemote[`/g/d${d}/file-${f}.txt`], `d${d} base file ${f}`).toBeUndefined()
				expect(result.finalLocal[`/g/d${d}/file-${f}.txt`], `d${d} base file ${f} local`).toBeUndefined()
			}
		}

		// Each kept dir holds exactly one file → DIRS added children total under /g.
		expect(countUnder(result.finalRemote, "/g/")).toBe(DIRS * 2) // DIRS dir nodes + DIRS added files
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LK2: many dirs deleted remote + a base child MODIFIED local in each — modified child resurrects, dir kept", async () => {
		const result = await runScenario({
			name: "LK2",
			mode: "twoWay",
			initialLocal: mergeSpecs(genDirs("g", DIRS, FILES), genNoise("keep", 30)),
			steps: [
				runCycle(),
				remoteMutate(world => {
					for (let d = 0; d < DIRS; d++) {
						world.cloud.controls.trashPath(`/g/d${d}`)
					}
				}),
				localMutate(world => {
					for (let d = 0; d < DIRS; d++) {
						// Modify base file 0 (grow it → a real content change), leave 1 and 2 untouched.
						writeLocal(world, `g/d${d}/file-0.txt`, `modified-bigger-content-${d}`)
					}
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		for (let d = 0; d < DIRS; d++) {
			// The modified child wins over the delete and keeps its directory; the untouched siblings go.
			expect(result.finalRemote[`/g/d${d}/file-0.txt`], `d${d} modified`).toMatchObject({
				type: "file",
				size: `modified-bigger-content-${d}`.length
			})
			expect(result.finalRemote[`/g/d${d}/file-1.txt`]).toBeUndefined()
			expect(result.finalRemote[`/g/d${d}/file-2.txt`]).toBeUndefined()
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LK3: MIXED — half the dirs survive (new child), half are cleanly deleted, in ONE cycle (splice stress)", async () => {
		const DIRCOUNT = 20

		const result = await runScenario({
			name: "LK3",
			mode: "twoWay",
			initialLocal: mergeSpecs(genDirs("g", DIRCOUNT, FILES), genNoise("untouched", 50)),
			steps: [
				runCycle(),
				remoteMutate(world => {
					// Delete EVERY directory on the remote.
					for (let d = 0; d < DIRCOUNT; d++) {
						world.cloud.controls.trashPath(`/g/d${d}`)
					}
				}),
				localMutate(world => {
					// Only the EVEN dirs get a surviving new child; the odd dirs get nothing → clean delete.
					for (let d = 0; d < DIRCOUNT; d += 2) {
						writeLocal(world, `g/d${d}/survivor.txt`, `survivor-${d}`)
					}
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		for (let d = 0; d < DIRCOUNT; d++) {
			if (d % 2 === 0) {
				// Even: kept, holds only the survivor; ALL base files deleted (none may linger locally — the
				// splice must keep each base-file delete from being collapsed under the dropped dir-delete).
				expect(result.finalRemote[`/g/d${d}/survivor.txt`], `even d${d} survivor`).toMatchObject({ type: "file" })

				for (let f = 0; f < FILES; f++) {
					expect(result.finalLocal[`/g/d${d}/file-${f}.txt`], `even d${d} base ${f} must be gone locally`).toBeUndefined()
				}
			} else {
				// Odd: fully deleted, the directory node itself is gone on both sides.
				expect(result.finalRemote[`/g/d${d}`], `odd d${d} dir gone remote`).toBeUndefined()
				expect(result.finalLocal[`/g/d${d}`], `odd d${d} dir gone local`).toBeUndefined()
			}
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LK4: a DEEP nested chain deleted remote with a DEEP survivor — every deleted ancestor is kept", async () => {
		// /local/deep/a/b/c/d/e/leaf.txt plus a sibling file at each level (scale within the chain).
		const initialLocal: Record<string, string> = {
			"/local/deep/a/b/c/d/e/leaf.txt": "leaf",
			"/local/deep/a/sib-a.txt": "sa",
			"/local/deep/a/b/sib-b.txt": "sb",
			"/local/deep/a/b/c/sib-c.txt": "sc",
			"/local/deep/a/b/c/d/sib-d.txt": "sd",
			"/local/deep/a/b/c/d/e/sib-e.txt": "se"
		}

		const result = await runScenario({
			name: "LK4",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("keep", 20)),
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/deep/a")),
				localMutate(world => writeLocal(world, "deep/a/b/c/d/e/added-deep.txt", "deep-survivor")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The deep survivor keeps the WHOLE ancestor chain alive…
		expect(result.finalRemote["/deep/a/b/c/d/e/added-deep.txt"]).toMatchObject({ type: "file" })

		for (const dir of ["/deep/a", "/deep/a/b", "/deep/a/b/c", "/deep/a/b/c/d", "/deep/a/b/c/d/e"]) {
			expect(result.finalRemote[dir], `${dir} kept`).toMatchObject({ type: "directory" })
		}

		// …while the unmodified sibling files (deleted remote) are gone, on both sides.
		for (const sib of [
			"/deep/a/sib-a.txt",
			"/deep/a/b/sib-b.txt",
			"/deep/a/b/c/sib-c.txt",
			"/deep/a/b/c/d/sib-d.txt",
			"/deep/a/b/c/d/e/sib-e.txt",
			"/deep/a/b/c/d/e/leaf.txt"
		]) {
			expect(result.finalLocal[sib], `${sib} gone`).toBeUndefined()
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
