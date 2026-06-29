import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import {
	writeLocal,
	modifyLocal,
	rmLocal,
	renameLocal,
	readLocal,
	uploadRemote,
	deleteRemote,
	renameRemote,
	setLocalMtime,
	existsLocal
} from "./harness/mutations"

/**
 * Phase 3 e2e — twoWay conflict resolution against the live backend (both sides changed since the last
 * sync). The mtime helper makes the local side deterministically newer where "newest wins" applies.
 */
describe.skipIf(!E2E_ENABLED)("E2E — twoWay conflict resolution", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

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

	it("remote modify vs local delete: the newer remote modification wins, resurrected (F7)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "h.txt", "v1")
			await settle(world)

			// Symmetric to the local-modify-vs-remote-delete case: the local copy is deleted while the remote
			// modifies it (a new version). The newer modification wins on EITHER side, so the file survives.
			await rmLocal(world, "h.txt")
			await uploadRemote(world, "h.txt", "REMOTE-MODIFIED")

			await settle(world)

			await expectConverged(world)
			expect(await existsLocal(world, "h.txt")).toBe(true)
			expect(await readLocal(world, "h.txt")).toBe("REMOTE-MODIFIED")
		})
	})

	it("rename + in-place modify in one beat keeps the new name AND the new content (F1)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "original-content")
			await settle(world)

			// Rename, then immediately overwrite the renamed file before the next sync. The rename must not
			// mask the content change — the remote ends with the NEW bytes under the new name.
			await renameLocal(world, "a.txt", "b.txt")
			await writeLocal(world, "b.txt", "BRAND-NEW-CONTENT")

			await settle(world)

			await expectConverged(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "b.txt")).toBe("BRAND-NEW-CONTENT")
		})
	})

	// --- Conflict-matrix parity with mocked Category Y (the trickiest rename-vs-other-side cases) ---

	it("add(local) vs add(remote) same path, remote newer → the remote copy wins (Y2)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "addboth.txt", "LOCAL-OLDER")
			// Age the local copy so the remote upload that follows is unambiguously newer.
			await setLocalMtime(world, "addboth.txt", Date.now() - 60_000)
			await uploadRemote(world, "addboth.txt", "REMOTE-NEWER")

			await settle(world)

			await expectConverged(world)
			expect(await readLocal(world, "addboth.txt")).toBe("REMOTE-NEWER")
		})
	})

	it("delete(local) vs delete(remote) same path → converges to empty, no error (Y3)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "doomed.txt", "bye")
			await settle(world)

			await rmLocal(world, "doomed.txt")
			await deleteRemote(world, "doomed.txt")

			await settle(world)

			await expectConverged(world)
			expect((await snapshotRemoteReal(world))["/doomed.txt"]).toBeUndefined()
			expect(await existsLocal(world, "doomed.txt")).toBe(false)
		})
	})

	it("rename(local a→b) vs delete(remote a) → converges to {b}, data preserved (Y7)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await renameLocal(world, "a.txt", "b.txt")
			await deleteRemote(world, "a.txt")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await existsLocal(world, "b.txt")).toBe(true)
		})
	})

	it("rename(local a→b) vs modify(remote a) → converges keeping BOTH a and b (Y8)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "orig")
			await settle(world)

			await renameLocal(world, "a.txt", "b.txt")
			await uploadRemote(world, "a.txt", "REMOTE-MOD")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toMatchObject({ type: "file" })
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "a.txt")).toBe("REMOTE-MOD")
			expect(await readLocal(world, "b.txt")).toBe("orig")
		})
	})

	it("rename(local a→X) vs rename(remote a→Y) → converges keeping BOTH X and Y (Y9)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await renameLocal(world, "a.txt", "local-name.txt")
			await renameRemote(world, "a.txt", "remote-name.txt")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/local-name.txt"]).toMatchObject({ type: "file" })
			expect(remote["/remote-name.txt"]).toMatchObject({ type: "file" })
			expect(remote["/a.txt"]).toBeUndefined()
		})
	})

	it("rename(remote a→b) vs delete(local a) → converges to {b}, data preserved (Y10)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await renameRemote(world, "a.txt", "b.txt")
			await rmLocal(world, "a.txt")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("rename(remote a→b) vs modify(local a) → converges keeping BOTH a and b (Y11)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "orig")
			await settle(world)

			await renameRemote(world, "a.txt", "b.txt")
			await modifyLocal(world, "a.txt", "LOCAL-MOD")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toMatchObject({ type: "file" })
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "a.txt")).toBe("LOCAL-MOD")
			expect(await readLocal(world, "b.txt")).toBe("orig")
		})
	})

	it("delete(local a) + add(remote b) in one cycle → both applied, converges (Y12)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await rmLocal(world, "a.txt")
			await uploadRemote(world, "b.txt", "new-remote")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
		})
	})
})
