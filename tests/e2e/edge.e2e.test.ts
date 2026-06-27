import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, transferKinds } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, mkdirLocal, rmLocal, renameLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — structural and naming edge cases against the live backend. Heavy on directory
 * renames/moves (the delta-collapse path, BUG-004) and unusual names. All tiny files.
 */
describe.skipIf(!E2E_ENABLED)("E2E — structural & naming edge cases", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("renames a directory and carries its children (collapse to one parent op)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "parent/a.txt", "a")
			await writeLocal(world, "parent/sub/b.txt", "b")
			await settle(world)

			await renameLocal(world, "parent", "parent2")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/parent"]).toBeUndefined()
			expect(remote["/parent2/a.txt"]).toMatchObject({ type: "file" })
			expect(remote["/parent2/sub/b.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("renames a parent dir AND a child within it in one beat (BUG-004 composition)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "p/child.txt", "x")
			await settle(world)

			// Parent rename + child rename composed in a single cycle.
			await renameLocal(world, "p", "p2")
			await renameLocal(world, "p2/child.txt", "p2/child2.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/p"]).toBeUndefined()
			expect(remote["/p2/child.txt"]).toBeUndefined()
			expect(remote["/p2/child2.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("moves a subtree into another directory", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "src/inner/file.txt", "data")
			await mkdirLocal(world, "dest")
			await settle(world)

			await renameLocal(world, "src", "dest/src")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/src"]).toBeUndefined()
			expect(remote["/dest/src/inner/file.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("deletes an entire directory tree", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "tree/a.txt", "a")
			await writeLocal(world, "tree/deep/b.txt", "b")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			await rmLocal(world, "tree")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/tree"]).toBeUndefined()
			expect(remote["/tree/a.txt"]).toBeUndefined()
			expect(remote["/tree/deep/b.txt"]).toBeUndefined()
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("syncs files with spaces, unicode, and emoji in their names", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a file with spaces.txt", "1")
			await writeLocal(world, "ünïcödé/naïve café.txt", "2")
			await writeLocal(world, "emoji 🚀 rocket.txt", "3")

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a file with spaces.txt"]).toMatchObject({ type: "file" })
			expect(remote["/ünïcödé/naïve café.txt"]).toMatchObject({ type: "file" })
			expect(remote["/emoji 🚀 rocket.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	// KNOWN BUG (E2E-BUG-001): a same-path type change (file -> directory) is not synced. The delta
	// engine emits createRemoteDirectory for the new dir but never deletes the old remote FILE at that
	// path, so the backend keeps the file and the sides diverge. Flip to `it(...)` once the engine
	// deletes the conflicting different-type item before creating the new one.
	it.fails("replaces a file with a directory of the same name", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "thing", "i am a file")
			await settle(world)

			await rmLocal(world, "thing")
			await writeLocal(world, "thing/inside.txt", "now a dir")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/thing"]).toMatchObject({ type: "directory" })
			expect(remote["/thing/inside.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("syncs a deeply nested tree", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "l1/l2/l3/l4/l5/deep.txt", "deep")
			await settle(world)

			expect((await snapshotRemoteReal(world))["/l1/l2/l3/l4/l5/deep.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	})

	it("syncs many files in a single directory", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			for (let i = 0; i < 20; i++) {
				await writeLocal(world, `bulk/file-${i}.txt`, `content-${i}`)
			}

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			for (let i = 0; i < 20; i++) {
				expect(remote[`/bulk/file-${i}.txt`]).toMatchObject({ type: "file" })
			}

			await expectConverged(world)
		})
	})

	it("a settled directory rename does no further work after the move", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/a.txt", "a")
			await settle(world)
			await renameLocal(world, "dir", "dir-renamed")
			await settle(world)

			// One more cycle must be a complete no-op (no leftover per-child churn).
			const messages = await cycle(world)

			expect(transferKinds(messages)).toEqual([])
			await expectConverged(world)
		})
	})
})
