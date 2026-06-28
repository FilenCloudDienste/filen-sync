import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, renameLocal, readLocal, existsLocal, uploadRemote, setLocalMtime } from "./harness/mutations"

/**
 * Live-backend counterparts for the audit-round bug fixes, so each fix is proven against the real Filen
 * backend and not just the fake cloud (the mocked regressions live in tests/scenarios/z*.test.ts and
 * tests/unit/*lock.test.ts). One login is shared across the whole serial e2e suite.
 *
 * Mocked-only by necessity (no e2e counterpart): H1 (lock teardown after a FORCED releaseResourceLock
 * failure) — the real backend can't be made to fail a release on demand, so it stays a unit test with
 * injected faults. See tests/unit/lock.test.ts + tests/unit/ipc-lock.test.ts.
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
})
