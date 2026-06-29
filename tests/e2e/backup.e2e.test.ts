import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, rmLocal, renameLocal, readLocal, existsLocal, uploadRemote, deleteRemote } from "./harness/mutations"

/**
 * Phase 3 e2e — the ADDITIVE backup modes against the live backend (previously untested live).
 * localBackup pushes local up but NEVER deletes the remote and tolerates foreign remote edits;
 * cloudBackup pulls remote down but NEVER deletes the local copy and tolerates foreign local edits.
 */
describe.skipIf(!E2E_ENABLED)("E2E — backup modes (additive)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	// ---- localBackup ------------------------------------------------------------------------------

	it("localBackup: a new local file is uploaded", async () => {
		await withE2EWorld({ sdk, mode: "localBackup" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file", size: 4 })
		})
	})

	it("localBackup: a local deletion does NOT propagate — the remote keeps the backup", async () => {
		await withE2EWorld({ sdk, mode: "localBackup" }, async world => {
			await writeLocal(world, "keep.txt", "keep")
			await settle(world)

			await rmLocal(world, "keep.txt")
			await settle(world)

			// The remote copy survives the local deletion.
			expect((await snapshotRemoteReal(world))["/keep.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("localBackup: a local rename propagates (the move follows; no data lost)", async () => {
		await withE2EWorld({ sdk, mode: "localBackup" }, async world => {
			await writeLocal(world, "before.txt", "data")
			await settle(world)

			await renameLocal(world, "before.txt", "after.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/after.txt"]).toMatchObject({ type: "file" })
			expect(remote["/before.txt"]).toBeUndefined()
		})
	})

	it("localBackup: a foreign remote edit is tolerated (not reverted)", async () => {
		await withE2EWorld({ sdk, mode: "localBackup" }, async world => {
			await writeLocal(world, "a.txt", "local-content")
			await settle(world)

			// Another device overwrites the remote copy.
			await uploadRemote(world, "a.txt", "FOREIGN-EDIT")
			await settle(world)

			// The remote keeps the foreign edit; the local copy is untouched (additive — never reverts).
			expect((await snapshotRemoteReal(world, { withContent: true }))["/a.txt"]!.size).toBe("FOREIGN-EDIT".length)
			expect(await readLocal(world, "a.txt")).toBe("local-content")
		})
	})

	// ---- cloudBackup ------------------------------------------------------------------------------

	it("cloudBackup: a new remote file is downloaded", async () => {
		await withE2EWorld({ sdk, mode: "cloudBackup" }, async world => {
			await uploadRemote(world, "a.txt", "data")
			await settle(world)

			expect(await existsLocal(world, "a.txt")).toBe(true)
			expect(await readLocal(world, "a.txt")).toBe("data")
		})
	})

	it("cloudBackup: a remote deletion does NOT propagate — the local copy is kept", async () => {
		await withE2EWorld({ sdk, mode: "cloudBackup" }, async world => {
			await uploadRemote(world, "keep.txt", "keep")
			await settle(world)

			expect(await existsLocal(world, "keep.txt")).toBe(true)

			await deleteRemote(world, "keep.txt")
			await settle(world)

			// The local copy survives the remote deletion.
			expect(await existsLocal(world, "keep.txt")).toBe(true)
		})
	})

	it("cloudBackup: a remote modification is pulled down (remote authoritative)", async () => {
		await withE2EWorld({ sdk, mode: "cloudBackup" }, async world => {
			await uploadRemote(world, "a.txt", "v1")
			await settle(world)

			await uploadRemote(world, "a.txt", "v2-modified-longer")
			await settle(world)

			expect(await readLocal(world, "a.txt")).toBe("v2-modified-longer")
		})
	})

	it("cloudBackup: a foreign local edit is tolerated (not reverted)", async () => {
		await withE2EWorld({ sdk, mode: "cloudBackup" }, async world => {
			await uploadRemote(world, "a.txt", "remote-content")
			await settle(world)

			// Edit the pulled-down copy locally; cloudBackup must NOT re-download over it.
			await modifyLocal(world, "a.txt", "LOCAL-EDIT")
			await settle(world)

			expect(await readLocal(world, "a.txt")).toBe("LOCAL-EDIT")
		})
	})
})
