import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { allOps } from "../harness/snapshot"
import { BASE_TIME } from "../harness/world"
import { writeLocalAt, rmLocal, renameLocal } from "../harness/mutations"
import { genNoise, mergeSpecs } from "../harness/scale"

/**
 * Category LC — a CONFLICT STORM: many independent same-path conflicts of EVERY kind resolved together in
 * ONE big cycle. Category Y pins each conflict type with one or two files; what is unpinned is dozens of
 * heterogeneous conflicts landing simultaneously — the realistic "two devices each made a big batch of
 * changes while offline, now reconcile" case. This stresses the pathsAdded marking, the pass ordering, and
 * the newer-mtime / resurrect / keep-both tiebreaks all at once, at scale. twoWay; deterministic winners
 * via explicit mtimes; asserts every winner + convergence + idempotence.
 */
describe("Category LC — heterogeneous conflict storm, at scale", () => {
	const N = 8 // files per conflict family
	const OLD = BASE_TIME + 10_000
	const NEW = BASE_TIME + 50_000

	it("LC1: modify/modify, modify/delete, delete/modify and rename/rename conflicts all resolve in one cycle", async () => {
		const initialLocal: Record<string, string> = {}

		for (let i = 0; i < N; i++) {
			initialLocal[`/local/mm/f${i}.txt`] = `mm-base-${i}`
			initialLocal[`/local/md/f${i}.txt`] = `md-base-${i}`
			initialLocal[`/local/dm/f${i}.txt`] = `dm-base-${i}`
			initialLocal[`/local/rr/f${i}.txt`] = `rr-base-${i}`
		}

		const result = await runScenario({
			name: "LC1",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("calm", 40)),
			steps: [
				runCycle(),
				localMutate(world => {
					for (let i = 0; i < N; i++) {
						// modify/modify: even → local newer (wins); odd → local older (remote wins).
						writeLocalAt(world, `mm/f${i}.txt`, `mm-LOCAL-edit-${i}-xx`, i % 2 === 0 ? NEW : OLD)
						// modify/delete: local modifies (must resurrect over the remote delete).
						writeLocalAt(world, `md/f${i}.txt`, `md-LOCAL-modified-${i}-yy`, NEW)
						// delete/modify: local deletes (remote modify must resurrect).
						rmLocal(world, `dm/f${i}.txt`)
						// rename/rename: local renames to a -local target.
						renameLocal(world, `rr/f${i}.txt`, `rr/f${i}-local.txt`)
					}
				}),
				remoteMutate(world => {
					for (let i = 0; i < N; i++) {
						world.cloud.controls.updateFile(`/mm/f${i}.txt`, `mm-REMOTE-edit-${i}`, { mtimeMs: i % 2 === 0 ? OLD : NEW })
						world.cloud.controls.trashPath(`/md/f${i}.txt`)
						world.cloud.controls.updateFile(`/dm/f${i}.txt`, `dm-REMOTE-modified-${i}`, { mtimeMs: NEW })
						world.cloud.controls.movePath(`/rr/f${i}.txt`, `/rr/f${i}-remote.txt`)
					}
				}),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		for (let i = 0; i < N; i++) {
			// modify/modify — newer mtime wins.
			const mmWinner = i % 2 === 0 ? `mm-LOCAL-edit-${i}-xx` : `mm-REMOTE-edit-${i}`
			expect(result.finalRemote[`/mm/f${i}.txt`], `mm f${i}`).toMatchObject({ type: "file", size: mmWinner.length })

			// modify/delete — the local modification resurrects the file.
			expect(result.finalRemote[`/md/f${i}.txt`], `md f${i}`).toMatchObject({ type: "file", size: `md-LOCAL-modified-${i}-yy`.length })

			// delete/modify — the remote modification resurrects the file.
			expect(result.finalLocal[`/dm/f${i}.txt`], `dm f${i}`).toMatchObject({ type: "file", size: `dm-REMOTE-modified-${i}`.length })

			// rename/rename to different targets — keep both, original gone.
			expect(result.finalRemote[`/rr/f${i}-local.txt`], `rr local f${i}`).toMatchObject({ type: "file" })
			expect(result.finalRemote[`/rr/f${i}-remote.txt`], `rr remote f${i}`).toMatchObject({ type: "file" })
			expect(result.finalRemote[`/rr/f${i}.txt`], `rr original f${i}`).toBeUndefined()
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LC2: an add/add storm — both sides create the SAME many paths with different content, newer wins, converges", async () => {
		const result = await runScenario({
			name: "LC2",
			mode: "twoWay",
			initialLocal: genNoise("existing", 20),
			steps: [
				runCycle(),
				localMutate(world => {
					for (let i = 0; i < N; i++) {
						// even → local newer (wins); odd → local older (remote wins).
						writeLocalAt(world, `fresh/a${i}.txt`, `aa-LOCAL-${i}-zz`, i % 2 === 0 ? NEW : OLD)
					}
				}),
				remoteMutate(world => {
					for (let i = 0; i < N; i++) {
						world.cloud.controls.addFile(`/fresh/a${i}.txt`, `aa-REMOTE-${i}`, { mtimeMs: i % 2 === 0 ? OLD : NEW })
					}
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		for (let i = 0; i < N; i++) {
			const winner = i % 2 === 0 ? `aa-LOCAL-${i}-zz` : `aa-REMOTE-${i}`

			expect(result.finalRemote[`/fresh/a${i}.txt`], `add/add a${i}`).toMatchObject({ type: "file", size: winner.length })
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
