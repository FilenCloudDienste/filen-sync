import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotLocalReal, snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, rmLocal, renameLocal, readLocal, existsLocal, uploadRemote, deleteRemote } from "./harness/mutations"

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
	}, 300_000)

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
})
