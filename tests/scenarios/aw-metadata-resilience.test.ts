import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control } from "../harness/runner"

/**
 * Category AW — remote metadata decryption resilience (twoWay). When the SDK cannot decrypt a remote
 * item's metadata (a corrupted entry, or a transient crypto fault), the tree builder skips it. The
 * danger: a skipped item is ABSENT from the current remote tree, which looks identical to a deletion — so
 * a transient decrypt failure must NOT cause the engine to delete the previously-synced LOCAL copy (silent
 * data loss). It must also not crash the cycle, and must recover once decryption succeeds again.
 *
 * Decrypt faults are injected with `setError("fileMetadata" / "folderMetadata")` — fault injection, so
 * this is a mocked-only category by nature (the real backend's metadata is valid and can't be corrupted
 * on demand), the same accepted boundary as the O/Q SDK-fault categories. Add-only.
 */
describe("Category AW — remote metadata decrypt resilience", () => {
	it("AW1: a remote file whose metadata fails to decrypt does NOT delete the synced local copy", async () => {
		const result = await runScenario({
			name: "AW1",
			mode: "twoWay",
			initialLocal: { "/local/doc.txt": "important", "/local/keep.txt": "k" },
			steps: [
				runCycle(), // upload both; now in the persisted base on both sides
				control(world => world.cloud.controls.setError("fileMetadata", new Error("decrypt boom"))),
				runCycle(),
				runCycle()
			]
		})

		// The remote copies became unreadable, but the local files must survive — an unreadable item is not
		// a deletion.
		expect(result.finalLocal["/doc.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("AW2: a remote folder whose metadata fails to decrypt does not delete the local subtree or crash", async () => {
		const result = await runScenario({
			name: "AW2",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "c", "/local/root.txt": "r" },
			steps: [
				runCycle(),
				control(world => world.cloud.controls.setError("folderMetadata", new Error("folder decrypt boom"))),
				runCycle(),
				runCycle()
			]
		})

		// The folder became unresolvable; its local subtree must not be wiped.
		expect(result.finalLocal["/dir/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/root.txt"]).toMatchObject({ type: "file" })
	})

	it("AW3: once decryption recovers, the sync resumes and converges", async () => {
		const result = await runScenario({
			name: "AW3",
			mode: "twoWay",
			initialLocal: { "/local/doc.txt": "important" },
			steps: [
				runCycle(),
				control(world => world.cloud.controls.setError("fileMetadata", new Error("decrypt boom"))),
				runCycle(),
				control(world => world.cloud.controls.clearError("fileMetadata")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/doc.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/doc.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
