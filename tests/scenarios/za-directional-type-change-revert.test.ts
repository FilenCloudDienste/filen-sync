import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { rmLocal, mkdirLocal, writeLocal } from "../harness/mutations"

/**
 * Category ZA — directional MIRROR modes revert a FOREIGN file⇄directory TYPE CHANGE on the
 * non-authoritative side.
 *
 * Category T pins the AUTHORITATIVE side changing a path's type (it propagates). The complementary case is
 * the NON-authoritative side changing a synced path's type out from under the mirror: a strict mirror must
 * UNDO it (re-assert the authoritative side's type), exactly as it reverts a foreign content edit (F6, U11/
 * W11) — but a type change slips through the modify branch entirely (different types, no matching uuid/inode),
 * so it is the type-change pass that must enforce the mirror here. These pin that the foreign type change is
 * reverted and the two sides reconverge on the authoritative side's structure.
 *
 * (The ADDITIVE backup modes' handling of a foreign type change is a separate question — see za-additive-*.)
 */
describe("Category ZA — directional mirror reverts a foreign type change", () => {
	it("ZA1: cloudToLocal — local turns a synced FILE into a directory → reverted to the remote file", async () => {
		const result = await runScenario({
			name: "ZA1",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "AAA" },
			steps: [
				runCycle(),
				localMutate(world => {
					// Foreign local type change: file -> directory (with a child) at the same path.
					rmLocal(world, "a.txt")
					mkdirLocal(world, "a.txt")
					writeLocal(world, "a.txt/child.txt", "C")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The remote (authoritative) file is re-asserted; the foreign local directory is gone.
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalLocal["/a.txt/child.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZA2: cloudToLocal — local turns a synced DIRECTORY into a file → reverted to the remote directory", async () => {
		const result = await runScenario({
			name: "ZA2",
			mode: "cloudToLocal",
			initialRemote: { "/d/child.txt": "C" },
			steps: [
				runCycle(),
				localMutate(world => {
					// Foreign local type change: directory -> file at the same path.
					rmLocal(world, "d")
					writeLocal(world, "d", "NOW-A-FILE")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/d"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/d/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/d/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZA3: localToCloud — remote turns a synced FILE into a directory → reverted to the local file", async () => {
		const result = await runScenario({
			name: "ZA3",
			mode: "localToCloud",
			initialLocal: { "/local/a.txt": "AAA" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					// Foreign remote type change: file -> directory at the same path.
					world.cloud.controls.deletePath("/a.txt")
					world.cloud.controls.addFile("/a.txt/child.txt", "C")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalRemote["/a.txt/child.txt"]).toBeUndefined()
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZA4: localToCloud — remote turns a synced DIRECTORY into a file → reverted to the local directory", async () => {
		const result = await runScenario({
			name: "ZA4",
			mode: "localToCloud",
			initialLocal: { "/local/d/child.txt": "C" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					// Foreign remote type change: directory -> file at the same path.
					world.cloud.controls.deletePath("/d")
					world.cloud.controls.addFile("/d", "NOW-A-FILE")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/d"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/d/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalLocal["/d/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
