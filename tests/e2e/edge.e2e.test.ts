import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, transferKinds } from "./harness/drive"
import { snapshotRemoteReal, snapshotLocalReal } from "./harness/assert"
import {
	writeLocal,
	mkdirLocal,
	rmLocal,
	renameLocal,
	uploadRemote,
	existsLocal,
	renameRemoteDir,
	deleteRemote,
	modifyLocal,
	readLocal
} from "./harness/mutations"

/**
 * Phase 3 e2e — structural and naming edge cases against the live backend. Heavy on directory
 * renames/moves (the delta-collapse path, BUG-004) and unusual names. All tiny files.
 */
describe.skipIf(!E2E_ENABLED)("E2E — structural & naming edge cases", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

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

	// E2E-BUG-001 (FIXED): a same-path type change (file -> directory). The delta engine now attributes
	// the change against the last-synced base, deletes the stale-type remote item, then creates the new
	// type — the phase-ordered runner guarantees the delete lands before the create.
	it("replaces a file with a directory of the same name", async () => {
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

	it("replaces a directory (with children) with a file of the same name", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "thing/a.txt", "child a")
			await writeLocal(world, "thing/b.txt", "child b")
			await settle(world)

			await rmLocal(world, "thing")
			await writeLocal(world, "thing", "now a file")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/thing"]).toMatchObject({ type: "file" })
			expect(remote["/thing/a.txt"]).toBeUndefined()
			expect(remote["/thing/b.txt"]).toBeUndefined()

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

	it("moves a file from one directory to another", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "from/doc.txt", "data")
			await mkdirLocal(world, "to")
			await settle(world)

			await renameLocal(world, "from/doc.txt", "to/doc.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/from/doc.txt"]).toBeUndefined()
			expect(remote["/to/doc.txt"]).toMatchObject({ type: "file", size: 4 })

			await expectConverged(world)
		})
	})

	it("merges independent additions from both sides (twoWay, no conflict)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "local-add.txt", "local")
			await uploadRemote(world, "remote-add.txt", "remote")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/local-add.txt"]).toMatchObject({ type: "file" })
			expect(remote["/remote-add.txt"]).toMatchObject({ type: "file" })
			expect(await existsLocal(world, "local-add.txt")).toBe(true)
			expect(await existsLocal(world, "remote-add.txt")).toBe(true)

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

	it("case-insensitive name collision: only one variant survives and the sync converges (F11)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// The backend is case-insensitive per parent, so two names differing only in case collide. The
			// collision is created on the REMOTE (a case-sensitive local FS isn't guaranteed on the test host)
			// and synced down — the live counterpart of mocked F11.
			await uploadRemote(world, "Report.txt", "one")
			await uploadRemote(world, "report.txt", "two")

			// The backend kept exactly one of the two case variants.
			const remoteAfterUpload = await snapshotRemoteReal(world)
			const survivingRemote = ["/Report.txt", "/report.txt"].filter(path => remoteAfterUpload[path] !== undefined)

			expect(survivingRemote).toHaveLength(1)

			// The sync converges without crashing or churning; the local side ends matching the single copy.
			await settle(world)
			await expectConverged(world)

			expect(Object.keys(await snapshotLocalReal(world))).toHaveLength(1)
		})
	})

	// Cross-side directory rename + concurrent child change (BUG-A / BUG-B): a folder renamed on one side
	// while a file inside it is edited/deleted on the OTHER side. Before the rename-aware rebase the rename
	// relocated the subtree while a stale same-path op clobbered the change (data loss) or resurrected a
	// deletion. Live mirror of the mocked ZB suite.
	describe("cross-side directory rename + concurrent child change", () => {
		it("a local dir rename + a remote child edit keeps the remote edit (BUG-A)", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await mkdirLocal(world, "dir")
				await writeLocal(world, "dir/child.txt", "old")
				await writeLocal(world, "dir/sibling.txt", "sib")
				await settle(world)
				await expectConverged(world)

				// One device renames the folder; another edits a file still at the old path, same window.
				await renameLocal(world, "dir", "dir2")
				await uploadRemote(world, "dir/child.txt", "REMOTE-EDITED-NEW-CONTENT")

				await settle(world)
				await expectConverged(world)

				expect(await readLocal(world, "dir2/child.txt")).toBe("REMOTE-EDITED-NEW-CONTENT")
				const remote = await snapshotRemoteReal(world)
				expect(remote["/dir2/child.txt"]).toMatchObject({ size: "REMOTE-EDITED-NEW-CONTENT".length })
				expect(remote["/dir/child.txt"]).toBeUndefined()
			})
		})

		it("a remote dir rename + a local child edit keeps the local edit (BUG-A symmetric)", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await mkdirLocal(world, "dir")
				await writeLocal(world, "dir/child.txt", "old")
				await settle(world)
				await expectConverged(world)

				await renameRemoteDir(world, "dir", "dir2")
				await modifyLocal(world, "dir/child.txt", "LOCAL-EDITED-NEW-CONTENT")

				await settle(world)
				await expectConverged(world)

				const remote = await snapshotRemoteReal(world)
				expect(remote["/dir2/child.txt"]).toMatchObject({ size: "LOCAL-EDITED-NEW-CONTENT".length })
			})
		})

		it("a local dir rename + a remote child delete does not resurrect the child (BUG-B)", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await mkdirLocal(world, "dir")
				await writeLocal(world, "dir/child.txt", "old")
				await writeLocal(world, "dir/keep.txt", "k")
				await settle(world)
				await expectConverged(world)

				await renameLocal(world, "dir", "dir2")
				await deleteRemote(world, "dir/child.txt")

				await settle(world)
				await expectConverged(world)

				expect(await existsLocal(world, "dir2/child.txt")).toBe(false)
				const remote = await snapshotRemoteReal(world)
				expect(remote["/dir2/child.txt"]).toBeUndefined()
				expect(remote["/dir2/keep.txt"]).toMatchObject({ size: "k".length })
			})
		})
	})
})
