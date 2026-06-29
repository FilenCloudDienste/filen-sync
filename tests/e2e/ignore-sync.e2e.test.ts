import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, uploadRemote, existsLocal, resolveRemote } from "./harness/mutations"

/**
 * Phase 4 e2e — live-backend parity for the synced `.filenignore` config feature (Category IG). The root
 * `.filenignore` must reach every machine even under excludeDotFiles (other dotfiles stay excluded), a
 * REMOTE edit must round-trip and take effect, and an explicit self-ignore must opt it out — all validated
 * against the real Filen backend (which is where the dotfile-exemption on both the scan and the delta filter
 * actually has to hold). Distinct, non-case-only names.
 */
describe.skipIf(!E2E_ENABLED)("E2E — synced .filenignore config (IG)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("IG1-live: the root .filenignore SYNCS under excludeDotFiles; other dotfiles stay excluded", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", excludeDotFiles: true }, async world => {
			await writeLocal(world, ".filenignore", "ignored.txt")
			await writeLocal(world, "ignored.txt", "should-not-sync")
			await writeLocal(world, "kept.txt", "syncs")
			await writeLocal(world, ".DS_Store", "junk-dotfile")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// The ignore config reached the remote (checked directly — the snapshot deliberately omits it).
			expect(await resolveRemote(world, ".filenignore"), "the ignore config reached the remote").not.toBeNull()
			expect(remote["/kept.txt"]).toMatchObject({ type: "file" })
			expect(remote["/ignored.txt"], "the .filenignore'd file did not sync").toBeUndefined()
			// Other dotfiles are still excluded under excludeDotFiles.
			expect(await resolveRemote(world, ".DS_Store"), "other dotfiles are still excluded").toBeNull()
		})
	}, 1_800_000)

	it("IG2-live: a REMOTE .filenignore edit round-trips and the new rule applies (file kept, not deleted)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", excludeDotFiles: true }, async world => {
			await writeLocal(world, "secret.txt", "data")
			await writeLocal(world, "keep.txt", "keep")
			await settle(world)

			// Another device drops a .filenignore on the remote that ignores secret.txt.
			await uploadRemote(world, ".filenignore", "secret.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// The config downloaded to local (checked directly — the snapshot omits it)…
			expect(await existsLocal(world, ".filenignore"), "the remote .filenignore round-tripped to local").toBe(true)
			// …and the now-ignored file is KEPT on both sides (ignore ≠ delete).
			expect(remote["/secret.txt"]).toMatchObject({ type: "file" })
			expect(await existsLocal(world, "secret.txt")).toBe(true)
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })
		})
	}, 1_800_000)

	it("IG3-live: an explicit rule ignoring `.filenignore` itself opts it out of syncing (still ignorable)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", excludeDotFiles: true }, async world => {
			await writeLocal(world, ".filenignore", ".filenignore\nnormal-ignored.txt")
			await writeLocal(world, "normal-ignored.txt", "x")
			await writeLocal(world, "synced.txt", "y")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// Explicitly self-ignored → NOT synced (checked directly — the snapshot omits it either way).
			expect(await resolveRemote(world, ".filenignore"), "explicitly self-ignored → not synced").toBeNull()
			expect(remote["/normal-ignored.txt"]).toBeUndefined()
			expect(remote["/synced.txt"]).toMatchObject({ type: "file" })
		})
	}, 1_800_000)
})
