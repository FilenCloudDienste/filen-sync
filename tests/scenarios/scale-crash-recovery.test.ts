import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart, localMutate, remoteMutate, control, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { renameLocal, writeLocalAt } from "../harness/mutations"
import { genDirs, genNoise, mergeSpecs } from "../harness/scale"

/**
 * Category LZ — crash / restart mid-reconciliation (Category ZC) at SCALE. The engine has no write-ahead
 * log: the persisted base advances only after a zero-error cycle, so a crash mid-cycle leaves the base
 * BEHIND a partially-applied reality, and a fresh engine must re-derive every outstanding op from the stale
 * base. ZC pins this with 1–3 items; the at-least-once recovery re-deriving MANY ops at once (idempotent
 * re-uploads, no resurrection of already-applied deletes, no duplication) is unpinned. A crash is modelled
 * as a cycle where one op type is forced to fail (gating the save) while its many siblings land; restart()
 * reloads the stale base. twoWay; the crash-cycle premise is guarded so the test can't silently degrade.
 */
const SECOND = 1000

function settle(): Step[] {
	return [runCycle(), runCycle()]
}

describe("Category LZ — crash recovery, at scale", () => {
	it("LZ1: a big mixed cycle (many uploads land, a dir rename fails) heals with no loss or duplication on restart", async () => {
		const ADDS = 30
		const initialLocal = mergeSpecs(genDirs("legacy", 4, 5), genNoise("stable", 15))

		const result = await runScenario({
			name: "LZ1",
			mode: "twoWay",
			initialLocal,
			steps: [
				...settle(),
				localMutate(world => {
					for (let i = 0; i < ADDS; i++) {
						writeLocalAt(world, `incoming/file-${i}.txt`, `new-${i}`, BASE_TIME + (10 + i) * SECOND)
					}
				}),
				localMutate(world => renameLocal(world, "legacy", "legacy2")),
				// The dir rename throws → taskErrors > 0 → state.save() SKIPPED, but the 30 uploads landed.
				control(world => world.cloud.controls.setError("renameDirectory", new Error("crash: rename never reached the server"))),
				runCycle(),
				restart(),
				control(world => {
					world.cloud.controls.clearError("renameDirectory")
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Premise guard: the crash cycle (index 2, after 2 settle cycles) left PARTIAL state — uploads landed,
		// the rename did not.
		const crashCycle = result.cycles[2]!

		expect(crashCycle.remote["/incoming/file-0.txt"]).toMatchObject({ type: "file" })
		expect(crashCycle.remote["/legacy2"]).toBeUndefined()
		expect(crashCycle.remote["/legacy/d0/file-0.txt"]).toMatchObject({ type: "file" })

		// After recovery: every upload present exactly once, the dropped rename completed, no dup at the old path.
		for (let i = 0; i < ADDS; i++) {
			expect(result.finalRemote[`/incoming/file-${i}.txt`], `upload ${i}`).toMatchObject({ type: "file" })
		}

		expect(result.finalRemote["/legacy"]).toBeUndefined()
		expect(result.finalRemote["/legacy2/d0/file-0.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("LZ2: a crash after MANY individual file-deletes landed (the crash op is a failed rename) does NOT resurrect them", async () => {
		// 30 files live DIRECTLY under /data (kept), so deleting 20 of them emits 20 individual
		// deleteRemoteFile ops (no parent-collapse) — the at-least-once "already-applied deletes" set whose
		// non-resurrection we want to prove at scale. The crash point is a separate failed directory rename.
		const initialLocal: Record<string, string> = { "/local/movable/x.txt": "x" }

		for (let i = 0; i < 30; i++) {
			initialLocal[`/local/data/f${i}.txt`] = `data-${i}`
		}

		const result = await runScenario({
			name: "LZ2",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("keep", 15)),
			steps: [
				...settle(),
				localMutate(world => {
					// Delete the first 20 files (parent /data is KEPT → 20 separate deleteRemoteFile ops).
					for (let i = 0; i < 20; i++) {
						world.vfs.ifs.rmSync(`${world.localPath}/data/f${i}.txt`, { force: true })
					}
				}),
				localMutate(world => renameLocal(world, "movable", "movable2")),
				// The 20 file-trashes land; the directory rename throws → save skipped mid-reconciliation.
				control(world => world.cloud.controls.setError("renameDirectory", new Error("crash: rename never reached the server"))),
				runCycle(),
				restart(),
				control(world => {
					world.cloud.controls.clearError("renameDirectory")
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Premise guard: the crash cycle landed the 20 deletes but NOT the rename.
		const crashCycle = result.cycles[2]!

		expect(crashCycle.remote["/data/f0.txt"]).toBeUndefined()
		expect(crashCycle.remote["/data/f19.txt"]).toBeUndefined()
		expect(crashCycle.remote["/data/f20.txt"]).toMatchObject({ type: "file" })
		expect(crashCycle.remote["/movable2"]).toBeUndefined()

		// After recovery: the 20 already-applied deletes are NOT resurrected from the stale base, the kept
		// files survive, and the dropped rename completes.
		for (let i = 0; i < 20; i++) {
			expect(result.finalRemote[`/data/f${i}.txt`], `deleted ${i}`).toBeUndefined()
			expect(result.finalLocal[`/data/f${i}.txt`], `deleted ${i} local`).toBeUndefined()
		}

		for (let i = 20; i < 30; i++) {
			expect(result.finalRemote[`/data/f${i}.txt`], `kept ${i}`).toMatchObject({ type: "file" })
		}

		expect(result.finalRemote["/movable2/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/movable"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("LZ3: a crash with many un-synced changes on BOTH sides (base far behind reality both ways) converges", async () => {
		const result = await runScenario({
			name: "LZ3",
			mode: "twoWay",
			initialLocal: mergeSpecs(genNoise("base", 10)),
			steps: [
				...settle(),
				// Neither side ever synced these: the base only knows the 10 base files.
				localMutate(world => {
					for (let i = 0; i < 15; i++) {
						writeLocalAt(world, `localonly/l-${i}.txt`, `L-${i}`, BASE_TIME + (10 + i) * SECOND)
					}
				}),
				remoteMutate(world => {
					for (let i = 0; i < 15; i++) {
						world.cloud.controls.addFile(`/remoteonly/r-${i}.txt`, `R-${i}`, { mtimeMs: BASE_TIME + (10 + i) * SECOND })
					}
				}),
				restart(),
				control(world => world.triggerWatcher()),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Despite the stale base, both big un-synced batches are picked up from the real fs/remote — neither
		// is mistaken for a deletion, neither is lost.
		for (let i = 0; i < 15; i++) {
			expect(result.finalLocal[`/localonly/l-${i}.txt`], `local-only ${i}`).toMatchObject({ type: "file" })
			expect(result.finalLocal[`/remoteonly/r-${i}.txt`], `remote-only ${i}`).toMatchObject({ type: "file" })
		}

		expect(Object.keys(result.finalRemote).filter(path => path.startsWith("/base/")).length).toBe(10)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
