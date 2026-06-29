import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { writeLocal, rmLocal } from "../harness/mutations"
import { genDirs, genNoise, mergeSpecs, stripLocal, countUnder } from "../harness/scale"

/**
 * Category LB — the ADDITIVE backup modes (localBackup / cloudBackup) at SCALE. These never delete the
 * target and tolerate foreign edits/type-changes on it (directionalPush/Pull forces the source to win only
 * for ORIGINATED changes). V/X/ATC pin this with 1–2 items; what is unpinned is the directional-push +
 * never-delete + tolerate-foreign behavior over a big tree: a large source-side deletion must NOT propagate
 * (the target keeps every copy), large source additions/edits DO push, and foreign target churn is left
 * alone. These modes intentionally DIVERGE (the target accumulates), so the oracle is the per-item fate, not
 * convergence. add-only.
 */
describe("Category LB — additive backup modes, at scale", () => {
	it("LB1: localBackup — a big local deletion does NOT propagate (remote keeps all) while additions DO push", async () => {
		const result = await runScenario({
			name: "LB1",
			mode: "localBackup",
			initialLocal: mergeSpecs(genDirs("docs", 6, 5), genNoise("keep", 10)),
			steps: [
				runCycle(),
				localMutate(world => {
					// Delete an entire chunk locally (3 of the 6 dirs) and add a new batch.
					for (let d = 0; d < 3; d++) {
						rmLocal(world, `docs/d${d}`)
					}

					for (let i = 0; i < 12; i++) {
						writeLocal(world, `added/new-${i}.txt`, `new-${i}`)
					}
				}),
				runCycle(),
				runCycle()
			]
		})

		// Source deletions are NOT propagated: the remote still has every deleted file.
		for (let d = 0; d < 3; d++) {
			for (let f = 0; f < 5; f++) {
				expect(result.finalRemote[`/docs/d${d}/file-${f}.txt`], `kept-on-remote d${d} f${f}`).toMatchObject({ type: "file" })
			}
			// Locally they are gone.
			expect(result.finalLocal[`/docs/d${d}`], `local d${d} deleted`).toBeUndefined()
		}

		// Additions pushed.
		expect(countUnder(result.finalRemote, "/added/")).toBe(12)

		for (let i = 0; i < 12; i++) {
			expect(result.finalRemote[`/added/new-${i}.txt`]).toMatchObject({ type: "file" })
		}
	})

	it("LB2: cloudBackup — a big remote deletion does NOT propagate (local keeps all) while remote additions DO pull", async () => {
		const result = await runScenario({
			name: "LB2",
			mode: "cloudBackup",
			// Start from the remote so the source is the cloud (remote keys are rooted at `/`, not `/local`).
			initialRemote: stripLocal(mergeSpecs(genDirs("docs", 6, 5), genNoise("keep", 10))),
			steps: [
				runCycle(),
				remoteMutate(world => {
					for (let d = 0; d < 3; d++) {
						world.cloud.controls.trashPath(`/docs/d${d}`)
					}

					for (let i = 0; i < 12; i++) {
						world.cloud.controls.addFile(`/added/new-${i}.txt`, `new-${i}`)
					}
				}),
				runCycle(),
				runCycle()
			]
		})

		// Remote (source) deletions are NOT propagated: the local copy keeps everything.
		for (let d = 0; d < 3; d++) {
			for (let f = 0; f < 5; f++) {
				expect(result.finalLocal[`/docs/d${d}/file-${f}.txt`], `kept-on-local d${d} f${f}`).toMatchObject({ type: "file" })
			}
		}

		// Remote additions pulled.
		expect(countUnder(result.finalLocal, "/added/")).toBe(12)
	})

	it("LB3: localBackup tolerates many FOREIGN remote edits (never reverts) while pushing originated changes", async () => {
		const result = await runScenario({
			name: "LB3",
			mode: "localBackup",
			initialLocal: genDirs("sync", 1, 16),
			steps: [
				runCycle(),
				remoteMutate(world => {
					// Foreign edits on the target (remote) — additive mode must NOT revert these.
					for (let f = 0; f < 8; f++) {
						world.cloud.controls.updateFile(`/sync/d0/file-${f}.txt`, `FOREIGN-EDIT-${f}-longer`)
					}
				}),
				localMutate(world => {
					// Source originates edits on the OTHER half — these push.
					for (let f = 8; f < 16; f++) {
						writeLocal(world, `sync/d0/file-${f}.txt`, `LOCAL-EDIT-${f}-longer`)
					}
				}),
				runCycle(),
				runCycle()
			]
		})

		// Foreign edits tolerated: the remote keeps the FOREIGN content (not reverted to the local copy).
		for (let f = 0; f < 8; f++) {
			expect(result.finalRemote[`/sync/d0/file-${f}.txt`], `foreign-tolerated ${f}`).toMatchObject({
				type: "file",
				size: `FOREIGN-EDIT-${f}-longer`.length
			})
		}

		// Originated edits pushed.
		for (let f = 8; f < 16; f++) {
			expect(result.finalRemote[`/sync/d0/file-${f}.txt`], `originated-pushed ${f}`).toMatchObject({
				type: "file",
				size: `LOCAL-EDIT-${f}-longer`.length
			})
		}
	})
})
