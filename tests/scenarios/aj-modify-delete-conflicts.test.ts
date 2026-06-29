import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { writeLocalAt, rmLocal } from "../harness/mutations"

/**
 * Category AJ — modify-vs-delete conflicts (twoWay). The engine's policy (F7 / E2E-OBS-001) is "a newer
 * modify beats a delete, in either direction": the modified file/child survives and is resurrected on
 * the deleting side. A directory delete that races a surviving child-modify must keep the directory. The
 * modifications here change byte-SIZE so the change is detected via the cheap size signal (no hot-path
 * hashing). Add-only.
 */
describe("Category AJ — modify-vs-delete conflicts", () => {
	it("AJ1: local modifies a file while the remote deletes it — the modification wins (file survives)", async () => {
		const result = await runScenario({
			name: "AJ1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "a-much-longer-edited-body", 1_700_000_500_000)),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		// The surviving content is the local edit (re-uploaded), matched on both sides.
		expect(result.finalRemote["/a.txt"]!.contentHash).toBe(result.finalLocal["/a.txt"]!.contentHash)
	})

	it("AJ2: remote modifies a file while the local deletes it — the modification wins (file resurrected)", async () => {
		const result = await runScenario({
			name: "AJ2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "a.txt")),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "remote-edited-much-longer-body")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AJ3: remote deletes a directory while the local modifies a child in it — child survives, dir kept", async () => {
		const result = await runScenario({
			name: "AJ3",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "v1", "/local/dir/other.txt": "o" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "dir/child.txt", "child-locally-edited-longer", 1_700_000_500_000)),
				remoteMutate(world => world.cloud.controls.trashPath("/dir")),
				runCycle(),
				runCycle()
			]
		})

		// The modified child beats the directory delete → the directory is re-asserted to hold it; the
		// unmodified sibling the remote deleted is gone.
		expect(result.finalRemote["/dir/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/other.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AJ4: local deletes a directory while the remote modifies a child in it — child survives, dir kept", async () => {
		const result = await runScenario({
			name: "AJ4",
			mode: "twoWay",
			initialLocal: { "/local/dir/child.txt": "v1", "/local/dir/other.txt": "o" },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "dir")),
				remoteMutate(world => world.cloud.controls.updateFile("/dir/child.txt", "child-remotely-edited-longer")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/dir/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/dir/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/other.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AJ5: local edits a file while the remote renames it — keeps both (edit at old path, original at new)", async () => {
		const result = await runScenario({
			name: "AJ5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				localMutate(world => writeLocalAt(world, "a.txt", "locally-edited-longer-body", 1_700_000_500_000)),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote rename can't fire over a locally-edited source (F2–F4), so it is not propagated;
		// instead both survive: the edit at the original path and the renamed original at the new path.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
