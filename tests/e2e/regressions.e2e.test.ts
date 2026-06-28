import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import fs from "fs-extra"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, restartE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, renameLocal, readLocal, existsLocal, uploadRemote, setLocalMtime, rmLocal, deleteRemote } from "./harness/mutations"

/**
 * Live-backend counterparts for the audit-round bug fixes, so each fix is proven against the real Filen
 * backend and not just the fake cloud (the mocked regressions live in tests/scenarios/z*.test.ts and
 * tests/unit/*lock.test.ts). One login is shared across the whole serial e2e suite.
 *
 * Mocked-only by necessity (no e2e counterpart):
 *   - H1: lock teardown after a FORCED releaseResourceLock failure — the real backend can't be made to
 *     fail a release on demand. Unit test with injected faults: tests/unit/lock.test.ts + ipc-lock.test.ts.
 *   - H3: a file edited DURING the local scan (a read-during-scan race) — reproducing it needs deterministic
 *     control of the scan window, which a real filesystem can't provide without flakiness. Deterministic
 *     mocked regression with a mid-scan lstat hook: tests/scenarios/zg-edit-during-scan.test.ts.
 *   - H6: the deletion-confirmation wait must bail (releasing the lock) when the pair is paused/removed.
 *     This is client-side control flow — the backend plays no part — driven deterministically with fake
 *     timers in tests/scenarios/g-large-deletion.test.ts (G6/G7); the gate itself is covered live in
 *     tests/e2e/confirm.e2e.test.ts.
 *   - H7: the local smoke test must run BEFORE the lock so a local outage never holds the account lock.
 *     Lock ORDERING during a LOCAL filesystem outage — no backend semantics — driven deterministically
 *     with an injected fs error + fake timers in tests/scenarios/zi-smoke-test-outage.test.ts.
 *   - M2/M3: the local-trash eviction sweep must age out trashed DIRECTORIES (not just files), and its
 *     setInterval must be torn down with the pair. Both are purely LOCAL — a folder on the local disk and
 *     a client-side timer — with no backend involvement. Deterministic mocked regressions (memfs trash +
 *     atime backdating + fake timers): tests/scenarios/zj-trash-cleanup.test.ts.
 *   - M4: a remote deletion must not wipe a LOCALLY-IGNORED file (one present on disk but excluded from the
 *     scanned tree for a non-.filenignore reason). This is client-side delta-attribution logic; the
 *     backend's only role (a path deleted remotely) is already exercised by the live deletion tests, and
 *     the trigger — a base path that became ignored for a nameLength/invalidPath/defaultIgnore/duplicate
 *     reason — cannot be forced deterministically on the real backend. Driven directly through
 *     deltas.process() with an injected ignored entry in tests/scenarios/zk-ignore-asymmetry.test.ts.
 *   - M5: isValidPath must reject Windows names that end in a dot/space (Windows strips them, causing a
 *     re-sync loop). This is a per-OS path rule that only runs on the win32 branch; the e2e backend host
 *     here is darwin, whose filesystem does NOT strip trailing dots, so the bug cannot manifest in an e2e
 *     round-trip. It is covered instead by the cross-platform unit suite (stubbed process.platform) run on
 *     a real Windows host by the matrixed CI: tests/unit/n-unit.test.ts (isValidPath win32).
 *   - M6: one cycle must compute its whole delta set under a single mode snapshot, even if updateMode()
 *     races the cycle. The race window is an await INSIDE deltas.process(); reproducing it needs to flip
 *     the mode at that exact await, which is only controllable by stubbing the awaited hash — not via the
 *     backend. Driven deterministically in tests/scenarios/zl-mode-atomicity.test.ts.
 *   - P4: the local scan must bound how many filesystem stat operations it launches concurrently (the old
 *     walk mapped every entry to a promise up front — an O(n) pending-promise/memory spike on a huge tree).
 *     This is a client-side memory/concurrency property: bounded vs unbounded fan-out produces the identical
 *     tree, so it has no backend-observable effect, and the bound is only measurable by instrumenting
 *     fs.lstat. The batched scan's CORRECTNESS is exercised by every live scenario here (it sits in the sync
 *     hot path); the bound itself is asserted with an lstat-counting wrapper in
 *     tests/scenarios/zm-scan-concurrency.test.ts.
 */
describe.skipIf(!E2E_ENABLED)("E2E — audit regression fixes against live backend", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	// ---- C1: create nested dirs from the sync root; don't swallow failed top-level remote ops ----------

	it("C1: moving a top-level file into a NEW 2-level directory converges with no resurrection", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "hello")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			// Move a TOP-LEVEL file into a directory chain that does NOT exist yet (x/y). The cross-parent
			// rename must build x then y from the sync root inline. The old broken mkdir threw here; the throw
			// was swallowed for the top-level source (fileExists returned false for every top-level file), so
			// the task was dropped, a skewed base was persisted, and the file was resurrected + duplicated.
			await renameLocal(world, "a.txt", "x/y/a.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"], "the moved-away original must not survive on the remote").toBeUndefined()
			expect(remote["/x/y/a.txt"]).toMatchObject({ type: "file", size: 5 })
			expect(await existsLocal(world, "a.txt")).toBe(false)
			expect(await readLocal(world, "x/y/a.txt")).toBe("hello")
			await expectConverged(world)
		})
	})

	it("C1: moving a directory into a NEW 2-level directory converges", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/child.txt", "c")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			await renameLocal(world, "dir", "x/y/dir")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir"]).toBeUndefined()
			expect(remote["/x/y/dir/child.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	})

	// ---- H2: a remote change wins over an UNCHANGED local copy regardless of the mtime tiebreak --------

	it("H2: a remote edit with a non-newer mtime is pulled when the local copy is unchanged", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "v1")
			// Age the local copy into the FUTURE so the remote edit that follows lands with an OLDER mtime,
			// while the local copy itself stays byte-for-byte unchanged vs the base. Only the remote moved,
			// so it is not a conflict — the newer-mtime tiebreak must not gate the pull.
			await setLocalMtime(world, "a.txt", Date.now() + 600_000)
			await settle(world)

			// A peer re-uploads new content (a new version → new uuid); its lastModified is ~now, i.e. BEHIND
			// the local copy's future mtime. The change must still be pulled down.
			await uploadRemote(world, "a.txt", "v2-remote-edit")
			await settle(world)

			expect(await readLocal(world, "a.txt")).toBe("v2-remote-edit")
			await expectConverged(world)
		})
	})

	// ---- H5: a directory deletion must not cascade over a live child the other side did not delete -----

	it("H5: a remote directory delete does not wipe a child added locally in the same window", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/keep.txt", "keep")
			await writeLocal(world, "other.txt", "o")
			await settle(world)

			// A peer deletes the whole directory while we add a brand-new file into it.
			await deleteRemote(world, "dir")
			await writeLocal(world, "dir/new.txt", "new-child")
			await settle(world)

			// The new child survives (uploaded), the directory is re-asserted, the unmodified base child the
			// peer deleted is gone, and both sides converge — the delete did not cascade over the new file.
			expect(await existsLocal(world, "dir/new.txt")).toBe(true)
			expect(await readLocal(world, "dir/new.txt")).toBe("new-child")
			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir/new.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir/keep.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	})

	it("H5 (symmetric): a local directory delete does not wipe a child the remote added in the same window", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/keep.txt", "keep")
			await writeLocal(world, "other.txt", "o")
			await settle(world)

			// We delete the directory locally while a peer adds a new file into it remotely.
			await rmLocal(world, "dir")
			await uploadRemote(world, "dir/new.txt", "remote-new")
			await settle(world)

			expect(await existsLocal(world, "dir/new.txt")).toBe(true)
			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir/new.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir/keep.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	})

	// ---- M1: a saved state with a MISSING local-inodes file must reload as "no saved state", not crash --

	it("M1: a missing local-inodes state file recovers (re-derives) on restart instead of crashing", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "alpha")
			await writeLocal(world, "dir/b.txt", "bravo")
			await settle(world)
			await expectConverged(world)

			// The loader reads the local-INODES file unconditionally, but its existence guard checked the
			// remote-tree file twice and never this one. Drop it to mimic a partial / interrupted state write
			// (a present tree file with a missing inodes sibling).
			const inodesPath = world.sync.state.previousLocalINodesPath

			await fs.rm(inodesPath, { force: true })

			expect(await fs.pathExists(inodesPath)).toBe(false)

			// A restart reloads persisted state from disk. With the bug this throws ENOENT and bricks startup;
			// with the fix it degrades to "no saved state", re-derives the base from disk, and stays converged.
			await restartE2EWorld(world)
			await settle(world)

			expect(await readLocal(world, "a.txt")).toBe("alpha")
			expect(await readLocal(world, "dir/b.txt")).toBe("bravo")

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir/b.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	})
})
