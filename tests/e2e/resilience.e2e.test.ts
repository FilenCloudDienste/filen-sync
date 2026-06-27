import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import os from "os"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, restartE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, transferOps } from "./harness/drive"
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
