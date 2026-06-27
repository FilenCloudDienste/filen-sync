import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds } from "../harness/snapshot"
import { writeLocalAt, renameLocal, rmLocal, readLocal, existsLocal } from "../harness/mutations"

/**
 * Category Y — the cross-side conflict matrix for twoWay (behavioral spec §C/§D/§E intersection). Every
 * case here is a SAME-PATH (or same-identity) conflict where both sides acted since the last sync, plus
 * the single-cycle rename+modify race. The engine must always reach a fixed point (finalLocal ===
 * finalRemote) with NO silent data loss. Resolution policies (confirmed with the maintainer):
 *
 *   • newest-mtime wins for add-vs-add and modify-vs-modify (equal whole-second → local, §C6);
 *   • a real CONTENT modification on EITHER side beats the other side's delete (resurrect) — symmetric;
 *   • a rename whose source the other side deleted/modified/renamed degrades to keep-the-data (the
 *     renamed file is re-added under its new name; the other side's change is applied too) so the worlds
 *     still converge with both edits preserved;
 *   • rename + in-place modify of the SAME file in ONE cycle keeps BOTH (the new name AND the new bytes).
 *
 * These pin the fixes for F1–F4/F7 (docs/hardening-findings.md). Convergence + no-data-loss is the
 * invariant; exact surviving paths are asserted where the policy fixes them.
 */
const SECOND = 1000

describe("Category Y — cross-side conflict matrix (twoWay)", () => {
	it("Y1: add(local) vs add(remote) same path, local newer → local content wins, converges", async () => {
		const result = await runScenario({
			name: "Y1",
			mode: "twoWay",
			steps: [
				localMutate(world => writeLocalAt(world, "x.txt", "LOCAL-NEWER", BASE_TIME + 5 * SECOND)),
				remoteMutate(world => world.cloud.controls.addFile("/x.txt", "remote-older", { mtimeMs: BASE_TIME + 2 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/x.txt"]).toMatchObject({ type: "file", size: "LOCAL-NEWER".length })
	})

	it("Y2: add(local) vs add(remote) same path, remote newer → remote content wins, converges", async () => {
		const result = await runScenario({
			name: "Y2",
			mode: "twoWay",
			steps: [
				localMutate(world => writeLocalAt(world, "x.txt", "local-older", BASE_TIME + 2 * SECOND)),
				remoteMutate(world => world.cloud.controls.addFile("/x.txt", "REMOTE-NEWER-LONGER", { mtimeMs: BASE_TIME + 5 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/x.txt"]).toMatchObject({ type: "file", size: "REMOTE-NEWER-LONGER".length })
	})

	it("Y3: delete(local) vs delete(remote) same path → converges to empty, no error", async () => {
		const result = await runScenario({
			name: "Y3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "data" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// F7 — symmetric resurrect: a remote modification beats a local delete (mirror of OBS-001/D8).
	it("Y4: delete(local) vs modify(remote, newer) → the remote modification wins, resurrected", async () => {
		const result = await runScenario({
			name: "Y4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-MODIFIED-NEWER", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-MODIFIED-NEWER".length })
		expect(readLocal(result.world, "a.txt")).toBe("REMOTE-MODIFIED-NEWER")
	})

	// The pre-existing direction (OBS-001) stays correct: a local modification beats a remote delete.
	it("Y5: modify(local) vs delete(remote) → the local modification wins, resurrected", async () => {
		const result = await runScenario({
			name: "Y5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-MODIFIED-LONGER", BASE_TIME + 9 * SECOND)),
				remoteMutate(world => world.cloud.controls.deletePath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-MODIFIED-LONGER".length })
	})

	// F1 — rename + in-place modify of the SAME file in ONE cycle: keep the new name AND the new bytes.
	it("Y6: rename(local a→b) + modify b in one cycle → converges to b with the NEW content", async () => {
		const result = await runScenario({
			name: "Y6",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original-content" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "b.txt")
					writeLocalAt(world, "b.txt", "BRAND-NEW-CONTENT-X", BASE_TIME + 5 * SECOND)
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "BRAND-NEW-CONTENT-X".length })
		expect(readLocal(result.world, "b.txt")).toBe("BRAND-NEW-CONTENT-X")
	})

	// F2 — local rename a→b races a remote delete of a. The renamed file (b) is data the user kept, so
	// it survives on both sides; the remote's delete of the old name is moot.
	it("Y7: rename(local a→b) vs delete(remote a) → converges to {b}, data preserved", async () => {
		const result = await runScenario({
			name: "Y7",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "data" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "data".length })
		expect(existsLocal(result.world, "b.txt")).toBe(true)
	})

	// F3 — local rename a→b races a remote modify of a. Keep-both: the remote's new content survives at
	// a, the local rename result survives at b. No silent loss either way.
	it("Y8: rename(local a→b) vs modify(remote a) → converges keeping both a and b", async () => {
		const result = await runScenario({
			name: "Y8",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "orig" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-MOD", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-MOD".length })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "orig".length })
	})

	// F4 — both sides rename the same file to DIFFERENT names. Keep-both: each rename is preserved.
	it("Y9: rename(local a→X) vs rename(remote a→Y) → converges keeping both X and Y", async () => {
		const result = await runScenario({
			name: "Y9",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "data" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "local-name.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/remote-name.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/local-name.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/remote-name.txt"]).toMatchObject({ type: "file" })
	})

	// F2 symmetric — remote rename a→b races a local delete of a.
	it("Y10: rename(remote a→b) vs delete(local a) → converges to {b}, data preserved", async () => {
		const result = await runScenario({
			name: "Y10",
			mode: "twoWay",
			initialRemote: { "/a.txt": "data" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "data".length })
	})

	// F3 symmetric — remote rename a→b races a local modify of a.
	it("Y11: rename(remote a→b) vs modify(local a) → converges keeping both a and b", async () => {
		const result = await runScenario({
			name: "Y11",
			mode: "twoWay",
			initialRemote: { "/a.txt": "orig" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-MOD", BASE_TIME + 9 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-MOD".length })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "orig".length })
	})

	// Convergence under a same-cycle delete on one side and an unrelated add on the other (no false conflict).
	it("Y12: delete(local a) + add(remote b) in one cycle → both applied, converges", async () => {
		const result = await runScenario({
			name: "Y12",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "data" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.addFile("/b.txt", "new-remote", { mtimeMs: BASE_TIME + 3 * SECOND })),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
	})

	// A second settling pass must be a true fixed point for a representative conflict (idempotence).
	it("Y13: a resolved conflict is idempotent (no work on the next settled cycle)", async () => {
		const result = await runScenario({
			name: "Y13",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-WINS", { mtimeMs: BASE_TIME + 9 * SECOND })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		// The last cycle did no file transfers.
		const last = result.cycles[result.cycles.length - 1]!

		expect(transferKinds(last.messages).filter(k => ["upload", "uploadFile", "download", "downloadFile"].includes(k))).toEqual([])
	})
})
