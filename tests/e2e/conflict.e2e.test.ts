import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, rmLocal, readLocal, uploadRemote, deleteRemote, existsLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — twoWay conflict resolution against the live backend (both sides changed since the last
 * sync). The mtime helper makes the local side deterministically newer where "newest wins" applies.
 */
describe.skipIf(!E2E_ENABLED)("E2E — twoWay conflict resolution", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("both sides create the same path; the newer (local) copy wins", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Local copy stamped clearly-newer than the remote upload that follows.
			await modifyLocal(world, "c.txt", "LOCAL-WINS")
			await uploadRemote(world, "c.txt", "remote-loses")

			await settle(world)

			await expectConverged(world)
			expect(await readLocal(world, "c.txt")).toBe("LOCAL-WINS")
		})
	})

	it("local modify vs remote delete: the newer local modification wins, resurrected (E2E-OBS-001)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "f.txt", "v1")
			await settle(world)

			// The local copy is edited (content changed) while the remote deletes it. Per newer-modify-wins
			// the local modification survives the deletion: the file is re-uploaded (resurrected) remotely
			// and kept locally with the local content, rather than being removed on both sides.
			await modifyLocal(world, "f.txt", "v2-modified")
			await deleteRemote(world, "f.txt")

			await settle(world)

			await expectConverged(world)
			expect(await existsLocal(world, "f.txt")).toBe(true)
			expect(await readLocal(world, "f.txt")).toBe("v2-modified")
			expect((await snapshotRemoteReal(world))["/f.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("local delete vs remote-unchanged: the delete propagates", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "g.txt", "data")
			await settle(world)

			await rmLocal(world, "g.txt")

			await settle(world)

			expect((await snapshotRemoteReal(world))["/g.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	})
})
