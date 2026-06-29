import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import os from "os"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged, transferKinds, cycle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, renameLocal, readLocal, setLocalMtime, chmodLocal, rmLocal, uploadRemote, deleteRemote, existsLocal } from "./harness/mutations"

/**
 * Phase 4 e2e — live-backend parity for the latest weird-scenario rounds (ZP/ZQ/ZR/ZS/ZV/ZU).
 *
 * - ZP (partial rename+move fault) is mocked-only by nature: it needs a fault injected BETWEEN the two
 *   SDK calls of a cross-parent rename+move, which can't be induced on the live backend. What CAN and MUST
 *   be validated live is the SUCCESS path of that same code, since the fix reordered remote.rename() — a
 *   cross-parent move that also renames the basename must still converge to a single destination here.
 * - ZQ (case-only rename) runs against the host's REAL filesystem, so on the macOS/Windows CI runners this
 *   exercises a case-insensitive, case-preserving FS plus the backend's case-insensitive-per-parent rename
 *   — exactly the path the in-memory (case-sensitive) mock cannot reach.
 * - ZR (backwards mtime) validates the load-bearing `!==` change-detection on a real filesystem's mtime.
 * - ZS (.filenignore traversal pruning) validates on the REAL FastGlob that a same-named file isn't pruned
 *   and a prefix-similar sibling still syncs.
 * - ZV (permission revoked after sync) validates the data-loss guard + recovery with a real, persistent chmod.
 * - ZU (directional-mode conflict matrix) validates mirror-authority and additive delete×modify resolution.
 */
describe.skipIf(!E2E_ENABLED)("E2E — weird-scenario parity (ZP/ZQ/ZR/ZS/ZV/ZU)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 900_000)

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
	}, 900_000)

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
	}, 900_000)

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
	}, 900_000)

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
	}, 900_000)

	it("ZS-live: a dir-only ignore prunes the directory but a SAME-NAMED file still syncs (real FastGlob)", async () => {
		// Validates the traversal-prune safety on the real glob engine: the `cache/**/*` prune glob must NOT
		// swallow a FILE named "cache" (the micromatch zero-segment trap), while the cache/ directory's contents
		// are correctly skipped.
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "cache/\n" }, async world => {
			await writeLocal(world, "cache/data.bin", "blob")
			await writeLocal(world, "sibling/cache", "i-am-a-file")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/sibling/cache"]).toMatchObject({ type: "file" })
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })
			expect(remote["/cache"]).toBeUndefined()
			expect(remote["/cache/data.bin"]).toBeUndefined()
		})
	}, 900_000)

	it("ZS-live: a prefix-similar sibling of an ignored directory still syncs", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "build\n" }, async world => {
			await writeLocal(world, "build/artifact.o", "obj")
			await writeLocal(world, "buildscript.txt", "script")
			await writeLocal(world, "build.txt", "note")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/buildscript.txt"]).toMatchObject({ type: "file" })
			expect(remote["/build.txt"]).toMatchObject({ type: "file" })
			expect(remote["/build"]).toBeUndefined()
			expect(remote["/build/artifact.o"]).toBeUndefined()
		})
	}, 900_000)

	it("ZV-live: a synced file made unreadable is KEPT on the remote, then reconciles when readable again", async ctx => {
		// chmod 0o000 doesn't deny reads on Windows, and root bypasses it — probe first, skip if it won't deny.
		if (process.platform === "win32") {
			ctx.skip()

			return
		}

		const probeDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), `e2e-perm-${uuidv4()}-`))
		const probeFile = pathModule.join(probeDir, "p")

		await fs.writeFile(probeFile, "x")
		await fs.chmod(probeFile, 0o000)

		let denies = false

		try {
			await fs.readFile(probeFile)
		} catch {
			denies = true
		}

		await fs.chmod(probeFile, 0o644).catch(() => {})
		await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {})

		if (!denies) {
			ctx.skip()

			return
		}

		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "doc.txt", "important")
			await writeLocal(world, "keep.txt", "keep")
			await settle(world)

			// Revoke read permission on the already-synced file (the data-loss case the engine must survive).
			await chmodLocal(world, "doc.txt", 0o000)
			await settle(world)

			// The unreadable-but-previously-synced file must NOT be deleted from the remote.
			expect((await snapshotRemoteReal(world))["/doc.txt"]).toMatchObject({ type: "file" })

			// Restore permission — the file must reconcile cleanly with no lingering divergence.
			await chmodLocal(world, "doc.txt", 0o644)
			await settle(world)

			expect((await snapshotRemoteReal(world))["/doc.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	}, 900_000)

	it("ZU1-live: localToCloud — a local delete beats a concurrent foreign remote modify (mirror authority)", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			await writeLocal(world, "a.txt", "v1")
			await writeLocal(world, "keep.txt", "keep") // keep the local side non-empty (no deletion gate)
			await settle(world)

			await rmLocal(world, "a.txt")
			await uploadRemote(world, "a.txt", "foreign-remote-edit") // foreign change on the non-authoritative side
			await settle(world)

			// Local is authoritative and deleted it — the foreign remote edit must not resurrect it.
			expect((await snapshotRemoteReal(world))["/a.txt"]).toBeUndefined()
			expect(await existsLocal(world, "a.txt")).toBe(false)
		})
	}, 900_000)

	it("ZU3-live: cloudToLocal — a remote delete beats a concurrent foreign local modify (mirror authority)", async () => {
		await withE2EWorld({ sdk, mode: "cloudToLocal" }, async world => {
			await writeLocal(world, "a.txt", "v1")
			await writeLocal(world, "keep.txt", "keep")
			await settle(world)

			await deleteRemote(world, "a.txt") // remote authoritative delete
			await writeLocal(world, "a.txt", "foreign-local-edit") // foreign change on the non-authoritative side
			await settle(world)

			// Remote is authoritative and deleted it — the foreign local edit must not keep it alive.
			expect(await existsLocal(world, "a.txt")).toBe(false)
			expect((await snapshotRemoteReal(world))["/a.txt"]).toBeUndefined()
		})
	}, 900_000)

	it("ZU5-live: localBackup — a local delete does NOT propagate even when the remote was concurrently modified", async () => {
		await withE2EWorld({ sdk, mode: "localBackup" }, async world => {
			await writeLocal(world, "a.txt", "v1")
			await settle(world)

			await rmLocal(world, "a.txt")
			await uploadRemote(world, "a.txt", "foreign-remote-edit")
			await settle(world)

			// Additive backup: a source-side delete never deletes the target — the remote copy survives.
			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })
		})
	}, 900_000)
})
