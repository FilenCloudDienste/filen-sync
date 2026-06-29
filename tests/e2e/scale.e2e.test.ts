import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld, restartE2EWorld, type E2EWorld } from "./harness/world"
import { settle, cycle, expectConverged, allOps, transferKinds, messagesOfType } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, renameLocal, rmLocal, uploadRemote, renameRemoteDir, deleteRemote, moveRemote } from "./harness/mutations"

/**
 * Phase 4 e2e — live-backend parity for the SCALE-hardening round (LK/LR/LC/LS/LM/LT/LZ/LG2 + a structural
 * history). The mocked categories prove the engine's AGGREGATE code paths (collapseDeltas,
 * directoriesWithSurvivingChildren + splice, the rename-rebase, gate-counting, type-change/markSubtreeAdded,
 * crash re-derivation) are correct at scale against the fake cloud; these mirror a representative case of each
 * against the REAL local filesystem + Filen backend, with moderate (but multi-item) trees so the same paths
 * run with real ops. A live failure here would expose a fake-faithfulness gap the mock can't (as the AS / F1
 * rounds did). Distinct, non-case-only names throughout (the backend is case-insensitive per parent).
 */
describe.skipIf(!E2E_ENABLED)("E2E — scale hardening (LK/LR/LC/LS/LM/LT/LZ/LG2)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	async function runCycleWithDecision(world: E2EWorld, decision: "delete" | "restart"): Promise<void> {
		world.worker.resetCache(world.syncPair.uuid)

		let settled = false
		const cyclePromise = world.sync.runCycle().finally(() => {
			settled = true
		})

		for (let tick = 0; tick < 80 && !settled; tick++) {
			world.worker.confirmDeletion(world.syncPair.uuid, decision)

			await new Promise<void>(resolve => setTimeout(resolve, 250))
		}

		await cyclePromise
	}

	it("LK-live: many dirs deleted remotely + a new child added locally to each — every dir kept, base children gone", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const DIRS = 6

			for (let d = 0; d < DIRS; d++) {
				await writeLocal(world, `g/d${d}/base0.txt`, `b0-${d}`)
				await writeLocal(world, `g/d${d}/base1.txt`, `b1-${d}`)
			}

			await settle(world)

			for (let d = 0; d < DIRS; d++) {
				await deleteRemote(world, `g/d${d}`)
				await writeLocal(world, `g/d${d}/added.txt`, `added-${d}`)
			}

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			for (let d = 0; d < DIRS; d++) {
				expect(remote[`/g/d${d}/added.txt`], `d${d} survivor`).toMatchObject({ type: "file" })
				expect(remote[`/g/d${d}/base0.txt`], `d${d} base gone`).toBeUndefined()
			}

			await expectConverged(world)
		})
	}, 1_800_000)

	it("LR-live: rename a project dir while moving several files between its subdirs — 1 dir rename + N file moves, no re-upload", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			for (let i = 0; i < 8; i++) {
				await writeLocal(world, `proj/src/file-${i}.txt`, `src-${i}`)
			}

			await writeLocal(world, "proj/lib/keep.txt", "keep")
			await settle(world)

			await renameLocal(world, "proj", "project")

			for (let i = 0; i < 3; i++) {
				await renameLocal(world, `project/src/file-${i}.txt`, `project/lib/file-${i}.txt`)
			}

			const messages = await cycle(world)
			const kinds = transferKinds(messages)

			expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
			expect(kinds.filter(kind => kind === "renameRemoteFile")).toHaveLength(3)
			expect(kinds).not.toContain("upload")

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/proj"]).toBeUndefined()

			for (let i = 0; i < 8; i++) {
				const expected = i < 3 ? `/project/lib/file-${i}.txt` : `/project/src/file-${i}.txt`

				expect(remote[expected], `file-${i}`).toMatchObject({ type: "file" })
			}

			await expectConverged(world)
		})
	}, 1_800_000)

	it("LC-live: a heterogeneous conflict batch (modify/delete, delete/modify, rename/rename) resolves and converges", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const N = 4

			for (let i = 0; i < N; i++) {
				await writeLocal(world, `md/f${i}.txt`, `md-base-${i}`)
				await writeLocal(world, `dm/f${i}.txt`, `dm-base-${i}`)
				await writeLocal(world, `rr/f${i}.txt`, `rr-base-${i}`)
			}

			await settle(world)

			for (let i = 0; i < N; i++) {
				// modify/delete — local modifies, remote deletes → modify resurrects.
				await writeLocal(world, `md/f${i}.txt`, `md-LOCAL-modified-${i}-longer`)
				await deleteRemote(world, `md/f${i}.txt`)
				// delete/modify — local deletes, remote modifies → modify resurrects.
				await rmLocal(world, `dm/f${i}.txt`)
				await uploadRemote(world, `dm/f${i}.txt`, `dm-REMOTE-modified-${i}-longer`)
				// rename/rename to different targets — keep both.
				await renameLocal(world, `rr/f${i}.txt`, `rr/f${i}-local.txt`)
				await moveRemote(world, `rr/f${i}.txt`, `rr/f${i}-remote.txt`)
			}

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			for (let i = 0; i < N; i++) {
				expect(remote[`/md/f${i}.txt`], `md ${i} resurrected`).toMatchObject({ type: "file" })
				expect(remote[`/dm/f${i}.txt`], `dm ${i} resurrected`).toMatchObject({ type: "file" })
				expect(remote[`/rr/f${i}-local.txt`], `rr local ${i}`).toMatchObject({ type: "file" })
				expect(remote[`/rr/f${i}-remote.txt`], `rr remote ${i}`).toMatchObject({ type: "file" })
			}

			await expectConverged(world)
		})
	}, 1_800_000)

	it("LS-live: LOCAL renames a big dir while REMOTE modifies/adds/deletes children at the old paths (BUG-A/B rebase)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			for (let i = 0; i < 8; i++) {
				await writeLocal(world, `data/file-${i}.txt`, `base-${i}`)
			}

			await writeLocal(world, "data/sub/nested.txt", "nested")
			await settle(world)

			await renameLocal(world, "data", "data2")
			// Remote edits/adds/deletes at the PRE-rename paths.
			await uploadRemote(world, "data/file-0.txt", "REMOTE-edited-0-longerbody")
			await uploadRemote(world, "data/file-1.txt", "REMOTE-edited-1-longerbody")
			await uploadRemote(world, "data/added.txt", "remote-added")
			await deleteRemote(world, "data/file-7.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/data"]).toBeUndefined()
			expect(remote["/data2/file-0.txt"], "edit 0 survived").toMatchObject({ type: "file", size: "REMOTE-edited-0-longerbody".length })
			expect(remote["/data2/file-1.txt"], "edit 1 survived").toMatchObject({ type: "file", size: "REMOTE-edited-1-longerbody".length })
			expect(remote["/data2/added.txt"], "remote add landed under renamed dir").toMatchObject({ type: "file" })
			expect(remote["/data2/file-7.txt"], "remote delete applied").toBeUndefined()
			expect(remote["/data2/sub/nested.txt"]).toMatchObject({ type: "file" })
			await expectConverged(world)
		})
	}, 1_800_000)

	it("LM-live (localToCloud): foreign remote edits/adds/deletes are reverted; remote ends equal to the local tree", async () => {
		await withE2EWorld({ sdk, mode: "localToCloud" }, async world => {
			for (let i = 0; i < 6; i++) {
				await writeLocal(world, `mirror/file-${i}.txt`, `m-${i}`)
			}

			await settle(world)

			// Foreign churn on the non-authoritative (remote) side — all must be reverted/overwritten.
			await uploadRemote(world, "mirror/file-0.txt", "FOREIGN-EDIT")
			await uploadRemote(world, "mirror/foreign-add.txt", "FOREIGN-ADD")
			await deleteRemote(world, "mirror/file-1.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			// The foreign add is gone, the foreign delete is restored, the foreign edit is reverted → remote == local.
			expect(remote["/mirror/foreign-add.txt"]).toBeUndefined()
			expect(remote["/mirror/file-1.txt"]).toMatchObject({ type: "file" })
			// expectConverged hashes BOTH sides (withContent), proving the foreign edit to file-0 was reverted
			// to the authoritative local bytes — the strict-mirror guarantee at scale.
			await expectConverged(world)
		})
	}, 1_800_000)

	it("LT-live: several file→dir and dir→file type changes in one cycle propagate (real backend cross-type)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const N = 5

			for (let i = 0; i < N; i++) {
				await writeLocal(world, `ff/f${i}.txt`, `file-${i}`) // become dirs
				await writeLocal(world, `dd/d${i}/inner.txt`, `inner-${i}`) // d${i} becomes a file
			}

			await settle(world)

			for (let i = 0; i < N; i++) {
				await rmLocal(world, `ff/f${i}.txt`)
				await writeLocal(world, `ff/f${i}.txt/now-dir.txt`, `became-dir-${i}`)
				await rmLocal(world, `dd/d${i}`)
				await writeLocal(world, `dd/d${i}`, `became-file-${i}`)
			}

			await settle(world)

			const remote = await snapshotRemoteReal(world)

			for (let i = 0; i < N; i++) {
				expect(remote[`/ff/f${i}.txt`], `ff f${i} is a dir`).toMatchObject({ type: "directory" })
				expect(remote[`/ff/f${i}.txt/now-dir.txt`], `ff f${i} child`).toMatchObject({ type: "file" })
				expect(remote[`/dd/d${i}`], `dd d${i} is a file`).toMatchObject({ type: "file" })
				expect(remote[`/dd/d${i}/inner.txt`], `dd d${i} old child gone`).toBeUndefined()
			}

			await expectConverged(world)
		})
	}, 1_800_000)

	it("LZ-live: many un-synced changes on BOTH sides survive a restart (base far behind reality) and converge", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			for (let i = 0; i < 5; i++) {
				await writeLocal(world, `base/b-${i}.txt`, `base-${i}`)
			}

			await settle(world)

			// Neither side syncs these before the restart — the on-disk base only knows the base files.
			for (let i = 0; i < 6; i++) {
				await writeLocal(world, `localonly/l-${i}.txt`, `L-${i}`)
				await uploadRemote(world, `remoteonly/r-${i}.txt`, `R-${i}`)
			}

			await restartE2EWorld(world)
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			for (let i = 0; i < 6; i++) {
				expect(remote[`/localonly/l-${i}.txt`], `local-only ${i}`).toMatchObject({ type: "file" })
				expect(remote[`/remoteonly/r-${i}.txt`], `remote-only ${i}`).toMatchObject({ type: "file" })
			}

			await expectConverged(world)
		})
	}, 1_800_000)

	it("LG2-live: emptying a big local tree prompts with the real counts; confirming empties the remote", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", requireConfirmationOnLargeDeletion: true }, async world => {
			for (let d = 0; d < 4; d++) {
				for (let f = 0; f < 3; f++) {
					await writeLocal(world, `tree/d${d}/f${f}.txt`, `c-${d}-${f}`)
				}
			}

			await writeLocal(world, "root.txt", "root")
			await settle(world)

			const previousSize = world.sync.previousLocalTree.size

			expect(previousSize).toBeGreaterThan(12)

			// Wipe the whole local side.
			await rmLocal(world, "tree")
			await rmLocal(world, "root.txt")

			await runCycleWithDecision(world, "delete")

			const prompts = messagesOfType(world.messages, "confirmDeletion")

			expect(prompts.length).toBeGreaterThan(0)
			expect(prompts[0]!.data.where).toBe("local")
			expect(prompts[0]!.data.previous).toBe(previousSize)
			expect(prompts[0]!.data.current).toBe(0)
			expect(await snapshotRemoteReal(world)).toEqual({})
		})
	}, 1_800_000)

	it("LP-live: a hand-rolled structural history (renames, moves, deletes, type-change, adds) converges exactly", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Build a tree, then put it through a mixed structural sequence on both sides.
			for (let i = 0; i < 6; i++) {
				await writeLocal(world, `proj/mod${i}/code.txt`, `code-${i}`)
			}

			await settle(world)

			// Local: rename a module dir, add a file, type-change one path; Remote: move a module, delete one.
			await renameLocal(world, "proj/mod0", "proj/mod0-renamed")
			await writeLocal(world, "proj/mod1/extra.txt", "extra")
			await rmLocal(world, "proj/mod2") // remove the whole dir first…
			await writeLocal(world, "proj/mod2", "now-a-file") // …then replace the path with a file (dir → file)
			await renameRemoteDir(world, "proj/mod3", "proj/mod3-moved")
			await deleteRemote(world, "proj/mod4")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/proj/mod0-renamed/code.txt"]).toMatchObject({ type: "file" })
			expect(remote["/proj/mod1/extra.txt"]).toMatchObject({ type: "file" })
			expect(remote["/proj/mod2"]).toMatchObject({ type: "file" })
			expect(remote["/proj/mod3-moved/code.txt"]).toMatchObject({ type: "file" })
			expect(remote["/proj/mod4"]).toBeUndefined()
			expect(remote["/proj/mod5/code.txt"]).toMatchObject({ type: "file" })

			await expectConverged(world)

			// Idempotence on the real backend.
			const trailing = await cycle(world)

			expect(allOps(trailing)).toEqual([])
		})
	}, 1_800_000)
})
