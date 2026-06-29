import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, expectConverged, cycle, transferKinds, messagesOfType } from "./harness/drive"
import { snapshotRemoteReal, snapshotLocalReal } from "./harness/assert"
import { writeLocal, mkdirLocal, rmLocal, renameLocal, uploadRemote, deleteRemote, existsLocal, linkLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — live-backend parity for the additional weird/edge/race scenarios added to the mocked
 * suite (categories AE–AT). Most AE–AT behaviors already have live counterparts (conflict.e2e = Y
 * matrix + F7; edge.e2e = type changes, restructure, BUG-A/B; sync.e2e = empty dir + 0-byte; state.e2e
 * = offline+restart; races.e2e = delete+recreate; modes.e2e = mode-structural). This file adds the ones
 * that did NOT yet have a live test: rename rotations (AF), file↔dir name swap (AS1), move-into-a-
 * deleting-dir (AE1), path reuse (AE3), dir-delete vs child-add (AG1), a large rename is not a deletion
 * (AO), and ignore × move (AN). All tiny files.
 */
describe.skipIf(!E2E_ENABLED)("E2E — additional structural edge cases & races (AE–AT parity)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 900_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("AF1: a 3-way file rename rotation converges with rotated content", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Distinct sizes so the rotation changes each path's size — detected via the cheap size signal
			// regardless of whole-second mtime collisions (the identical-size+mtime corner is the documented
			// accepted limitation, not under test here).
			await writeLocal(world, "a.txt", "A") // 1
			await writeLocal(world, "b.txt", "BB") // 2
			await writeLocal(world, "c.txt", "CCC") // 3
			await settle(world)

			// a→tmp, c→a, b→c, tmp→b ⇒ a=oldC(3), b=oldA(1), c=oldB(2).
			await renameLocal(world, "a.txt", "tmp.txt")
			await renameLocal(world, "c.txt", "a.txt")
			await renameLocal(world, "b.txt", "c.txt")
			await renameLocal(world, "tmp.txt", "b.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: 3 })
			expect(remote["/b.txt"]).toMatchObject({ type: "file", size: 1 })
			expect(remote["/c.txt"]).toMatchObject({ type: "file", size: 2 })

			await expectConverged(world)
		})
	}, 900_000)

	it("AF3: a 3-way directory rename rotation converges with rotated children", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a/x.txt", "ax")
			await writeLocal(world, "b/y.txt", "by")
			await writeLocal(world, "c/z.txt", "cz")
			await settle(world)

			await renameLocal(world, "a", "tmp")
			await renameLocal(world, "c", "a")
			await renameLocal(world, "b", "c")
			await renameLocal(world, "tmp", "b")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a/z.txt"]).toMatchObject({ type: "file" })
			expect(remote["/b/x.txt"]).toMatchObject({ type: "file" })
			expect(remote["/c/y.txt"]).toMatchObject({ type: "file" })
			expect(remote["/a/x.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 900_000)

	it("AS1: a file and a non-empty directory swap names (child rides the swap)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a", "i am file a")
			await writeLocal(world, "b/child.txt", "child of b")
			await settle(world)

			await renameLocal(world, "a", "tmp")
			await renameLocal(world, "b", "a")
			await renameLocal(world, "tmp", "b")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a"]).toMatchObject({ type: "directory" })
			expect(remote["/a/child.txt"]).toMatchObject({ type: "file" })
			expect(remote["/b"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	}, 900_000)

	it("AS5: a file becomes a directory holding a NEW subdir into which an existing file is moved", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a", "i am a file")
			await writeLocal(world, "old/child.txt", "moved child")
			await settle(world)

			// /a (file) becomes a directory; an existing file moves into a brand-new subdir of it.
			await rmLocal(world, "a")
			await renameLocal(world, "old/child.txt", "a/sub/child.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a"]).toMatchObject({ type: "directory" })
			expect(remote["/a/sub/child.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	}, 900_000)

	it("AS2: a file and an EMPTY directory swap names", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "f", "i am the file")
			await mkdirLocal(world, "d")
			await settle(world)

			await renameLocal(world, "f", "tmp")
			await renameLocal(world, "d", "f") // empty dir d -> f
			await renameLocal(world, "tmp", "d") // file -> d
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/f"]).toMatchObject({ type: "directory" })
			expect(remote["/d"]).toMatchObject({ type: "file" })

			await expectConverged(world)
		})
	}, 900_000)

	it("AE1: a local move INTO a directory the remote deletes keeps the moved file", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "content-a")
			await writeLocal(world, "target/keep.txt", "keep")
			await settle(world)

			// Same window: local moves a.txt into target/, the remote deletes the whole target/.
			await renameLocal(world, "a.txt", "target/a.txt")
			await deleteRemote(world, "target")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/target/a.txt"]).toMatchObject({ type: "file" })
			expect(remote["/target/keep.txt"]).toBeUndefined()
			expect(remote["/a.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 900_000)

	it("AE3: delete a file and move another onto its freed path in one beat (path reuse)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "old-a")
			await writeLocal(world, "b.txt", "content-b-longer")
			await settle(world)

			await rmLocal(world, "a.txt")
			await renameLocal(world, "b.txt", "a.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toMatchObject({ type: "file", size: "content-b-longer".length })
			expect(remote["/b.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 900_000)

	it("AG1: a local directory delete racing a remote child add keeps the new child", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "dir/existing.txt", "e")
			await settle(world)

			await rmLocal(world, "dir")
			await uploadRemote(world, "dir/new.txt", "n")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/dir/new.txt"]).toMatchObject({ type: "file" })
			expect(remote["/dir/existing.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 900_000)

	it("AO: renaming a whole directory subtree does not trip the large-deletion prompt", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", requireConfirmationOnLargeDeletion: true }, async world => {
			for (let i = 0; i < 12; i++) {
				await writeLocal(world, `bigdir/f${String(i).padStart(2, "0")}.txt`, `body-${i}`)
			}
			await settle(world)

			await renameLocal(world, "bigdir", "bigdir2")
			await settle(world)

			// A rename is not a deletion: no confirmation prompt may be raised.
			expect(messagesOfType(world.messages, "confirmDeletion").length).toBe(0)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/bigdir2/f00.txt"]).toMatchObject({ type: "file" })
			expect(remote["/bigdir/f00.txt"]).toBeUndefined()

			await expectConverged(world)
		})
	}, 900_000)

	describe("ignore × move/rename (AN)", () => {
		it("AN1: moving a synced file INTO an ignored directory drops the remote copy, keeps the local bytes", async () => {
			await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "build/\n" }, async world => {
				await writeLocal(world, "a.txt", "content-a")
				await writeLocal(world, "keep.txt", "k")
				await settle(world)

				expect((await snapshotRemoteReal(world))["/a.txt"]).toMatchObject({ type: "file" })

				await renameLocal(world, "a.txt", "build/a.txt")
				await settle(world)

				const remote = await snapshotRemoteReal(world)

				// The file left its synced path → the old remote copy is dropped; build/ is never synced; the
				// local bytes survive at the ignored path (no data loss — moving back out re-uploads).
				expect(remote["/a.txt"]).toBeUndefined()
				expect(remote["/build"]).toBeUndefined()
				expect(remote["/keep.txt"]).toMatchObject({ type: "file" })
				expect(await existsLocal(world, "build/a.txt")).toBe(true)
			})
		}, 900_000)

		it("AN2: moving an ignored file OUT to a tracked path uploads it", async () => {
			await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "build/\n" }, async world => {
				await writeLocal(world, "build/secret.txt", "was-ignored")
				await writeLocal(world, "a.txt", "a")
				await settle(world)

				expect((await snapshotRemoteReal(world))["/build"]).toBeUndefined()

				await renameLocal(world, "build/secret.txt", "secret.txt")
				await settle(world)

				const remote = await snapshotRemoteReal(world)

				expect(remote["/secret.txt"]).toMatchObject({ type: "file" })
				expect(await existsLocal(world, "build/secret.txt")).toBe(false)
			})
		}, 900_000)
	})

	it("AU1: two hardlinked local files (one inode) both sync as independent copies on the real fs", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "original.txt", "shared bytes via a hardlink")
			// A genuine hardlink: link.txt and original.txt are the same inode on the real local filesystem.
			await linkLocal(world, "original.txt", "link.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// The cloud has no hardlink concept, so each path becomes its own independent file — neither dropped.
			expect(remote["/original.txt"]).toMatchObject({ type: "file" })
			expect(remote["/link.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)

			// Deleting one link must not collaterally remove the other.
			await rmLocal(world, "link.txt")
			await settle(world)

			const after = await snapshotRemoteReal(world)

			expect(after["/link.txt"]).toBeUndefined()
			expect(after["/original.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	}, 900_000)

	describe("type-change vs content-op conflicts (AX)", () => {
		it("AX2: local replaces a file with a directory while the remote deletes the file", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await writeLocal(world, "x", "v1")
				await settle(world)

				await rmLocal(world, "x")
				await writeLocal(world, "x/inner.txt", "now a dir")
				await deleteRemote(world, "x")
				await settle(world)

				const remote = await snapshotRemoteReal(world)
				expect(remote["/x"]).toMatchObject({ type: "directory" })
				expect(remote["/x/inner.txt"]).toMatchObject({ type: "file" })
				await expectConverged(world)
			})
		}, 900_000)

		it("AX3: local deletes a file while the remote replaces it with a directory", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await writeLocal(world, "x", "v1")
				await settle(world)

				await rmLocal(world, "x")
				await deleteRemote(world, "x")
				await uploadRemote(world, "x/inner.txt", "remote dir child")
				await settle(world)

				const local = await snapshotLocalReal(world)
				expect(local["/x"]).toMatchObject({ type: "directory" })
				expect(local["/x/inner.txt"]).toMatchObject({ type: "file" })
				await expectConverged(world)
			})
		}, 900_000)

		it("AX5: local deletes a directory while the remote replaces it with a file", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await writeLocal(world, "d/child.txt", "v1")
				await settle(world)

				await rmLocal(world, "d")
				await deleteRemote(world, "d")
				await uploadRemote(world, "d", "now a remote file")
				await settle(world)

				const local = await snapshotLocalReal(world)
				expect(local["/d"]).toMatchObject({ type: "file" })
				await expectConverged(world)
			})
		}, 900_000)

		it("AX6: local replaces a directory with a file while the remote deletes the directory", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await writeLocal(world, "d/child.txt", "v1")
				await settle(world)

				await rmLocal(world, "d")
				await writeLocal(world, "d", "now a local file")
				await deleteRemote(world, "d")
				await settle(world)

				const remote = await snapshotRemoteReal(world)
				expect(remote["/d"]).toMatchObject({ type: "file" })
				await expectConverged(world)
			})
		}, 900_000)

		it("AX7: both sides independently replace a file with a directory (children merge)", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await writeLocal(world, "x", "v1")
				await settle(world)

				await rmLocal(world, "x")
				await writeLocal(world, "x/local-inner.txt", "local child")
				await deleteRemote(world, "x")
				await uploadRemote(world, "x/remote-inner.txt", "remote child")
				await settle(world)

				const remote = await snapshotRemoteReal(world)
				expect(remote["/x"]).toMatchObject({ type: "directory" })
				expect(remote["/x/local-inner.txt"]).toMatchObject({ type: "file" })
				expect(remote["/x/remote-inner.txt"]).toMatchObject({ type: "file" })
				await expectConverged(world)
			})
		}, 900_000)

		it("AX8: both sides independently replace a directory with a file", async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				await writeLocal(world, "d/child.txt", "v1")
				await settle(world)

				await rmLocal(world, "d")
				await writeLocal(world, "d", "local file content")
				await deleteRemote(world, "d")
				await uploadRemote(world, "d", "remote file content")
				await settle(world)

				const remote = await snapshotRemoteReal(world)
				expect(remote["/d"]).toMatchObject({ type: "file" })
				await expectConverged(world)
			})
		}, 900_000)
	})

	it("AH3: both sides delete the same file converges to empty with no error", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "x")
			await writeLocal(world, "keep.txt", "k")
			await settle(world)

			await rmLocal(world, "a.txt")
			await deleteRemote(world, "a.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/keep.txt"]).toMatchObject({ type: "file" })

			// A fully settled state does no further work.
			expect(transferKinds(await cycle(world))).toEqual([])
			await expectConverged(world)
		})
	}, 900_000)
})
