import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { renameLocal, existsLocal } from "../harness/mutations"

/**
 * Category AN — ignore (.filenignore) crossed with move/rename (twoWay). Moving a synced file into an
 * ignored location, moving an ignored file out into a tracked one, renaming to/within an ignored name,
 * and moving between two ignored locations. Probes that the rename detector + ignore filter interact
 * without crashing, never touch the on-disk ignored copy, and converge on the TRACKED paths. Add-only.
 *
 * Note: snapshotLocal walks ALL on-disk files (ignored ones included), so finalLocal is NOT directly
 * comparable to finalRemote here — assertions target specific tracked/ignored paths instead.
 */
describe("Category AN — ignore × move/rename", () => {
	it("AN1: moving a synced file INTO an ignored directory leaves the on-disk copy untouched", async () => {
		const result = await runScenario({
			name: "AN1",
			mode: "twoWay",
			filenIgnore: "build/",
			initialLocal: { "/local/a.txt": "content-a", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "build/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// The file physically survives at its new (ignored) location — sync must never delete the local
		// bytes of a file the user moved into an ignored folder.
		expect(existsLocal(result.world, "build/a.txt")).toBe(true)
		// build/ never enters the remote tree.
		expect(result.finalRemote["/build"]).toBeUndefined()
		expect(result.finalRemote["/build/a.txt"]).toBeUndefined()
		// Policy: the file LEFT its synced path, so the old remote copy is dropped (unlike F13, where an
		// in-place file becomes ignored via a .filenignore edit and the remote copy is KEPT — there the
		// synced path itself is the ignored path and the delta ignore-filter protects it). No data loss:
		// the local bytes remain and moving back out re-uploads (AN2).
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		// The unrelated tracked file is unaffected.
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("AN2: moving an ignored file OUT to a tracked path uploads it", async () => {
		const result = await runScenario({
			name: "AN2",
			mode: "twoWay",
			filenIgnore: "build/",
			initialLocal: { "/local/build/secret.txt": "was-ignored", "/local/a.txt": "a" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "build/secret.txt", "secret.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Once out of the ignored dir it becomes a tracked addition and uploads.
		expect(result.finalRemote["/secret.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/secret.txt"]).toMatchObject({ type: "file" })
		expect(existsLocal(result.world, "build/secret.txt")).toBe(false)
	})

	it("AN3: renaming a tracked file to an ignored NAME leaves the on-disk copy untouched", async () => {
		const result = await runScenario({
			name: "AN3",
			mode: "twoWay",
			filenIgnore: "*.log",
			initialLocal: { "/local/app.txt": "logs", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "app.txt", "app.log")),
				runCycle(),
				runCycle()
			]
		})

		// The renamed-to-ignored file physically survives on disk.
		expect(existsLocal(result.world, "app.log")).toBe(true)
		expect(result.finalRemote["/app.log"]).toBeUndefined()
		// Same policy as AN1: the old tracked name's remote copy is dropped (the bytes moved to an ignored
		// name); no local data loss.
		expect(result.finalRemote["/app.txt"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("AN4: moving a file between two ignored directories is a complete no-op for sync", async () => {
		const result = await runScenario({
			name: "AN4",
			mode: "twoWay",
			filenIgnore: "build/\ndist/",
			initialLocal: { "/local/build/x.txt": "x", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "build/x.txt", "dist/x.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(existsLocal(result.world, "dist/x.txt")).toBe(true)
		// Neither ignored dir is ever synced; nothing transfers in the cycles after the move.
		expect(result.finalRemote["/build"]).toBeUndefined()
		expect(result.finalRemote["/dist"]).toBeUndefined()
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
