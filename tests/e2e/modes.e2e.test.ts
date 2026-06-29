import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotLocalReal, snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, rmLocal, renameLocal, renameRemoteDir, readLocal, existsLocal, uploadRemote, deleteRemote } from "./harness/mutations"

/**
 * Phase 3 e2e — one-way mode semantics against the live backend. localToCloud pushes local changes up
 * and ignores remote-only changes; cloudToLocal pulls remote changes down and ignores local-only
 * changes. (The brand-new-file boundary is in sync.e2e.test.ts; here the ignored side acts on
 * already-synced items.)
 */
describe.skipIf(!E2E_ENABLED)("E2E — one-way mode semantics", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	// ---- localToCloud (local is authoritative) ----------------------------------------------------

	it("localToCloud: a local content modification is pushed to the remote", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "doc.txt", "v1aa")
			await settle(world)

			await modifyLocal(world, "doc.txt", "v2bb")
			await settle(world)

			const local = await snapshotLocalReal(world, { withContent: true })
			const remote = await snapshotRemoteReal(world, { withContent: true })

			expect(remote["/doc.txt"]!.contentHash).toBe(local["/doc.txt"]!.contentHash)
		})
	})

	it("localToCloud: a local deletion is pushed to the remote", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "drop.txt", "x")
			await settle(world)

			await rmLocal(world, "drop.txt")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/drop.txt"]).toBeUndefined()
		})
	})

	it("localToCloud: a local rename is pushed to the remote", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "before.txt", "data")
			await settle(world)

			await renameLocal(world, "before.txt", "after.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/before.txt"]).toBeUndefined()
			expect(remote["/after.txt"]).toMatchObject({ type: "file" })
		})
	})

	// ---- cloudToLocal (remote is authoritative) ---------------------------------------------------

	it("cloudToLocal: a remote deletion is pulled down to local", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "remote-drop.txt", "x")
			await settle(world)

			expect(await existsLocal(world, "remote-drop.txt")).toBe(true)

			await deleteRemote(world, "remote-drop.txt")
			await settle(world)

			expect(await existsLocal(world, "remote-drop.txt")).toBe(false)
		})
	})

	it("cloudToLocal: a remote subtree is pulled down to local", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "tree/a.txt", "a")
			await uploadRemote(world, "tree/deep/b.txt", "b")
			await settle(world)

			expect(await existsLocal(world, "tree/a.txt")).toBe(true)
			expect(await existsLocal(world, "tree/deep/b.txt")).toBe(true)
			expect(await readLocal(world, "tree/deep/b.txt")).toBe("b")

			await expectConverged(world)
		})
	})

	it("cloudToLocal: a local modification to a synced file is NOT pushed up", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "shared.txt", "remote-original")
			await settle(world)

			// Local edit on the pulled-down copy (clearly-newer mtime) must still NOT propagate upward.
			await modifyLocal(world, "shared.txt", "locally-edited")
			await settle(world)

			const remote = await snapshotRemoteReal(world, { withContent: true })

			// Remote still holds the original content (local edit was ignored upward).
			expect(Buffer.from("remote-original").length).toBe(remote["/shared.txt"]!.size)
		})
	})

	// ---- strict mirror: the foreign side is forced to match the authoritative side ----------------

	it("localToCloud: a remote-only file is mirror-DELETED", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "mine.txt", "mine")
			await settle(world)

			// Another device adds a file the local side never had; the mirror must remove it.
			await uploadRemote(world, "foreign.txt", "theirs")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/foreign.txt"]).toBeUndefined()
			expect(remote["/mine.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("cloudToLocal: a local-only file is mirror-DELETED", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "remote.txt", "remote")
			await settle(world)

			// A local-only file the remote never had; the mirror must remove it.
			await writeLocal(world, "local-only.txt", "mine")
			await settle(world)

			expect(await existsLocal(world, "local-only.txt")).toBe(false)
			expect(await existsLocal(world, "remote.txt")).toBe(true)
		})
	})

	it("localToCloud: a foreign remote edit to a synced file is REVERTED (F6)", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "a.txt", "local-content")
			await settle(world)

			await uploadRemote(world, "a.txt", "FOREIGN")
			await settle(world)

			expect((await snapshotRemoteReal(world, { withContent: true }))["/a.txt"]!.size).toBe("local-content".length)
			expect(await readLocal(world, "a.txt")).toBe("local-content")
		})
	})

	it("cloudToLocal: a foreign local edit to a synced file is REVERTED (F6)", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "a.txt", "remote-content")
			await settle(world)

			await modifyLocal(world, "a.txt", "LOCAL-EDIT")
			await settle(world)

			expect(await readLocal(world, "a.txt")).toBe("remote-content")
		})
	})

	// ---- cross-side directory rename + a concurrent child change in a MIRROR mode (BUG-A parity) ------
	// In twoWay this was the critical data-loss bug; in a mirror the authoritative side always wins, but
	// the rename-aware rebase must still keep the dir rename and the child change correctly aligned and
	// the worlds convergent. (Live counterparts of mocked ZB11/ZB12.)

	it("localToCloud: a local dir rename + a foreign remote child edit → local content wins, converges", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "dir/child.txt", "old")
			await writeLocal(world, "dir/sibling.txt", "sib")
			await settle(world)

			// Rename the directory locally while another device concurrently edits a child at the old path.
			await renameLocal(world, "dir", "dir2")
			await uploadRemote(world, "dir/child.txt", "FOREIGN-REMOTE-EDIT")
			await settle(world)

			const remote = await snapshotRemoteReal(world, { withContent: true })

			// Local authoritative: the renamed dir wins and the foreign edit is reverted to local content.
			expect(remote["/dir2/child.txt"]!.size).toBe("old".length)
			expect(remote["/dir/child.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	})

	it("cloudToLocal: a remote dir rename + a foreign local child edit → remote content wins, converges", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "dir/child.txt", "old")
			await uploadRemote(world, "dir/sibling.txt", "sib")
			await settle(world)

			// Another device renames the directory remotely while we edit a child locally at the old path.
			await renameRemoteDir(world, "dir", "dir2")
			await modifyLocal(world, "dir/child.txt", "FOREIGN-LOCAL-EDIT")
			await settle(world)

			// Remote authoritative: the renamed dir wins and the foreign local edit is reverted.
			expect(await readLocal(world, "dir2/child.txt")).toBe("old")
			expect(await existsLocal(world, "dir/child.txt")).toBe(false)
			await expectConverged(world)
		})
	})
})
