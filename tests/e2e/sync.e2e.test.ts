import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, restartE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, transferOps } from "./harness/drive"
import { snapshotLocalReal, snapshotRemoteReal } from "./harness/assert"
import { writeLocal, mkdirLocal, rmLocal, renameLocal, readLocal, uploadRemote, mkdirRemote, existsLocal } from "./harness/mutations"

/**
 * Phase 3 — real end-to-end against the live SDK + backend. Each case runs a real {@link SyncWorker}
 * against a fresh `/<uuid>` remote dir and a fresh local tmp dir, then permanently cleans both sides.
 * All files are tiny (bytes) — this exercises the sync ALGORITHM end-to-end, not transfer throughput.
 *
 * Skips entirely when FILEN_TEST_EMAIL / FILEN_TEST_PASSWORD are unset.
 */
describe.skipIf(!E2E_ENABLED)("E2E — core sync against live backend", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 120_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	// ---- twoWay ------------------------------------------------------------------------------------

	it("twoWay: uploads new local files and directories to the remote", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "alpha")
			await writeLocal(world, "dir/b.txt", "bravo")
			await mkdirLocal(world, "dir/empty-dir")

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: 5 })
			expect(remote["/dir"]).toMatchObject({ type: "directory" })
			expect(remote["/dir/b.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir/empty-dir"]).toMatchObject({ type: "directory" })

			await expectConverged(world)
		})
	})

	it("twoWay: downloads new remote files and directories to local", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await uploadRemote(world, "from-cloud.txt", "cloud-content")
			await mkdirRemote(world, "cloud-dir")
			await uploadRemote(world, "cloud-dir/nested.txt", "nested")

			await settle(world)

			expect(await existsLocal(world, "from-cloud.txt")).toBe(true)
			expect(await readLocal(world, "from-cloud.txt")).toBe("cloud-content")
			expect(await existsLocal(world, "cloud-dir/nested.txt")).toBe(true)

			await expectConverged(world)
		})
	})

	it("twoWay: propagates a content modification (same size, different bytes)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "note.txt", "aaaa")
			await settle(world)

			// Same byte length, different content — size-only checks would miss this; content hash won't.
			await writeLocal(world, "note.txt", "bbbb")
			await settle(world)

			await expectConverged(world)

			const remote = await snapshotRemoteReal(world, { withContent: true })
			const local = await snapshotLocalReal(world, { withContent: true })

			expect(remote["/note.txt"]!.contentHash).toBe(local["/note.txt"]!.contentHash)
		})
	})

	it("twoWay: propagates a local deletion to the remote", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "keep.txt", "keep")
			await writeLocal(world, "remove-me.txt", "gone")
			await settle(world)

			await rmLocal(world, "remove-me.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/remove-me.txt"]).toBeUndefined()
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("twoWay: propagates a rename and a move", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "original.txt", "data")
			await mkdirLocal(world, "target")
			await settle(world)

			await renameLocal(world, "original.txt", "renamed.txt")
			await settle(world)
			await renameLocal(world, "renamed.txt", "target/renamed.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/original.txt"]).toBeUndefined()
			expect(remote["/renamed.txt"]).toBeUndefined()
			expect(remote["/target/renamed.txt"]).toMatchObject({ type: "file", size: 4 })

			await expectConverged(world)
		})
	})

	it("twoWay: syncs a multi-level nested directory tree", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "x/y/z/deep.txt", "deep")
			await writeLocal(world, "x/y/sibling.txt", "sib")
			await writeLocal(world, "x/top.txt", "top")

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/x/y/z/deep.txt"]).toMatchObject({ type: "file" })
			expect(remote["/x/y/sibling.txt"]).toMatchObject({ type: "file" })
			expect(remote["/x/top.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("twoWay: a 0-byte file syncs (BUG-002)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "empty.txt", "")
			await writeLocal(world, "nonempty.txt", "x")

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/empty.txt"]).toMatchObject({ type: "file", size: 0 })
			expect(remote["/nonempty.txt"]).toMatchObject({ type: "file", size: 1 })

			await expectConverged(world)
		})
	})

	it("twoWay: a settled sync does ZERO transfers on the next cycle after a restart (backwards-compat)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "alpha")
			await writeLocal(world, "dir/b.txt", "bravo")
			await settle(world)

			await restartE2EWorld(world)

			// Warm-cache path (no resetCache): the reloaded state must see nothing to do.
			const messages = await cycle(world, { resetCache: false })

			expect(transferOps(messages)).toEqual([])
			await expectConverged(world)
		})
	})

	// ---- one-way modes -----------------------------------------------------------------------------

	it("localToCloud: uploads local changes but does NOT pull remote-only files down", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "local-only.txt", "mine")
			await settle(world)

			// Appears on the remote (push works)...
			expect((await snapshotRemoteReal(world))["/local-only.txt"]).toMatchObject({ type: "file" })

			// ...but a remote-only file must NOT be downloaded in localToCloud.
			await uploadRemote(world, "cloud-only.txt", "theirs")
			await settle(world)

			expect(await existsLocal(world, "cloud-only.txt")).toBe(false)
		})
	})

	it("cloudToLocal: downloads remote changes but does NOT push local-only files up", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await uploadRemote(world, "cloud-only.txt", "theirs")
			await settle(world)

			// Pulled down (download works)...
			expect(await existsLocal(world, "cloud-only.txt")).toBe(true)

			// ...but a local-only file must NOT be uploaded in cloudToLocal.
			await writeLocal(world, "local-only.txt", "mine")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/local-only.txt"]).toBeUndefined()
		})
	})
})
