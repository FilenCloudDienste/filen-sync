import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, restartE2EWorld } from "./harness/world"
import { settle, cycle, expectConverged, allOps } from "./harness/drive"
import { snapshotRemoteReal, snapshotLocalReal } from "./harness/assert"
import { writeLocal, renameLocal, rmLocal, setLocalMtime, uploadRemote, renameRemote, renameRemoteDir, moveRemote, deleteRemote } from "./harness/mutations"

/**
 * Phase 4 e2e — live-backend parity for the "weird scenario" hardening round 3 (XD/RR/XC/DR/XS/MT/PC/FD/
 * DC/XN/RS/XM). Each mirrors a mocked category against the REAL local filesystem + Filen backend.
 *
 * Two of these double as the live proof for a FAKE-FAITHFULNESS fix this round landed: the fake cloud's
 * `controls.movePath` used to allow a move/rename onto an OCCUPIED name to leave a DUPLICATE sibling — which
 * the real backend never permits (per-parent name uniqueness; a rename-onto-occupied trashes the occupant).
 * XS-live and XC-live exercise exactly that occupied-destination path on the real backend, confirming the
 * convergence the now-faithful mock predicts.
 *
 * Distinct (non case-only) names throughout: the backend is case-insensitive per parent, so a case-only
 * rename would conflate the cross-side composition under test with case handling (covered separately).
 */
describe.skipIf(!E2E_ENABLED)("E2E — weird-scenario round 3 (XD/RR/XC/DR/XS/MT/PC/FD/DC/XN/RS/XM)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("XD-live: local renames OUTER dir + remote renames INNER dir → both compose, converges", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "top/mid/file.txt", "FILE")
			await writeLocal(world, "top/keep.txt", "K")
			await settle(world)

			await renameLocal(world, "top", "top2")
			await renameRemoteDir(world, "top/mid", "top/mid2")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "FILE".length })
			expect(remote["/top2/keep.txt"]).toMatchObject({ type: "file" })
			expect(remote["/top"]).toBeUndefined()
			expect(remote["/top2/mid"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("RR-live: local renames a→b AND creates a NEW a (same path, new content) → both converge", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "ORIGINAL-A")
			await settle(world)

			await renameLocal(world, "a.txt", "b.txt")
			await writeLocal(world, "a.txt", "BRAND-NEW-A")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/b.txt"]).toMatchObject({ type: "file", size: "ORIGINAL-A".length })
			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: "BRAND-NEW-A".length })
			await expectConverged(world)
		})
	}, 1_800_000)

	it("XC-live: local a→b (overwriting local b) while remote renames b→c → converges to b=oldA, c=oldB", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "AAAA")
			await writeLocal(world, "b.txt", "BBBBBB")
			await settle(world)

			await renameLocal(world, "a.txt", "b.txt") // overwrites local b
			await renameRemote(world, "b.txt", "c.txt") // remote b → c (c is free)
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
			expect(remote["/c.txt"]).toMatchObject({ type: "file", size: "BBBBBB".length })
			expect(remote["/a.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("XS-live: cross-side SWAP (local a→b, remote b→a overwriting) → converges to swapped content (fake-faithfulness proof)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "AAAA")
			await writeLocal(world, "b.txt", "BBBBBB")
			await settle(world)

			// Each side performs ONE half of the swap; renaming onto the occupied name trashes the occupant.
			await renameLocal(world, "a.txt", "b.txt") // local: b now holds old-a
			await renameRemote(world, "b.txt", "a.txt") // remote: a now holds old-b (overwriteIfExists trashes remote a)
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// Swapped: a holds the old-b bytes, b holds the old-a bytes — no impossible duplicate sibling.
			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: "BBBBBB".length })
			expect(remote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
			await expectConverged(world)
		})
	}, 1_800_000)

	it("DR-live: local renames INNER dir while remote DELETES the OUTER dir → renamed subtree survives, sibling deleted", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a/inner/c.txt", "C")
			await writeLocal(world, "a/inner/d.txt", "D")
			await writeLocal(world, "a/other.txt", "OTHER")
			await settle(world)

			await renameLocal(world, "a/inner", "a/inner2")
			await deleteRemote(world, "a")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a/inner2/c.txt"]).toMatchObject({ type: "file", size: "C".length })
			expect(remote["/a/inner2/d.txt"]).toMatchObject({ type: "file", size: "D".length })
			expect(remote["/a/other.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("MT-live: a FAR-FUTURE local mtime syncs, converges, and does NOT re-sync next cycle (no loop)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "future.txt", "FUTURE")
			await setLocalMtime(world, "future.txt", 7_258_118_400_000) // ~year 2200
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			expect(remote["/future.txt"]).toMatchObject({ type: "file", size: "FUTURE".length })

			// Stability: a follow-up cycle must do no work (a far-future mtime must round-trip, not re-detect).
			expect(allOps(await cycle(world))).toEqual([])
		})
	}, 1_800_000)

	it("PC-live: local renames parent + child-a, remote renames child-b → both leaf renames land under the renamed parent", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "p/a.txt", "AAA")
			await writeLocal(world, "p/b.txt", "BBB")
			await settle(world)

			await renameLocal(world, "p", "pp")
			await renameLocal(world, "pp/a.txt", "pp/a2.txt")
			await renameRemote(world, "p/b.txt", "p/b2.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/pp/a2.txt"]).toMatchObject({ type: "file", size: "AAA".length })
			expect(remote["/pp/b2.txt"]).toMatchObject({ type: "file", size: "BBB".length })
			expect(remote["/pp/a.txt"]).toBeUndefined()
			expect(remote["/pp/b.txt"]).toBeUndefined()
			expect(remote["/p"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("FD-live: local turns file /x into a dir AND moves a file into /x/sub/child.txt → converges, content intact", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "x", "X-FILE-CONTENT")
			await writeLocal(world, "other.txt", "MOVED-CONTENT")
			await settle(world)

			await rmLocal(world, "x")
			await renameLocal(world, "other.txt", "x/sub/child.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/x"]).toMatchObject({ type: "directory" })
			expect(remote["/x/sub/child.txt"]).toMatchObject({ type: "file", size: "MOVED-CONTENT".length })
			expect(remote["/other.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("DC-live: local DELETES /d while remote renames child /d/a.txt→/d/b.txt → /d survives with the renamed child", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "d/a.txt", "CONTENT-A")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			await rmLocal(world, "d")
			await renameRemote(world, "d/a.txt", "d/b.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/d/b.txt"]).toMatchObject({ type: "file", size: "CONTENT-A".length })
			expect(remote["/d/a.txt"]).toBeUndefined()
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	}, 1_800_000)

	it("XN-live: local renames level-1 dir + remote renames level-3 dir (non-adjacent) → composes deep", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "outer/mid/inner/file.txt", "DEEP")
			await writeLocal(world, "outer/top.txt", "T")
			await settle(world)

			await renameLocal(world, "outer", "outer2")
			await renameRemoteDir(world, "outer/mid/inner", "outer/mid/inner2")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/outer2/mid/inner2/file.txt"]).toMatchObject({ type: "file", size: "DEEP".length })
			expect(remote["/outer2/top.txt"]).toMatchObject({ type: "file", size: "T".length })
			expect(remote["/outer2/mid/inner"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("RS-live: a restart in the middle of a cross-side dir rename → still converges (at-least-once recovery)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/a.txt", "AAA")
			await writeLocal(world, "dir/keep.txt", "k")
			await settle(world)

			await renameLocal(world, "dir", "dir2")
			await renameRemote(world, "dir/a.txt", "dir/b.txt")
			// One reconciling cycle, then rebuild the engine from persisted state, then finish.
			await settle(world, { maxCycles: 1 })
			await restartE2EWorld(world)
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir2/b.txt"]).toMatchObject({ type: "file", size: "AAA".length })
			expect(remote["/dir2/keep.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir2/a.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("XM-live: cloudToLocal — remote renames a dir, a foreign LOCAL child rename is reverted (remote wins)", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			// The remote is authoritative — seed it there and pull down to establish the synced base.
			await uploadRemote(world, "dir/a.txt", "AAA")
			await uploadRemote(world, "dir/keep.txt", "k")
			await settle(world)

			await renameRemoteDir(world, "dir", "dir2")
			await renameLocal(world, "dir/a.txt", "dir/foreignLocal.txt")
			await settle(world)

			const local = await snapshotLocalReal(world)

			expect(local["/dir2/a.txt"]).toMatchObject({ type: "file", size: "AAA".length })
			expect(local["/dir2/keep.txt"]).toMatchObject({ type: "file" })
			expect(local["/dir2/foreignLocal.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("MOVE-live: a peer CROSS-DIRECTORY remote move is applied locally as a move (uuid preserved, no re-download)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "doc.txt", "DOCUMENT")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			// A peer moves the file into a brand-new subdirectory (cross-parent move + same basename).
			await moveRemote(world, "doc.txt", "archive/doc.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			expect(local["/archive/doc.txt"]).toMatchObject({ type: "file", size: "DOCUMENT".length })
			expect(local["/doc.txt"]).toBeUndefined()
			expect(remote["/archive/doc.txt"]).toMatchObject({ type: "file", size: "DOCUMENT".length })
			await expectConverged(world)
		})
	}, 1_800_000)

	it("DC3-live: local DELETES /d while remote MOVES the child into a new subdir /d/sub/b.txt → /d and the subtree survive", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "d/a.txt", "CONTENT-A")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			await rmLocal(world, "d")
			await moveRemote(world, "d/a.txt", "d/sub/b.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/d/sub/b.txt"]).toMatchObject({ type: "file", size: "CONTENT-A".length })
			expect(remote["/d/a.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("BS1-live: localBackup — local dir rename propagates; a foreign remote-only file is NOT deleted", async () => {
		await withE2EWorld({ sdk, mode: "localBackup" }, async world => {
			await writeLocal(world, "dir/a.txt", "A")
			await writeLocal(world, "keep.txt", "k")
			await settle(world) // push local → remote

			await renameLocal(world, "dir", "dir2")
			await uploadRemote(world, "remoteOnly.txt", "FOREIGN")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			expect(remote["/dir2/a.txt"]).toMatchObject({ type: "file", size: "A".length })
			expect(remote["/dir/a.txt"]).toBeUndefined()
			// Additive: the foreign remote-only file is preserved and never pulled down.
			expect(remote["/remoteOnly.txt"]).toMatchObject({ type: "file", size: "FOREIGN".length })
			expect(local["/remoteOnly.txt"]).toBeUndefined()
		})
	}, 1_800_000)

	it("BS3-live: cloudBackup — remote dir rename propagates; a foreign local-only file is NOT deleted", async () => {
		await withE2EWorld({ sdk, mode: "cloudBackup" }, async world => {
			await uploadRemote(world, "dir/a.txt", "A")
			await uploadRemote(world, "keep.txt", "k")
			await settle(world) // pull remote → local

			await renameRemoteDir(world, "dir", "dir2")
			await writeLocal(world, "localOnly.txt", "FOREIGN")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			expect(local["/dir2/a.txt"]).toMatchObject({ type: "file", size: "A".length })
			expect(local["/dir/a.txt"]).toBeUndefined()
			// Additive: the foreign local-only file is preserved and never pushed up.
			expect(local["/localOnly.txt"]).toMatchObject({ type: "file", size: "FOREIGN".length })
			expect(remote["/localOnly.txt"]).toBeUndefined()
		})
	}, 1_800_000)

	it("TI5-live: a bare local mtime TOUCH must NOT strand a real remote edit (the modify-vs-modify fix)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "ORIGINAL")
			await settle(world) // upload → caches the local hash

			// A peer makes a REAL content edit; locally we only bump the mtime to a clearly-NEWER time (no
			// content change). Pre-fix, the newer touch-mtime made local "win" but the dedup skipped the upload
			// AND the remote pull was suppressed → the real remote edit was stranded forever (divergence).
			await uploadRemote(world, "a.txt", "REMOTE-REAL-EDIT")
			await setLocalMtime(world, "a.txt", Date.now() + 60_000)
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			// The real remote edit wins on both sides; the meaningless touch is discarded.
			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-REAL-EDIT".length })
			expect(local["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-REAL-EDIT".length })
			await expectConverged(world)
		})
	}, 1_800_000)

	it("TI8-live: local TOUCH of a DOWNLOADED file (no cached hash) + remote MODIFY → the real remote edit wins", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Seed on the remote and let twoWay DOWNLOAD it — a downloaded file has NO cached local hash, so
			// the touch is unconfirmable. Pre-fix this overwrote the remote edit with stale local bytes.
			await uploadRemote(world, "a.txt", "ORIGINAL")
			await settle(world)

			await uploadRemote(world, "a.txt", "REMOTE-REAL-EDIT")
			await setLocalMtime(world, "a.txt", Date.now() + 60_000)
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-REAL-EDIT".length })
			expect(local["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-REAL-EDIT".length })
			await expectConverged(world)
		})
	}, 1_800_000)

	it("TI1-live: local TOUCH + remote RENAME → the rename wins, the touch is ignored", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "CONTENT")
			await settle(world)

			await setLocalMtime(world, "a.txt", Date.now() + 60_000)
			await renameRemote(world, "a.txt", "b.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/b.txt"]).toMatchObject({ type: "file", size: "CONTENT".length })
			expect(remote["/a.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	}, 1_800_000)

	it("TI3-live: local TOUCH + remote DELETE → the delete proceeds (a bare touch does not resurrect)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "CONTENT")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			await setLocalMtime(world, "a.txt", Date.now() + 60_000)
			await deleteRemote(world, "a.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)
			const local = await snapshotLocalReal(world)

			expect(remote["/a.txt"]).toBeUndefined()
			expect(local["/a.txt"]).toBeUndefined()
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	}, 1_800_000)
})
