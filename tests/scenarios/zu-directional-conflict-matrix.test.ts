import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category ZU — the conflict matrix under the DIRECTIONAL modes (mode × conflict enumeration).
 *
 * The twoWay conflict matrix (Category Y) is fully covered, but its resolutions are twoWay-specific —
 * notably "a newer modify beats a delete" (F7). The four directional modes resolve the SAME conflicts
 * differently and must NOT inherit twoWay's tiebreaks (the F5 class of bug was exactly such a leak):
 *  - strict mirrors (localToCloud / cloudToLocal): the AUTHORITATIVE side wins outright — its delete
 *    deletes the peer's concurrent edit; its edit resurrects the peer's concurrent delete.
 *  - additive backups (localBackup / cloudBackup): a source-side delete NEVER propagates even when the
 *    target was concurrently edited; the target's copy is kept.
 * These pin the delete×modify cells for all four directional modes. add-only.
 */
describe("Category ZU — directional-mode conflict matrix", () => {
	it("ZU1: localToCloud — a local DELETE beats a concurrent foreign remote modify (mirror authority)", async () => {
		const result = await runScenario({
			name: "ZU1",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "foreign-remote-edit")),
				runCycle(),
				runCycle()
			]
		})

		// Local is authoritative and it deleted the file — the foreign remote edit must NOT resurrect it
		// (that would be the twoWay rule). The remote is mirrored to the local's deletion.
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
	})

	it("ZU2: localToCloud — a local MODIFY beats a concurrent foreign remote delete (resurrected on remote)", async () => {
		const result = await runScenario({
			name: "ZU2",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "a.txt", "local-v2")),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Local is authoritative and it modified the file — the foreign remote delete must NOT win; the file
		// is re-created on the remote with the local content.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "local-v2".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "local-v2".length })
	})

	it("ZU3: cloudToLocal — a remote DELETE beats a concurrent foreign local modify (mirror authority)", async () => {
		const result = await runScenario({
			name: "ZU3",
			mode: "cloudToLocal",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				localMutate(world => writeLocal(world, "a.txt", "foreign-local-edit")),
				runCycle(),
				runCycle()
			]
		})

		// Remote is authoritative and it deleted the file — the foreign local edit must NOT keep it alive.
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
	})

	it("ZU4: cloudToLocal — a remote MODIFY beats a concurrent foreign local delete (re-downloaded)", async () => {
		const result = await runScenario({
			name: "ZU4",
			mode: "cloudToLocal",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "remote-v2")),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Remote is authoritative and it modified the file — the foreign local delete must NOT win; the file
		// is re-downloaded with the remote content.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "remote-v2".length })
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "remote-v2".length })
	})

	it("ZU5: localBackup — a local DELETE does NOT propagate even when the remote was concurrently modified", async () => {
		const result = await runScenario({
			name: "ZU5",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "foreign-remote-edit")),
				runCycle(),
				runCycle()
			]
		})

		// Additive backup: a source-side delete never deletes the target. The remote backup is kept (and its
		// foreign edit tolerated); the local stays deleted. The sides intentionally differ.
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
	})

	it("ZU6: cloudBackup — a remote DELETE does NOT propagate even when the local was concurrently modified", async () => {
		const result = await runScenario({
			name: "ZU6",
			mode: "cloudBackup",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				localMutate(world => writeLocal(world, "a.txt", "local-edit")),
				runCycle(),
				runCycle()
			]
		})

		// Additive backup (remote→local): a source-side (remote) delete never deletes the local target. The
		// local copy is kept with its concurrent edit.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
	})
})
