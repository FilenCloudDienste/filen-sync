import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged, transferKinds, cycle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, renameLocal, readLocal, setLocalMtime } from "./harness/mutations"

/**
 * Phase 4 e2e — live-backend parity for the latest weird-scenario round (ZP/ZQ/ZR).
 *
 * - ZP (partial rename+move fault) is mocked-only by nature: it needs a fault injected BETWEEN the two
 *   SDK calls of a cross-parent rename+move, which can't be induced on the live backend. What CAN and MUST
 *   be validated live is the SUCCESS path of that same code, since the fix reordered remote.rename() — a
 *   cross-parent move that also renames the basename must still converge to a single destination here.
 * - ZQ (case-only rename) runs against the host's REAL filesystem, so on the macOS/Windows CI runners this
 *   exercises a case-insensitive, case-preserving FS plus the backend's case-insensitive-per-parent rename
 *   — exactly the path the in-memory (case-sensitive) mock cannot reach.
 * - ZR (backwards mtime) validates the load-bearing `!==` change-detection on a real filesystem's mtime.
 */
describe.skipIf(!E2E_ENABLED)("E2E — weird-scenario parity (ZP/ZQ/ZR)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("ZP-live: a cross-parent move that also renames the basename converges to one destination", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "old/a.txt", "hello-zp-live")
			await writeLocal(world, "dst/keep.txt", "keep")
			await settle(world)

			// Parent AND basename change in one rename — the two-SDK-call path the ZP fix reordered.
			await renameLocal(world, "old/a.txt", "dst/b.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/dst/b.txt"]).toMatchObject({ type: "file", size: "hello-zp-live".length })
			expect(remote["/old/a.txt"]).toBeUndefined()
			expect(remote["/old/b.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 120_000)

	it("ZQ-live: a case-only FILE rename propagates and converges on the real backend", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "readme.txt", "doc")
			await settle(world)

			await renameLocal(world, "readme.txt", "README.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/README.txt"]).toMatchObject({ type: "file" })
			expect(remote["/readme.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 120_000)

	it("ZQ-live: a case-only DIRECTORY rename propagates with its child and converges", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "docs/file.txt", "x")
			await settle(world)

			await renameLocal(world, "docs", "Docs")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/Docs/file.txt"]).toMatchObject({ type: "file" })
			expect(remote["/docs/file.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 120_000)

	it("ZR-live: a same-size content edit with an OLDER mtime still uploads (real-FS !== guard)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "AAAAAAAA") // size 8
			await settle(world)

			// Same size (8), new content, mtime pushed into the past — a restore-from-backup shape.
			await writeLocal(world, "a.txt", "BBBBBBBB")
			await setLocalMtime(world, "a.txt", Date.now() - 5 * 60 * 1000)

			// The backwards-dated edit must be detected and pushed in the very next cycle, not silently dropped.
			const messages = await cycle(world)

			expect(transferKinds(messages)).toContain("upload")

			await settle(world)

			expect(await readLocal(world, "a.txt")).toBe("BBBBBBBB")

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: 8 })

			// withContent compares sha512 on both sides, proving the remote actually holds the new bytes.
			await expectConverged(world, { withContent: true })
		})
	}, 120_000)
})
