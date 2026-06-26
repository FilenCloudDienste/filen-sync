import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, control } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { writeLocal, rmLocal, existsLocal } from "../harness/mutations"

/**
 * Category D — deletions and trash (behavioral spec §D, §3, §4). Deletions propagate per the mode
 * matrix; the losing copy is sent to trash (cloud trash for remote, .filen.trash.local for local)
 * rather than hard-deleted, unless localTrashDisabled. A directory deletion collapses to a single
 * parent op (children implied).
 */
describe("Category D — deletions", () => {
	// D1 — a local deletion removes the remote copy (to cloud trash) in both modes that propagate
	// local→remote deletions: twoWay (diff vs previous) and localToCloud (mirror to current local).
	for (const mode of ["twoWay", "localToCloud"] as const) {
		it(`D1/${mode}: deleting a local file deletes the remote copy (to cloud trash)`, async () => {
			let remoteUUID: string | undefined

			const result = await runScenario({
				name: `D1-${mode}`,
				mode,
				initialLocal: { "/local/a.txt": "content" },
				steps: [
					runCycle(),
					control(world => {
						remoteUUID = world.cloud.controls.getByPath("/a.txt")?.uuid
					}),
					localMutate(world => rmLocal(world, "a.txt")),
					runCycle(),
					runCycle()
				]
			})

			expect(transferKinds(result.cycles[1]!.messages)).toContain("deleteRemoteFile")
			expect(result.finalRemote["/a.txt"]).toBeUndefined()
			expect(result.finalLocal["/a.txt"]).toBeUndefined()

			// No data loss: the remote copy went to cloud trash, not a permanent delete.
			expect(remoteUUID).toBeDefined()
			expect(await result.world.cloud.sdk.api(3).dir().present({ uuid: remoteUUID! })).toEqual({ present: true, trash: true })
		})
	}

	// D2 — a remote deletion removes the local copy (to .filen.trash.local) in both modes that
	// propagate remote→local deletions: twoWay and cloudToLocal.
	for (const mode of ["twoWay", "cloudToLocal"] as const) {
		it(`D2/${mode}: deleting a remote file deletes the local copy (to .filen.trash.local)`, async () => {
			const result = await runScenario({
				name: `D2-${mode}`,
				mode,
				initialRemote: { "/a.txt": "content" },
				steps: [
					runCycle(),
					remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
					runCycle(),
					runCycle()
				]
			})

			expect(transferKinds(result.cycles[1]!.messages)).toContain("deleteLocalFile")
			// The normalized snapshot excludes the trash dir, so the file is gone from the synced tree…
			expect(result.finalLocal["/a.txt"]).toBeUndefined()
			expect(result.finalRemote["/a.txt"]).toBeUndefined()
			// …but it was moved to the local trash, not hard-deleted (no data loss).
			expect(existsLocal(result.world, ".filen.trash.local/a.txt")).toBe(true)
		})
	}

	it("D3: with localTrashDisabled, a remote deletion HARD-deletes the local copy (no trash)", async () => {
		const result = await runScenario({
			name: "D3",
			mode: "twoWay",
			localTrashDisabled: true,
			initialRemote: { "/a.txt": "content" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.trashPath("/a.txt")), runCycle(), runCycle()]
		})

		expect(transferKinds(result.cycles[1]!.messages)).toContain("deleteLocalFile")
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		// Hard delete: the file is not in the local trash either.
		expect(existsLocal(result.world, ".filen.trash.local/a.txt")).toBe(false)
	})

	it("D4: deleting a directory with children emits ONE parent delete (children collapsed)", async () => {
		const result = await runScenario({
			name: "D4",
			mode: "twoWay",
			initialLocal: {
				"/local/dir/a.txt": "a",
				"/local/dir/b.txt": "b",
				"/local/dir/sub/c.txt": "c"
			},
			steps: [runCycle(), localMutate(world => rmLocal(world, "dir")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		// Only the parent directory delete is emitted; the per-child file/dir deletes are collapsed.
		expect(kinds).toContain("deleteRemoteDirectory")
		expect(kinds.filter(kind => kind === "deleteRemoteDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("deleteRemoteFile")

		expect(result.finalRemote["/dir"]).toBeUndefined()
		expect(result.finalRemote["/dir/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/dir/sub/c.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("D5/localBackup: a local deletion does NOT propagate to the remote backup", async () => {
		const result = await runScenario({
			name: "D5-localBackup",
			mode: "localBackup",
			initialLocal: { "/local/a.txt": "content" },
			steps: [runCycle(), localMutate(world => rmLocal(world, "a.txt")), runCycle(), runCycle()]
		})

		// Backup modes never delete the target. The remote keeps the file; local is not re-downloaded.
		expect(transferKinds(result.messages)).not.toContain("deleteRemoteFile")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
	})

	it("D5/cloudBackup: a remote deletion does NOT propagate to the local backup", async () => {
		const result = await runScenario({
			name: "D5-cloudBackup",
			mode: "cloudBackup",
			initialRemote: { "/a.txt": "content" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.trashPath("/a.txt")), runCycle(), runCycle()]
		})

		// Backup modes never delete the target. Local keeps the file; it is not re-uploaded.
		expect(transferKinds(result.messages)).not.toContain("deleteLocalFile")
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
	})

	it("D6: deleting one file leaves the sibling files on the target untouched", async () => {
		const result = await runScenario({
			name: "D6",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": "aaa",
				"/local/b.txt": "bbb",
				"/local/c.txt": "ccc"
			},
			steps: [runCycle(), localMutate(world => rmLocal(world, "b.txt")), runCycle(), runCycle()]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		// Exactly one delete; the untouched siblings are not re-transferred.
		expect(kinds.filter(kind => kind === "deleteRemoteFile")).toHaveLength(1)
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("D7: deleting then re-creating the same name is a delete+add (fresh uuid), not a rename", async () => {
		let originalUUID: string | undefined

		const result = await runScenario({
			name: "D7",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v1" },
			steps: [
				runCycle(),
				control(world => {
					originalUUID = world.cloud.controls.getByPath("/a.txt")?.uuid
				}),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(),
				localMutate(world => writeLocal(world, "a.txt", "version-2")),
				runCycle(),
				runCycle()
			]
		})

		// The deletion is observed in its own cycle, the re-creation as an add in a later cycle.
		expect(transferKinds(result.cycles[1]!.messages)).toContain("deleteRemoteFile")
		expect(transferKinds(result.cycles[2]!.messages)).toContain("upload")

		// Nothing is renamed at any point.
		expect(transferKinds(result.messages).filter(kind => kind.startsWith("renameRemote"))).toEqual([])

		// The recreated file is a brand-new remote node, not the resurrected original.
		const finalUUID = result.world.cloud.controls.getByPath("/a.txt")?.uuid

		expect(originalUUID).toBeDefined()
		expect(finalUUID).toBeDefined()
		expect(finalUUID).not.toBe(originalUUID)
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "version-2".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
