import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart, localMutate, remoteMutate, control, type Step } from "../harness/runner"
import { writeLocalAt, renameLocal, rmLocal } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

const SECOND = 1000

/**
 * Category ZC — crash / stop mid-run recovery.
 *
 * The engine has no write-ahead log; instead it relies on a single invariant: the persisted base
 * (`previousLocalTree`/`previousRemoteTree`) is advanced ONLY at the end of a cycle that had ZERO task
 * errors (`sync.ts` — `if (this.taskErrors.length === 0) { ... state.save() }`). So if the process is
 * killed — or the user stops the sync — mid-cycle, the on-disk base stays at the LAST CLEAN cycle while
 * the real filesystem / remote may already be partially advanced. On the next boot a fresh engine loads
 * that stale base, re-scans both sides, and re-derives whatever work is still outstanding. The recovery
 * is "at-least-once": an already-applied transfer may be re-derived, but it converges with no data loss
 * and no duplication.
 *
 * A crash is modelled faithfully by (1) running a cycle in which one task fails — which gates the cycle
 * and SKIPS the state save while OTHER tasks in the same cycle have already hit the fake cloud — then
 * (2) `restart()`, which rebuilds the engine over the SAME virtual fs + cloud and reloads the (stale)
 * persisted base, discarding all in-memory cycle progress. That on-disk outcome (base behind reality,
 * in-memory state gone) is identical to a hard `kill -9` between task application and the state save.
 *
 * Distinct from Category S (restart between SETTLED cycles, where base == reality and the first cycle is
 * a trivial no-op): here the base is deliberately BEHIND reality, exercising the self-heal path.
 */

function settle(): Step[] {
	return [runCycle(), runCycle()]
}

describe("Category ZC — crash / stop mid-run recovery", () => {
	it("ZC1: a crash after a partially-applied cycle (upload landed, rename did not, state NOT saved) heals on restart", async () => {
		const result = await runScenario({
			name: "ZC1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "a", "/local/dir/c.txt": "c" },
			steps: [
				...settle(),
				// Two INDEPENDENT local changes in one cycle: add new.txt (its upload lands on the fake
				// remote) and rename dir -> dir2 (the remote rename is forced to fail = the "crash" point).
				localMutate(world => writeLocalAt(world, "new.txt", "fresh", BASE_TIME + 10 * SECOND)),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				control(world => world.cloud.controls.setError("renameDirectory", new Error("crash: rename never reached the server"))),
				// new.txt uploads; the dir rename throws -> taskErrors > 0 -> state.save() is SKIPPED.
				runCycle(),
				// Process dies here: in-memory progress is discarded and the on-disk base is still PRE-cycle.
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

		// Guard the premise: the crash cycle (index 2, after the two settle cycles) genuinely left PARTIAL
		// state — new.txt's upload reached the remote, but the rename did not. Without this the test could
		// silently degrade into "everything just syncs after a restart".
		const crashCycle = result.cycles[2]!

		expect(crashCycle.remote["/new.txt"]).toMatchObject({ type: "file" })
		expect(crashCycle.remote["/dir/c.txt"]).toMatchObject({ type: "file" })
		expect(crashCycle.remote["/dir2"]).toBeUndefined()

		// No loss, no duplication: the already-uploaded file survives exactly once, the lost rename
		// completes, and the stale base is fully reconciled.
		expect(result.finalRemote["/new.txt"]).toMatchObject({ type: "file", size: "fresh".length })
		expect(result.finalRemote["/dir2/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/c.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZC2: a crash with un-synced changes on BOTH sides (base behind reality both ways) converges on restart", async () => {
		const result = await runScenario({
			name: "ZC2",
			mode: "twoWay",
			initialLocal: { "/local/base.txt": "base" },
			steps: [
				...settle(),
				// Both sides change, but the engine dies before ANY cycle syncs them: the on-disk base only
				// knows base.txt, yet local has local-only.txt and the remote has remote-only.txt.
				localMutate(world => writeLocalAt(world, "local-only.txt", "L", BASE_TIME + 10 * SECOND)),
				remoteMutate(world => world.cloud.controls.addFile("/remote-only.txt", "R", { mtimeMs: BASE_TIME + 10 * SECOND })),
				restart(),
				control(world => world.triggerWatcher()),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Both un-synced additions are picked up from the real fs/remote despite the stale base — neither
		// is lost, and the deleted-detection gate does NOT mistake "present but not in base" for a deletion.
		expect(result.finalLocal["/local-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/remote-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/base.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/local-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/remote-only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZC3: a crash mid-deletion (one delete applied, one failed, state NOT saved) does NOT resurrect on restart", async () => {
		const result = await runScenario({
			name: "ZC3",
			mode: "twoWay",
			initialLocal: {
				"/local/gone.txt": "g",
				"/local/keepdir/k.txt": "k",
				"/local/deldir/d.txt": "d"
			},
			steps: [
				...settle(),
				// Delete a file AND a directory locally in one cycle; the remote DIR-trash fails (crash),
				// but the remote FILE-trash lands — so gone.txt is already removed remotely when we die.
				localMutate(world => rmLocal(world, "gone.txt")),
				localMutate(world => rmLocal(world, "deldir")),
				control(world => world.cloud.controls.setError("trashDirectory", new Error("crash: dir delete never reached the server"))),
				runCycle(),
				// Reload the stale base: it still lists gone.txt AND deldir as present on BOTH sides.
				restart(),
				control(world => {
					world.cloud.controls.clearError("trashDirectory")
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Guard the premise: the crash cycle genuinely left a HALF-APPLIED deletion — gone.txt was already
		// trashed remotely, but deldir was not.
		const crashCycle = result.cycles[2]!

		expect(crashCycle.remote["/gone.txt"]).toBeUndefined()
		expect(crashCycle.remote["/deldir/d.txt"]).toMatchObject({ type: "file" })

		// The already-applied file deletion must NOT be resurrected from the stale base (both sides
		// genuinely removed it); the pending dir deletion completes; untouched data is preserved.
		expect(result.finalRemote["/gone.txt"]).toBeUndefined()
		expect(result.finalLocal["/gone.txt"]).toBeUndefined()
		expect(result.finalRemote["/deldir"]).toBeUndefined()
		expect(result.finalRemote["/deldir/d.txt"]).toBeUndefined()
		expect(result.finalRemote["/keepdir/k.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZC4: localToCloud — a crash after a partially-applied cycle heals on restart (mirror still converges)", async () => {
		const result = await runScenario({
			name: "ZC4",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "a", "/local/dir/c.txt": "c" },
			steps: [
				...settle(),
				localMutate(world => writeLocalAt(world, "new.txt", "fresh", BASE_TIME + 10 * SECOND)),
				localMutate(world => renameLocal(world, "dir", "dir2")),
				control(world => world.cloud.controls.setError("renameDirectory", new Error("crash"))),
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

		// Guard the premise: the crash cycle left partial state (upload landed, rename did not).
		const crashCycle = result.cycles[2]!

		expect(crashCycle.remote["/new.txt"]).toMatchObject({ type: "file" })
		expect(crashCycle.remote["/dir2"]).toBeUndefined()

		// The local mirror is authoritative: after the crash the remote is brought back into line with it,
		// the dropped rename completes, and the partially-uploaded file is present exactly once.
		expect(result.finalRemote["/new.txt"]).toMatchObject({ type: "file", size: "fresh".length })
		expect(result.finalRemote["/dir2/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
