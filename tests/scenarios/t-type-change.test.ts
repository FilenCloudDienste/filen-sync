import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category T — type changes at a path (file ↔ directory). The path exists on BOTH sides but as
 * different types, so the rename pass (inode/uuid differ), the deletion passes (path still present),
 * and the addition passes (other side's same-path item exists) all miss it. Without dedicated
 * handling the stale-type item lingers and its replacement can't be created (E2E-BUG-001).
 *
 * The fix attributes the change against the last-synced base (whoever's type diverged from base is
 * authoritative; local wins a tie/both), deletes the stale-type item, and creates the new type from
 * the authoritative side. The phase-ordered executor guarantees the delete runs before the create.
 */
describe("Category T — file ↔ directory type changes", () => {
	it("T1: local file → directory (remote still a file) replaces the remote file with the directory", async () => {
		const result = await runScenario({
			name: "T1",
			mode: "twoWay",
			initialLocal: { "/local/thing": "i am a file" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "thing")
					writeLocal(world, "thing/inside.txt", "now a dir")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/thing"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/thing/inside.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("T2: local directory → file (remote still a directory with children) replaces the tree with the file", async () => {
		const result = await runScenario({
			name: "T2",
			mode: "twoWay",
			initialLocal: { "/local/thing/a.txt": "child a", "/local/thing/b.txt": "child b" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "thing")
					writeLocal(world, "thing", "now a file")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/thing"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/thing/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/thing/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("T3: remote file → directory (local still a file) replaces the local file with the directory", async () => {
		const result = await runScenario({
			name: "T3",
			mode: "twoWay",
			initialLocal: { "/local/thing": "i am a file" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/thing")
					world.cloud.controls.addDir("/thing")
					world.cloud.controls.addFile("/thing/inside.txt", "remote dir now")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/thing"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/thing/inside.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("T4: remote directory → file (local still a directory with children) replaces the tree with the file", async () => {
		const result = await runScenario({
			name: "T4",
			mode: "twoWay",
			initialLocal: { "/local/thing/a.txt": "child a", "/local/thing/b.txt": "child b" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/thing")
					world.cloud.controls.addFile("/thing", "now a file")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/thing"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/thing/a.txt"]).toBeUndefined()
		expect(result.finalLocal["/thing/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("T5: localToCloud — local file → directory replaces the remote file", async () => {
		const result = await runScenario({
			name: "T5",
			mode: "localToCloud",
			initialLocal: { "/local/thing": "i am a file" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "thing")
					writeLocal(world, "thing/inside.txt", "now a dir")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/thing"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/thing/inside.txt"]).toMatchObject({ type: "file" })
	})

	it("T6: cloudToLocal — remote file → directory replaces the local file", async () => {
		const result = await runScenario({
			name: "T6",
			mode: "cloudToLocal",
			initialLocal: {},
			initialRemote: { "/thing": "i am a file" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/thing")
					world.cloud.controls.addDir("/thing")
					world.cloud.controls.addFile("/thing/inside.txt", "remote dir now")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/thing"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/thing/inside.txt"]).toMatchObject({ type: "file" })
	})
})
