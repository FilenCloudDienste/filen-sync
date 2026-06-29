import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart, localMutate, remoteMutate } from "../harness/runner"
import { writeLocalAt, rmLocal, mkdirLocal, writeLocal, touchLocal } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category RC — a process RESTART interleaved with a NON-structural cross-side conflict (delete-vs-modify,
 * type-change, add-vs-add, modify-vs-modify). RS pins restart amid a RENAME/MOVE/SWAP; ZC pins crash amid a
 * partial single-op. The gap here is a restart DURING an unresolved CONFLICT — where both sides changed the
 * same path and the engine has not yet picked a winner. The restart reloads the persisted base from disk and
 * re-derives the conflict against the actual current state; recovery is at-least-once, so the SAME winner
 * must emerge and the sides converge with no data loss.
 */
const SECOND = 1000

describe("Category RC — restart amid a non-structural conflict", () => {
	it("RC1: restart amid a local-modify-vs-remote-delete conflict → the modify still resurrects, converges", async () => {
		const result = await runScenario({
			name: "RC1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "ORIG", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-MODIFIED-LONGER", BASE_TIME + 100 * SECOND)),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				restart(), // reload base before the conflict is resolved
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// A newer content edit beats a delete (AJ) — the restart must not lose that: the file survives on both.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-MODIFIED-LONGER".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("RC2: restart amid a remote-modify-vs-local-delete conflict → the modify still resurrects (symmetric)", async () => {
		const result = await runScenario({
			name: "RC2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "ORIG", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-MODIFIED-LONGER", { mtimeMs: BASE_TIME + 100 * SECOND })),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-MODIFIED-LONGER".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("RC3: restart amid a type-change conflict (local file→dir vs remote edit) → converges", async () => {
		const result = await runScenario({
			name: "RC3",
			mode: "twoWay",
			initialLocal: { "/local/x": "FILE", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					mkdirLocal(world, "x")
					writeLocal(world, "x/child.txt", "CHILD")
				}),
				remoteMutate(world => world.cloud.controls.updateFile("/x", "REMOTE-EDIT", { mtimeMs: BASE_TIME + 50 * SECOND })),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The local type change (file→dir) is newer structural data; the restart must not corrupt the
		// resolution — x converges to a directory holding the child on both sides.
		expect(result.finalRemote["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/x/child.txt"]).toMatchObject({ type: "file", size: "CHILD".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("RC4: restart amid an add-vs-add conflict (different content, local newer) → newer wins, converges", async () => {
		const result = await runScenario({
			name: "RC4",
			mode: "twoWay",
			initialLocal: {},
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "both.txt", "LOCAL-NEWER-WINS", BASE_TIME + 200 * SECOND)),
				remoteMutate(world => world.cloud.controls.addFile("/both.txt", "remote-older", { mtimeMs: BASE_TIME + 100 * SECOND })),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The strictly-newer local add wins on both sides; the restart re-derives the same resolution.
		expect(result.finalRemote["/both.txt"]).toMatchObject({ type: "file", size: "LOCAL-NEWER-WINS".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/both.txt"]!.contentHash).toBe(result.finalRemote["/both.txt"]!.contentHash)
	})

	it("RC5: restart amid a local-touch-vs-remote-edit conflict → the real remote edit still wins, converges", async () => {
		const result = await runScenario({
			name: "RC5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "ORIGINAL" },
			steps: [
				runCycle(), // upload (caches the hash)
				localMutate(world => touchLocal(world, "a.txt", BASE_TIME + 500 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-REAL-EDIT", { mtimeMs: BASE_TIME + 200 * SECOND })),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The TI5 fix must survive a restart: the bare local touch never strands the real remote edit.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-REAL-EDIT".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
