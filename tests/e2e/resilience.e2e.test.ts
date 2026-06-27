import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import os from "os"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, restartE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, transferOps, messagesOfType } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, rmLocal, renameLocal, uploadRemote, chmodLocal, existsLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — resilience + long-lived stability against the live backend. The mocked suite injects
 * faults and drives many cycles with fake timers; here the equivalents run against the real filesystem
 * and real backend, so we know the engine survives a genuinely unreadable file and that a long-lived
 * sync stays correct (and quiet) across many real mutation rounds and a restart.
 */
describe.skipIf(!E2E_ENABLED)("E2E — resilience & long-lived stability", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("a permission-denied local file is skipped and the cycle continues (posix, non-root)", async ctx => {
		// Windows' permission model doesn't deny reads via chmod, and root bypasses 0o000 entirely — in
		// either case the permission guard can't trigger, so probe first and skip rather than mis-assert.
		if (process.platform === "win32") {
			ctx.skip()

			return
		}

		const probeDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), `e2e-perm-probe-${uuidv4()}-`))
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
			await writeLocal(world, "ok.txt", "fine")
			await writeLocal(world, "denied.txt", "secret")
			await chmodLocal(world, "denied.txt", 0o000)

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// The readable file syncs; the unreadable one is skipped (never uploaded), and the cycle did
			// not crash on it.
			expect(remote["/ok.txt"]).toMatchObject({ type: "file" })
			expect(remote["/denied.txt"]).toBeUndefined()

			// Restore permissions so teardown can clean up without relying on directory-level removal.
			await chmodLocal(world, "denied.txt", 0o644)
		})
	})

	it("a failed local writable smoke test retries until the path heals, then syncs (Q1, posix, non-root)", async ctx => {
		// The smoke test gates each cycle on the sync root being writable; a read-only root must not crash
		// the cycle — it emits cycleLocalSmokeTestFailed and retries every SYNC_INTERVAL until it heals.
		// Windows chmod doesn't deny dir writes and root bypasses the W_OK bit, so probe-then-skip.
		if (process.platform === "win32") {
			ctx.skip()

			return
		}

		const probeDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), `e2e-rodir-probe-${uuidv4()}-`))

		await fs.chmod(probeDir, 0o555)

		let denies = false

		try {
			await fs.access(probeDir, fs.constants.W_OK)
		} catch {
			denies = true
		}

		await fs.chmod(probeDir, 0o755).catch(() => {})
		await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {})

		if (!denies) {
			ctx.skip()

			return
		}

		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")

			// Make the sync root unwritable, then drive a cycle WITHOUT awaiting — its smoke test fails and
			// the cycle parks on a retry loop instead of erroring.
			await fs.chmod(world.localRoot, 0o555)

			try {
				world.worker.resetCache(world.syncPair.uuid)

				const cyclePromise = world.sync.runCycle()

				// Wait for the smoke test to report the failure (it then sleeps SYNC_INTERVAL before retrying).
				for (let tick = 0; tick < 40 && messagesOfType(world.messages, "cycleLocalSmokeTestFailed").length === 0; tick++) {
					await new Promise<void>(resolve => setTimeout(resolve, 100))
				}

				expect(messagesOfType(world.messages, "cycleLocalSmokeTestFailed").length).toBeGreaterThan(0)
				// Nothing synced while the smoke test was failing.
				expect((await snapshotRemoteReal(world))["/a.txt"]).toBeUndefined()

				// Heal the path; the next retry passes and the cycle completes its work.
				await fs.chmod(world.localRoot, 0o755)

				await cyclePromise
			} finally {
				// Always restore writability so teardown can remove the tree.
				await fs.chmod(world.localRoot, 0o755).catch(() => {})
			}

			await settle(world)
			await expectConverged(world)

			expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("a deleted remote root parks on the remote smoke test and does NOT delete local files (Q3, data-loss guard)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "a")
			await writeLocal(world, "b.txt", "b")
			await settle(world)
			await expectConverged(world)

			// Another client deletes the ENTIRE synced remote folder. The engine must NOT read this as
			// "remote emptied" and mirror-delete the local files — the remote smoke test catches the missing
			// root first and parks the cycle (retrying) instead.
			await sdk.cloud().deleteDirectory({ uuid: world.remoteParentUUID })

			world.worker.resetCache(world.syncPair.uuid)

			const cyclePromise = world.sync.runCycle()

			try {
				for (let tick = 0; tick < 60 && messagesOfType(world.messages, "cycleRemoteSmokeTestFailed").length === 0; tick++) {
					await new Promise<void>(resolve => setTimeout(resolve, 100))
				}

				expect(messagesOfType(world.messages, "cycleRemoteSmokeTestFailed").length).toBeGreaterThan(0)
				// The critical guarantee: the vanished remote did NOT cause the local files to be deleted.
				expect(await existsLocal(world, "a.txt")).toBe(true)
				expect(await existsLocal(world, "b.txt")).toBe(true)
			} finally {
				// The remote root uuid is gone for good, so the parked cycle can never heal — remove the pair
				// to abort its retry loop (smokeTest throws "Aborted" once removed), then drain it.
				await world.worker.updateRemoved(world.syncPair.uuid, true).catch(() => {})
				await cyclePromise.catch(() => {})
			}
		})
	})

	it("a long-lived sync stays correct across many real mutation rounds and a restart, then no-ops", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Round 1 — create a small tree.
			await writeLocal(world, "doc.txt", "v1")
			await writeLocal(world, "dir/nested.txt", "n1")
			await settle(world)
			await expectConverged(world)

			// Round 2 — modify.
			await modifyLocal(world, "doc.txt", "v2-longer-content")
			await settle(world)
			await expectConverged(world)

			// Round 3 — rename.
			await renameLocal(world, "doc.txt", "renamed.txt")
			await settle(world)
			await expectConverged(world)

			// Round 4 — a remote-originated addition (a peer client).
			await uploadRemote(world, "from-remote.txt", "r1")
			await settle(world)
			await expectConverged(world)

			// Round 5 — survive a process restart with no work, then keep going.
			await restartE2EWorld(world)
			await settle(world)
			await expectConverged(world)

			// Round 6 — delete.
			await rmLocal(world, "dir/nested.txt")
			await settle(world)
			await expectConverged(world)

			// After all that churn, a settled cycle must be a COMPLETE no-op — the long-lived sync is quiet.
			const messages = await cycle(world)

			expect(transferOps(messages)).toEqual([])

			// Final-state sanity across the whole history.
			const remote = await snapshotRemoteReal(world)

			expect(remote["/renamed.txt"]).toMatchObject({ type: "file" })
			expect(remote["/from-remote.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir/nested.txt"]).toBeUndefined()
			expect(await existsLocal(world, "renamed.txt")).toBe(true)
			expect(await existsLocal(world, "from-remote.txt")).toBe(true)
		})
	})
})
