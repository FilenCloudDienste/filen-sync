import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { touchLocal, renameLocal, rmLocal } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category TI — the TOUCH (mtime-only, no content change) row/column of the same-path conflict matrix.
 *
 * Touch is subtle because the engine's change detection is ASYMMETRIC: a LOCAL change is size+whole-second
 * mtime (so a local bare touch IS visible), but a REMOTE change is a new uuid (so a remote bare touch —
 * `touchRemote`, metadata only — is INVISIBLE). These pin every cell where a bare touch on one side races a
 * real op on the other. The defining property: a bare touch is NOT a content change, so it never resurrects
 * a deletion and never wins a conflict — but a LOCAL touch still perturbs the local-change signal enough to
 * suppress a server-side rename (forcing a re-download), while a REMOTE touch is simply absorbed.
 *
 * Where a touch leaves only an mtime-metadata difference with identical content (TI2/TI6), that residual
 * mtime divergence is the accepted §C11 limit (the engine never re-hashes in the hot path) — those assert
 * CONTENT + STRUCTURE convergence, not whole-second mtime equality.
 */
const SECOND = 1000

describe("Category TI — touch (mtime-only) conflict cells", () => {
	it("TI1: local TOUCH + remote RENAME P→Q → the rename wins (content re-lands at Q), touch ignored", async () => {
		const result = await runScenario({
			name: "TI1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "CONTENT" },
			steps: [
				runCycle(), // upload a.txt (caches its hash so the resurrect check can confirm "unchanged")
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME + 500 * SECOND)),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// A bare touch is not a content change, so the remote rename wins: P is gone, the content lands at Q.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "CONTENT".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("TI2: local RENAME P→Q + remote TOUCH P (no new uuid) → the rename propagates cleanly, content survives", async () => {
		const result = await runScenario({
			name: "TI2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "CONTENT" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.touchRemote("/a.txt", BASE_TIME + 500 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The metadata-only remote touch (uuid unchanged) does not block the rename; the file lands at Q on
		// both sides with its content intact (a residual mtime-only difference is the accepted C11 limit).
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "CONTENT".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/b.txt"]).toMatchObject({ type: "file", size: "CONTENT".length })
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/b.txt"]!.contentHash).toBe(result.finalRemote["/b.txt"]!.contentHash)
	})

	it("TI3: local TOUCH P + remote DELETE P → the delete proceeds (a bare touch does NOT resurrect)", async () => {
		const result = await runScenario({
			name: "TI3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "CONTENT", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME + 500 * SECOND)),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// A content change resurrects a deletion (AJ); a bare mtime touch does not — the file is gone on both.
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("TI4: local DELETE P + remote TOUCH P (no new uuid) → the delete propagates (the touch is uuid-invisible)", async () => {
		const result = await runScenario({
			name: "TI4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "CONTENT", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.touchRemote("/a.txt", BASE_TIME + 500 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote touch mints no new uuid, so it is not a "modify" that could beat the delete — P is gone.
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("TI5: local TOUCH P + remote MODIFY P (real content, new uuid) → the remote content change wins", async () => {
		const result = await runScenario({
			name: "TI5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "ORIGINAL" },
			steps: [
				runCycle(),
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME + 500 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-REAL-EDIT", { mtimeMs: BASE_TIME + 200 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// A real remote content change beats a local bare touch (content always beats mtime-only).
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-REAL-EDIT".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("TI6: BOTH sides TOUCH P (no content change) → no transfer (bare touches don't churn the sync)", async () => {
		const result = await runScenario({
			name: "TI6",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "CONTENT" },
			steps: [
				runCycle(),
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME + 500 * SECOND)),
				remoteMutate(world => world.cloud.controls.touchRemote("/a.txt", BASE_TIME + 600 * SECOND)),
				runCycle(),
				runCycle()
			]
		})

		// Neither bare touch is a content change, so no upload/download is ever started; content stays intact.
		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)

		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "CONTENT".length })
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("TI8: local TOUCH of a DOWNLOADED file (no cached hash) + remote MODIFY → the real remote edit still wins", async () => {
		const result = await runScenario({
			name: "TI8",
			mode: "twoWay",
			// Seeded on the REMOTE → downloaded locally → the engine caches a hash only on UPLOAD, so this
			// file has NO local hash. Pre-fix, the local touch (newer mtime, unconfirmable) uploaded the stale
			// bytes and OVERWROTE the remote edit (silent data loss). The no-cache extension defers an
			// unconfirmable same-size local change to the confirmed remote edit.
			initialRemote: { "/a.txt": "ORIGINAL" },
			steps: [
				runCycle(), // download (no hash cached for a downloaded file)
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME + 500 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-REAL-EDIT", { mtimeMs: BASE_TIME + 200 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The real remote content edit wins on both sides; the unconfirmable local touch never clobbers it.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-REAL-EDIT".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("TI7: local TOUCH P (file) + remote TYPE-CHANGE P (file→dir) → the type change wins (newer data)", async () => {
		const result = await runScenario({
			name: "TI7",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "CONTENT" },
			steps: [
				runCycle(),
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME + 500 * SECOND)),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/a.txt")
					world.cloud.controls.addFile("/a.txt/child.txt", "CHILD")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// A file→dir type change is newer data and beats a bare local touch — P becomes a directory on both sides.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/a.txt/child.txt"]).toMatchObject({ type: "file", size: "CHILD".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
