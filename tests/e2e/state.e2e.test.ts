import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import pathModule from "path"
import fs from "fs-extra"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, restartE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, transferOps, messagesOfType } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, rmLocal, renameLocal, existsLocal } from "./harness/mutations"
import { DEVICE_ID_VERSION } from "../../src/lib/filesystems/remote"

/**
 * Phase 3 e2e — state persistence across restarts against the live backend. Proves the on-disk state
 * (previous trees, deviceId, hashes) survives a process restart / client upgrade and drives correct
 * incremental syncs: settled trees no-op, and only genuine post-restart changes are transferred.
 */
describe.skipIf(!E2E_ENABLED)("E2E — state persistence across restarts", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("a settled tree no-ops on the first cycle after a restart", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "a")
			await writeLocal(world, "dir/b.txt", "b")
			await settle(world)

			await restartE2EWorld(world)

			const messages = await cycle(world, { resetCache: false })

			expect(transferOps(messages)).toEqual([])
			await expectConverged(world)
		})
	})

	it("a settled rename no-ops after a restart", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/file.txt", "x")
			await settle(world)
			await renameLocal(world, "dir", "dir2")
			await settle(world)

			await restartE2EWorld(world)

			const messages = await cycle(world, { resetCache: false })

			expect(transferOps(messages)).toEqual([])
			expect((await snapshotRemoteReal(world))["/dir2/file.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	})

	it("a settled deletion no-ops after a restart (no resurrection)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "keep.txt", "k")
			await writeLocal(world, "gone.txt", "g")
			await settle(world)
			await rmLocal(world, "gone.txt")
			await settle(world)

			await restartE2EWorld(world)

			const messages = await cycle(world, { resetCache: false })

			expect(transferOps(messages)).toEqual([])
			// The deleted file must NOT come back from stale state.
			expect((await snapshotRemoteReal(world))["/gone.txt"]).toBeUndefined()
			expect(await existsLocal(world, "gone.txt")).toBe(false)
		})
	})

	it("a change made after a restart syncs incrementally (only the change moves)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "existing.txt", "old")
			await settle(world)

			await restartE2EWorld(world)

			// A brand-new file after the restart...
			await writeLocal(world, "new-after-restart.txt", "fresh")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/new-after-restart.txt"]).toMatchObject({ type: "file" })
			expect(remote["/existing.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	})

	it("survives two restarts in a row with no work", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "stable.txt", "s")
			await settle(world)

			await restartE2EWorld(world)
			expect(transferOps(await cycle(world, { resetCache: false }))).toEqual([])

			await restartE2EWorld(world)
			expect(transferOps(await cycle(world, { resetCache: false }))).toEqual([])

			await expectConverged(world)
		})
	})

	it("the deviceId is reused across a restart, keeping the server-side tree cache valid (S2)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			const deviceIdPath = pathModule.join(world.dbPath, "deviceId", `v${DEVICE_ID_VERSION}`, world.syncPair.uuid)
			const before = await fs.readFile(deviceIdPath, { encoding: "utf-8" })

			expect(before.length).toBeGreaterThan(0)

			await restartE2EWorld(world)

			// A regenerated deviceId would invalidate the server's per-device tree cache and force a
			// re-download storm on every client update — it must survive the restart unchanged.
			const after = await fs.readFile(deviceIdPath, { encoding: "utf-8" })

			expect(after).toBe(before)
			expect(transferOps(await cycle(world, { resetCache: false }))).toEqual([])
		})
	})

	it("a settled sync with large-deletion confirmation enabled raises NO prompt after a restart (S3/BUG-001)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", requireConfirmationOnLargeDeletion: true }, async world => {
			await writeLocal(world, "x.txt", "x")
			await writeLocal(world, "y.txt", "y")
			await writeLocal(world, "z/w.txt", "w")
			await settle(world)

			await restartE2EWorld(world)

			// The deletion gate must not misfire when a fresh engine reloads a settled tree: the previous
			// trees are non-empty and the current trees match them, so nothing looks deleted.
			const messages = await cycle(world, { resetCache: false })

			expect(messagesOfType(messages, "confirmDeletion")).toEqual([])
			expect(transferOps(messages)).toEqual([])
			await expectConverged(world)
		})
	})

	it("persisted state is the stable v2 line-delimited {prop,data} JSON on disk (S5)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "alpha")
			await writeLocal(world, "d/b.txt", "bravo")
			await settle(world)

			const localTreeRaw = await fs.readFile(world.sync.state.previousLocalTreePath, { encoding: "utf-8" })
			const remoteTreeRaw = await fs.readFile(world.sync.state.previousRemoteTreePath, { encoding: "utf-8" })

			const assertLines = (raw: string): void => {
				const lines = raw.trim().split("\n").filter(Boolean)

				expect(lines.length).toBeGreaterThan(0)

				for (const line of lines) {
					const parsed = JSON.parse(line)

					expect(parsed).toHaveProperty("prop")
					expect(parsed.data).toHaveProperty("path")
					expect(parsed.data).toHaveProperty("type")
				}
			}

			assertLines(localTreeRaw)
			assertLines(remoteTreeRaw)
		})
	})
})
