import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { transferKinds, allOps } from "../harness/snapshot"
import { renameLocal } from "../harness/mutations"
import { genNoise, mergeSpecs } from "../harness/scale"

/**
 * Category LR — collapseDeltas (most-specific-parent fold) + the rename-rebase block at SCALE.
 *
 * collapseDeltas folds child renames/deletes into a covering parent rename, choosing the LONGEST-`from`
 * (deepest) enclosing rename so a child sitting under several renamed ancestors composes correctly. K3/K4
 * pin a single clean subtree rename; what is unpinned is a parent rename COMBINED with many INDEPENDENT
 * child moves/renames/deletes in the same cycle — where each child both rides a parent rename AND has its
 * own delta that must rebase under the new parent name. A many-item cycle stresses the nearestAncestor map
 * walk, the redundant-rename elision, and the carried-vs-independent distinction at once. twoWay; asserts
 * exact op counts (no spurious per-child rename, no re-upload of carried content) + convergence + idempotence.
 */
describe("Category LR — rename collapse + rebase, at scale", () => {
	it("LR1: rename a big project dir while moving many files between its subdirs — 1 dir rename + N file moves, 0 re-upload", async () => {
		const SRC_FILES = 16
		const MOVE = 6
		const initialLocal: Record<string, string> = {}

		for (let i = 0; i < SRC_FILES; i++) {
			initialLocal[`/local/proj/src/file-${i}.txt`] = `src-${i}`
		}

		initialLocal["/local/proj/lib/keep.txt"] = "lib-keep"

		const result = await runScenario({
			name: "LR1",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("vendor", 40)),
			steps: [
				runCycle(),
				localMutate(world => {
					// Rename the whole project dir, then move the first MOVE files from src → lib (within it).
					renameLocal(world, "proj", "project")

					for (let i = 0; i < MOVE; i++) {
						renameLocal(world, `project/src/file-${i}.txt`, `project/lib/file-${i}.txt`)
					}
				}),
				runCycle(),
				runCycle()
			]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		// Exactly ONE directory rename (the project root) carries the entire subtree…
		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		// …the MOVE files each emit ONE file rename (rebased under /project), the carried files emit none…
		expect(kinds.filter(kind => kind === "renameRemoteFile")).toHaveLength(MOVE)
		// …and nothing is re-uploaded (server-side rename/move only).
		expect(kinds).not.toContain("upload")

		// The moved files now live under /project/lib; the rest stayed under /project/src; old root is gone.
		expect(result.finalRemote["/proj"]).toBeUndefined()

		for (let i = 0; i < SRC_FILES; i++) {
			const expected = i < MOVE ? `/project/lib/file-${i}.txt` : `/project/src/file-${i}.txt`

			expect(result.finalRemote[expected], `file-${i}`).toMatchObject({ type: "file" })
		}

		expect(result.finalRemote["/project/lib/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LR2: a deeply nested chain renamed at the TOP while its deep leaf is independently renamed (most-specific collapse)", async () => {
		const initialLocal: Record<string, string> = {
			"/local/a/b/c/d/e/leaf.txt": "leaf",
			"/local/a/b/c/d/e/other.txt": "other",
			"/local/a/b/sib.txt": "sib"
		}

		const result = await runScenario({
			name: "LR2",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("noise", 30)),
			steps: [
				runCycle(),
				localMutate(world => {
					// Rename the top dir AND rename the deep leaf in the same cycle.
					renameLocal(world, "a", "A")
					renameLocal(world, "A/b/c/d/e/leaf.txt", "A/b/c/d/e/leaf-renamed.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		// One dir rename (the top), one file rename (the leaf, rebased under /A) — no re-upload.
		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		expect(kinds.filter(kind => kind === "renameRemoteFile")).toHaveLength(1)
		expect(kinds).not.toContain("upload")

		expect(result.finalRemote["/A/b/c/d/e/leaf-renamed.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/A/b/c/d/e/leaf.txt"]).toBeUndefined()
		expect(result.finalRemote["/A/b/c/d/e/other.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("LR3: a big subtree MOVED into a brand-new parent created the same cycle — carried, not re-uploaded", async () => {
		const FILES = 14
		const initialLocal: Record<string, string> = {}

		for (let i = 0; i < FILES; i++) {
			initialLocal[`/local/module/file-${i}.txt`] = `m-${i}`
		}

		const result = await runScenario({
			name: "LR3",
			mode: "twoWay",
			initialLocal: mergeSpecs(initialLocal, genNoise("root", 25)),
			steps: [
				runCycle(),
				localMutate(world => {
					// Move /module under a brand-new /packages/core directory (created implicitly by the move).
					renameLocal(world, "module", "packages/core/module")
				}),
				runCycle(),
				runCycle()
			]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		// The move is one dir rename carrying every child; the new intermediate dirs are created, not uploaded.
		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("renameRemoteFile")
		expect(kinds).not.toContain("upload")

		expect(result.finalRemote["/packages/core/module"]).toMatchObject({ type: "directory" })

		for (let i = 0; i < FILES; i++) {
			expect(result.finalRemote[`/packages/core/module/file-${i}.txt`], `file-${i}`).toMatchObject({ type: "file" })
		}

		expect(result.finalRemote["/module"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
