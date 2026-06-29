import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, existsLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — .filenignore + dotfile filtering against the live backend. Ignored paths must never
 * reach the remote; everything else must.
 */
describe.skipIf(!E2E_ENABLED)("E2E — ignore filtering", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("ignores a directory pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "ignored/\n" }, async world => {
			await writeLocal(world, "ignored/secret.txt", "nope")
			await writeLocal(world, "visible.txt", "yes")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/visible.txt"]).toMatchObject({ type: "file" })
			expect(remote["/ignored"]).toBeUndefined()
			expect(remote["/ignored/secret.txt"]).toBeUndefined()
		})
	})

	it("ignores a glob pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "*.log\n" }, async world => {
			await writeLocal(world, "app.log", "log")
			await writeLocal(world, "app.txt", "txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/app.txt"]).toMatchObject({ type: "file" })
			expect(remote["/app.log"]).toBeUndefined()
		})
	})

	it("honors a negation pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "*.log\n!keep.log\n" }, async world => {
			await writeLocal(world, "drop.log", "drop")
			await writeLocal(world, "keep.log", "keep")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/keep.log"]).toMatchObject({ type: "file" })
			expect(remote["/drop.log"]).toBeUndefined()
		})
	})

	it("ignores a nested glob pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "**/*.tmp\n" }, async world => {
			await writeLocal(world, "a/b/scratch.tmp", "tmp")
			await writeLocal(world, "a/b/real.txt", "real")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a/b/real.txt"]).toMatchObject({ type: "file" })
			expect(remote["/a/b/scratch.tmp"]).toBeUndefined()
		})
	})

	it("excludes dotfiles when excludeDotFiles is set", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", excludeDotFiles: true }, async world => {
			await writeLocal(world, ".hidden", "secret")
			await writeLocal(world, "shown.txt", "public")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/shown.txt"]).toMatchObject({ type: "file" })
			expect(remote["/.hidden"]).toBeUndefined()
		})
	})

	it("default OS-junk names (.DS_Store, Thumbs.db) are never uploaded; real files sync", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, ".DS_Store", "junk")
			await writeLocal(world, "Thumbs.db", "junk")
			await writeLocal(world, "real.txt", "real")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/.DS_Store"]).toBeUndefined()
			expect(remote["/Thumbs.db"]).toBeUndefined()
			expect(remote["/real.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("a file synced and THEN newly ignored is not deleted from the remote (ignore ≠ delete)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "keep-me.txt", "content")
			await settle(world)

			// It synced up.
			expect((await snapshotRemoteReal(world))["/keep-me.txt"]).toMatchObject({ type: "file" })

			// Now ignore the already-synced file and edit it; ignoring must not imply a remote deletion.
			await world.worker.updateIgnorerContent(world.syncPair.uuid, "keep-me.txt")
			await modifyLocal(world, "keep-me.txt", "content-edited-after-ignore")
			await settle(world)

			// The remote copy survives and the local file is untouched — ignore is not deletion.
			expect((await snapshotRemoteReal(world))["/keep-me.txt"]).toMatchObject({ type: "file" })
			expect(await existsLocal(world, "keep-me.txt")).toBe(true)
		})
	})
})
