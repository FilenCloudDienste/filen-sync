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
import { writeLocal, symlinkLocal, existsLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — special files against the live backend: symlinks (skipped, BUG-006) and size-edge
 * transitions (truncate-to-0, grow-from-0).
 */
describe.skipIf(!E2E_ENABLED)("E2E — special files", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

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

	it("truncating a file to 0 bytes propagates", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "shrink.txt", "hello world")
			await settle(world)

			await writeLocal(world, "shrink.txt", "")
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

			await writeLocal(world, "grow.txt", "now it has content")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/grow.txt"]).toMatchObject({ type: "file", size: 18 })
			expect(await existsLocal(world, "grow.txt")).toBe(true)
			await expectConverged(world)
		})
	})
})
