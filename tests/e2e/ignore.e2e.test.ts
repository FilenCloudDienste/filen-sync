import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — .filenignore + dotfile filtering against the live backend. Ignored paths must never
 * reach the remote; everything else must.
 */
describe.skipIf(!E2E_ENABLED)("E2E — ignore filtering", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

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
})
