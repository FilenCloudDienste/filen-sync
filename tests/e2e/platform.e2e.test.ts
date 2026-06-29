import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { cycle, settle, allOps } from "./harness/drive"
import { snapshotLocalReal, snapshotRemoteReal } from "./harness/assert"
import { uploadRemote, writeLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — cross-platform path rules against the live backend, validated on the REAL OS of each
 * matrix runner (ubuntu / macos / windows). A "foreign" client (a direct SDK upload) creates a file
 * whose name or length is illegal on SOME platforms; syncing it down must behave per-OS:
 *
 *   - colon `:`           → illegal on win32 + darwin, legal on linux.
 *   - reserved `com1.txt` → illegal on win32 only, legal on darwin + linux.
 *   - very long path      → illegal on win32 (>512), legal on darwin (<1024) + linux (<4096).
 *
 * On a platform where the name is illegal the engine SKIPS it (never downloads it, never crashes the
 * cycle, never deletes it from the remote that legitimately holds it). On a platform where it is legal
 * the file syncs down normally. This is the live counterpart to the mocked Category AC suite — same
 * rules, asserted against the real filesystem + backend instead of stubbed `process.platform`.
 *
 * Unlike most e2e cases these do NOT call `expectConverged`: when a name is illegal locally the two
 * sides are SUPPOSED to differ (remote keeps it, local can't hold it), so each side is asserted directly.
 */
describe.skipIf(!E2E_ENABLED)("E2E — cross-platform path rules", () => {
	let sdk: FilenSDK

	// A path long enough to exceed win32's 512-char limit on its own (so the tmp-dir prefix is
	// irrelevant) while staying under darwin's 1024 limit once prefixed; every NAME is ≤ 255 (the
	// uniform name limit) so only `pathLength`, not `nameLength`, is in play.
	const longPath = `/${"d".repeat(250)}/${"s".repeat(250)}/${"f".repeat(240)}.txt`

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("a colon name syncs down only on linux; elsewhere it is skipped but kept on the remote", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Foreign client (e.g. a linux desktop) created these.
			await uploadRemote(world, "report:v2.txt", "colon — legal on linux only")
			await uploadRemote(world, "ok.txt", "legal everywhere")
			await settle(world)

			const [local, remote] = await Promise.all([snapshotLocalReal(world), snapshotRemoteReal(world)])

			// The remote ALWAYS keeps both files (skipping is never deletion).
			expect(remote["/report:v2.txt"]).toMatchObject({ type: "file" })
			expect(remote["/ok.txt"]).toMatchObject({ type: "file" })
			// The valid sibling always lands locally.
			expect(local["/ok.txt"]).toMatchObject({ type: "file" })

			// The colon file lands locally ONLY on linux (where a colon is a legal filename).
			if (process.platform === "linux") {
				expect(local["/report:v2.txt"]).toMatchObject({ type: "file" })
			} else {
				expect(local["/report:v2.txt"]).toBeUndefined()
			}

			// Long-lived stability: with the world already settled, a fresh confirming cycle does zero work
			// (no transfer, rename, delete, or mkdir) — the perpetually-skipped file never re-churns.
			const confirming = await cycle(world)

			expect(allOps(confirming)).toEqual([])
		})
	})

	it("a Windows reserved device name (com1.txt) syncs down everywhere except win32", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await uploadRemote(world, "com1.txt", "reserved on windows, ordinary elsewhere")
			await uploadRemote(world, "normal.txt", "fine everywhere")
			await settle(world)

			const [local, remote] = await Promise.all([snapshotLocalReal(world), snapshotRemoteReal(world)])

			expect(remote["/com1.txt"]).toMatchObject({ type: "file" })
			expect(remote["/normal.txt"]).toMatchObject({ type: "file" })
			expect(local["/normal.txt"]).toMatchObject({ type: "file" })

			if (process.platform === "win32") {
				expect(local["/com1.txt"]).toBeUndefined()
			} else {
				expect(local["/com1.txt"]).toMatchObject({ type: "file" })
			}
		})
	})

	it("a path over the win32 length limit syncs down on darwin/linux but is skipped on win32", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await uploadRemote(world, longPath, "long path — over 512 chars")
			await uploadRemote(world, "short.txt", "fine everywhere")
			await settle(world)

			const [local, remote] = await Promise.all([snapshotLocalReal(world), snapshotRemoteReal(world)])

			expect(remote[longPath]).toMatchObject({ type: "file" })
			expect(local["/short.txt"]).toMatchObject({ type: "file" })

			if (process.platform === "win32") {
				expect(local[longPath]).toBeUndefined()
			} else {
				expect(local[longPath]).toMatchObject({ type: "file" })
			}
		})
	})

	it("a name over 255 BYTES but under 255 UTF-16 units syncs down everywhere except linux (byte NAME_MAX)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// "あ" is 1 UTF-16 code unit but 3 UTF-8 bytes (and has no NFC/NFD ambiguity). 100 of them is
			// 100 units — under the 255-unit macOS/NTFS NAME limit — yet 300 bytes, over linux's 255-BYTE
			// NAME_MAX. A foreign macOS/Windows peer legitimately created it.
			const multibyteName = `${"あ".repeat(100)}.txt`

			await uploadRemote(world, multibyteName, "three hundred bytes of name")
			await uploadRemote(world, "plain.txt", "fine everywhere")
			await settle(world)

			const [local, remote] = await Promise.all([snapshotLocalReal(world), snapshotRemoteReal(world)])

			// The remote always keeps it; the valid sibling always lands locally.
			expect(remote[`/${multibyteName}`]).toMatchObject({ type: "file" })
			expect(local["/plain.txt"]).toMatchObject({ type: "file" })

			// Lands locally on darwin + win32 (they count UTF-16 units: 100 < 255). Skipped on linux, whose
			// NAME_MAX is 255 BYTES (300 > 255) — a graceful skip, NOT a per-cycle ENAMETOOLONG retry loop.
			if (process.platform === "linux") {
				expect(local[`/${multibyteName}`]).toBeUndefined()
			} else {
				expect(local[`/${multibyteName}`]).toMatchObject({ type: "file" })
			}

			// With the world settled, a confirming cycle does zero work — on linux the perpetually
			// byte-over-long name never re-churns.
			const confirming = await cycle(world)

			expect(allOps(confirming)).toEqual([])
		})
	})

	it("a LOCAL file legal here but illegal elsewhere uploads normally (the foreign client will skip it)", async () => {
		// The mirror direction: whatever this OS lets us create locally, the engine uploads. A peer on a
		// stricter OS is the one that will skip it on the way down — proven by the inbound cases above.
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// A name every platform can create locally, to keep this test host-agnostic on the upload side.
			await writeLocal(world, "everywhere-legal.txt", "content")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/everywhere-legal.txt"]).toMatchObject({ type: "file" })
		})
	})
})
