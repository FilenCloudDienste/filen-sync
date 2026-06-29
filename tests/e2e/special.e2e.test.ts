import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import os from "os"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, writeLocalPreservingMtime, symlinkLocal, rmLocal, existsLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — special files against the live backend: symlinks (skipped, BUG-006) and size-edge
 * transitions (truncate-to-0, grow-from-0).
 */
describe.skipIf(!E2E_ENABLED)("E2E — special files", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("skips symlinks: they never sync and don't break the cycle (BUG-006)", async ctx => {
		// Probe symlink support first (Windows without Developer Mode can't create them).
		const probeDir = pathModule.join(os.tmpdir(), `e2e-symlink-probe-${uuidv4()}`)

		await fs.ensureDir(probeDir)

		let symlinksSupported = true

		try {
			await fs.symlink(pathModule.join(probeDir, "target"), pathModule.join(probeDir, "link"))
		} catch {
			symlinksSupported = false
		}

		await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {})

		if (!symlinksSupported) {
			ctx.skip()

			return
		}

		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "real.txt", "real")

			// A symlink pointing outside the sync root — must be skipped, never followed/uploaded.
			const externalTarget = pathModule.join(os.tmpdir(), `e2e-symlink-target-${uuidv4()}.txt`)

			await fs.writeFile(externalTarget, "external content")

			try {
				await symlinkLocal(world, "link.txt", externalTarget)

				await settle(world)

				const remote = await snapshotRemoteReal(world)

				expect(remote["/real.txt"]).toMatchObject({ type: "file" })
				expect(remote["/link.txt"]).toBeUndefined()
				// The real file converges; the symlink is simply absent on both sides of the comparison.
				await expectConverged(world)
			} finally {
				await fs.rm(externalTarget, { force: true }).catch(() => {})
			}
		})
	})

	it("a synced file replaced by a symlink is skipped, and the cloud copy survives (F15/BUG-006)", async ctx => {
		// Probe symlink support first (Windows without Developer Mode can't create them).
		const probeDir = pathModule.join(os.tmpdir(), `e2e-symlink-probe-${uuidv4()}`)

		await fs.ensureDir(probeDir)

		let symlinksSupported = true

		try {
			await fs.symlink(pathModule.join(probeDir, "target"), pathModule.join(probeDir, "link"))
		} catch {
			symlinksSupported = false
		}

		await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {})

		if (!symlinksSupported) {
			ctx.skip()

			return
		}

		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// A file synced normally to the cloud…
			await writeLocal(world, "data.txt", "real content")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/data.txt"]).toMatchObject({ type: "file" })

			// …is then replaced in place by a (dangling) symlink. The walk lstats it, sees a link, and skips
			// it structurally; a structurally-skipped path is treated like ignore-after-sync, so the cloud
			// copy is NOT deleted (mirrors mocked F15 — prevents data loss after the lstat upgrade). The two
			// sides are intentionally divergent here (local no longer syncs the path), so we assert the cloud
			// survivor directly rather than convergence.
			await rmLocal(world, "data.txt")
			await symlinkLocal(world, "data.txt", pathModule.join(os.tmpdir(), `e2e-dangling-${uuidv4()}.txt`))
			await settle(world)

			expect((await snapshotRemoteReal(world))["/data.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("round-trips a multi-chunk (>1 MiB) file with byte integrity across chunk boundaries", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// The SDK uploads in 1 MiB chunks, so 2.5 MiB spans three chunks. The bytes are position-dependent
			// (not a constant fill), so a dropped, duplicated, or reordered chunk changes the content hash —
			// not just the size — and the withContent convergence check below would catch it.
			const size = 2.5 * 1024 * 1024
			const bytes = new Uint8Array(size)

			for (let i = 0; i < size; i++) {
				bytes[i] = (i * 31 + 7) % 251
			}

			await writeLocal(world, "big.bin", bytes)
			await settle(world)

			expect((await snapshotRemoteReal(world))["/big.bin"]).toMatchObject({ type: "file", size })

			// withContent downloads the remote copy and sha512s both sides → proves byte-for-byte integrity
			// of the large file after a full upload-then-download round trip through the real backend.
			await expectConverged(world)
		})
	})

	it("truncating a file to 0 bytes propagates", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "shrink.txt", "hello world")
			await settle(world)

			// modifyLocal stamps a clearly-newer mtime so the change is detected regardless of how fast the
			// prior settle ran (change detection is mtime-gated at whole-second precision; size is not compared).
			await modifyLocal(world, "shrink.txt", "")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/shrink.txt"]).toMatchObject({ type: "file", size: 0 })
			await expectConverged(world)
		})
	})

	it("growing a file from 0 bytes propagates", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "grow.txt", "")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/grow.txt"]).toMatchObject({ type: "file", size: 0 })

			await modifyLocal(world, "grow.txt", "now it has content")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/grow.txt"]).toMatchObject({ type: "file", size: 18 })
			expect(await existsLocal(world, "grow.txt")).toBe(true)
			await expectConverged(world)
		})
	})

	it("propagates a same-mtime size change (base-relative detection, E2E-OBS-002)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "sized.txt", "12345678")
			await settle(world)

			// Change the size but restore the original mtime: the whole-second mtime is unchanged, so only
			// the base-relative size comparison can detect this edit (the old side-vs-side gate missed it).
			await writeLocalPreservingMtime(world, "sized.txt", "123")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/sized.txt"]).toMatchObject({ type: "file", size: 3 })
			await expectConverged(world)
		})
	})
})
