import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { execFileSync } from "child_process"
import pathModule from "path"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, allOps, cycle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, symlinkLocal, linkLocal, resolveRemote } from "./harness/mutations"

/**
 * Phase 4 e2e — special-file / identity edge cases that the mocked harness cannot express (its snapshot
 * statSyncs, which ELOOPs on a symlink loop and can't create FIFOs). Validated against the real filesystem,
 * where the scan lstats every entry: a symlink LOOP must not hang/crash the scan and must be skipped; a real
 * HARDLINK pair must sync as independent copies and survive an edit through one link; a FIFO (named pipe) is
 * a non-regular special file that must be skipped structurally without erroring the cycle. Non-win32 only
 * (the live host is unix). Add-only.
 */
describe.skipIf(!E2E_ENABLED)("E2E — special files / identity (IX)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("IX-loop-live: a symlink LOOP (a→b, b→a) is skipped without hanging the scan; real siblings sync", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "real.txt", "REAL")
			// A genuine cycle: loopA → loopB → loopA (relative targets, same dir).
			await symlinkLocal(world, "loopA", "loopB")
			await symlinkLocal(world, "loopB", "loopA")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// Neither symlink in the loop synced; the real file did; no task error wedged the cycle.
			expect(await resolveRemote(world, "loopA")).toBeNull()
			expect(await resolveRemote(world, "loopB")).toBeNull()
			expect(remote["/real.txt"]).toMatchObject({ type: "file" })

			const trailing = await cycle(world)

			expect(allOps(trailing)).toEqual([])
		})
	}, 1_800_000)

	it("IX-hardlink-live: a real hardlink pair syncs as two copies and survives an edit through one link", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "orig.txt", "shared-v1")
			await linkLocal(world, "orig.txt", "linked.txt") // real hardlink: same inode + bytes
			await settle(world)

			let remote = await snapshotRemoteReal(world)

			expect(remote["/orig.txt"]).toMatchObject({ type: "file" })
			expect(remote["/linked.txt"]).toMatchObject({ type: "file" })

			// Editing through one link changes the shared bytes → both paths must re-sync to the new content.
			await writeLocal(world, "orig.txt", "shared-v2-longer-content")
			await settle(world)

			remote = await snapshotRemoteReal(world)

			expect(remote["/orig.txt"]).toMatchObject({ type: "file", size: "shared-v2-longer-content".length })
			expect(remote["/linked.txt"]).toMatchObject({ type: "file" })
		})
	}, 1_800_000)

	it("IX-fifo-live: a FIFO (named pipe) is skipped structurally; the cycle does not error", async () => {
		if (process.platform === "win32") {
			return
		}

		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "keep.txt", "k")
			// Create a real FIFO in the sync root (non-regular file — must be skipped like a symlink/device).
			execFileSync("mkfifo", [pathModule.join(world.localRoot, "pipe.fifo")])
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(await resolveRemote(world, "pipe.fifo"), "the FIFO is not synced").toBeNull()
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })

			// The special file did not wedge the cycle — a settled trailing cycle is a clean no-op.
			const trailing = await cycle(world)

			expect(allOps(trailing)).toEqual([])
		})
	}, 1_800_000)
})
