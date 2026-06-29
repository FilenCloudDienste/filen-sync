import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, touchLocal } from "../harness/mutations"
import { knownBug } from "../harness/known-bug"

/**
 * Category AF — cyclic / rotation renames (twoWay). A rename cycle (a→b, b→c, c→a) cannot be applied
 * naively because every target already exists; the engine's rename detector refuses to rename onto an
 * occupied path, so a rotation converges via the content-modify fallback (re-upload / re-download). It
 * therefore needs the per-path change signal to fire — i.e. a DISTINCT size or whole-second mtime per
 * file (the realistic case: a real rotation preserves each file's original, differing mtime). These
 * exercise 3- and 4-way rotations on both files and directories, locally and remotely. Add-only.
 *
 * The local rotation is performed on disk via a temp hop so each inode is preserved end-to-end:
 *   a→tmp, c→a, b→c, tmp→b   ⇒   a=oldC, b=oldA, c=oldB.
 *
 * The identical-size+mtime corner is an ACCEPTED limitation (same family as C6/E6 whole-second cases):
 * a local content change that preserves BOTH byte-size and whole-second mtime is invisible by design —
 * the engine never hashes in the hot path. It is pinned as a knownBug tripwire (AF5) rather than fixed.
 */
describe("Category AF — cyclic / rotation renames", () => {
	it("AF1: 3-way file rotation on the local side converges with rotated content", async () => {
		const result = await runScenario({
			name: "AF1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "AAA", "/local/b.txt": "BBB", "/local/c.txt": "CCC" },
			steps: [
				// Distinct per-file mtimes so the rotation changes each path's mtime (a real rotation keeps
				// each file's own, differing timestamp).
				localMutate(world => {
					touchLocal(world, "a.txt", 1_700_000_000_000)
					touchLocal(world, "b.txt", 1_700_000_100_000)
					touchLocal(world, "c.txt", 1_700_000_200_000)
				}),
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "tmp.txt")
					renameLocal(world, "c.txt", "a.txt")
					renameLocal(world, "b.txt", "c.txt")
					renameLocal(world, "tmp.txt", "b.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file" })
		// a=oldC, b=oldA, c=oldB — content (hash) must match the local truth on both sides.
		expect(result.finalRemote["/a.txt"]!.contentHash).toBe(result.finalLocal["/a.txt"]!.contentHash)
		expect(result.finalRemote["/b.txt"]!.contentHash).toBe(result.finalLocal["/b.txt"]!.contentHash)
		expect(result.finalRemote["/c.txt"]!.contentHash).toBe(result.finalLocal["/c.txt"]!.contentHash)
		// The three hashes are all distinct (no content was lost or duplicated).
		const hashes = new Set([
			result.finalRemote["/a.txt"]!.contentHash,
			result.finalRemote["/b.txt"]!.contentHash,
			result.finalRemote["/c.txt"]!.contentHash
		])
		expect(hashes.size).toBe(3)
	})

	it("AF2: 3-way file rotation on the remote side converges with rotated content", async () => {
		const result = await runScenario({
			name: "AF2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "AAA", "/local/b.txt": "BBB", "/local/c.txt": "CCC" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					// A remote move preserves the uuid, and a moved-in uuid differs from the one previously at
					// the path, so the uuid-change signal catches the rotation regardless of size/mtime.
					world.cloud.controls.movePath("/a.txt", "/tmp.txt")
					world.cloud.controls.movePath("/c.txt", "/a.txt")
					world.cloud.controls.movePath("/b.txt", "/c.txt")
					world.cloud.controls.movePath("/tmp.txt", "/b.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		const hashes = new Set([
			result.finalLocal["/a.txt"]!.contentHash,
			result.finalLocal["/b.txt"]!.contentHash,
			result.finalLocal["/c.txt"]!.contentHash
		])
		expect(hashes.size).toBe(3)
	})

	it("AF3: 3-way directory rotation on the local side converges with rotated children", async () => {
		const result = await runScenario({
			name: "AF3",
			mode: "twoWay",
			initialLocal: { "/local/a/x.txt": "ax", "/local/b/y.txt": "by", "/local/c/z.txt": "cz" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a", "tmp")
					renameLocal(world, "c", "a")
					renameLocal(world, "b", "c")
					renameLocal(world, "tmp", "b")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		// a now holds c's child (z.txt), b holds a's (x.txt), c holds b's (y.txt).
		expect(result.finalRemote["/a/z.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/b/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/c/y.txt"]).toMatchObject({ type: "file" })
		// Stale child paths are gone.
		expect(result.finalRemote["/a/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/b/y.txt"]).toBeUndefined()
		expect(result.finalRemote["/c/z.txt"]).toBeUndefined()
	})

	it("AF4: 4-way file rotation on the local side converges", async () => {
		const result = await runScenario({
			name: "AF4",
			mode: "twoWay",
			initialLocal: {
				"/local/1.txt": "one",
				"/local/2.txt": "two",
				"/local/3.txt": "three",
				"/local/4.txt": "four"
			},
			steps: [
				localMutate(world => {
					touchLocal(world, "1.txt", 1_700_000_000_000)
					touchLocal(world, "2.txt", 1_700_000_100_000)
					touchLocal(world, "3.txt", 1_700_000_200_000)
					touchLocal(world, "4.txt", 1_700_000_300_000)
				}),
				runCycle(),
				localMutate(world => {
					// 1→2→3→4→1 rotation via a temp hop.
					renameLocal(world, "1.txt", "tmp.txt")
					renameLocal(world, "4.txt", "1.txt")
					renameLocal(world, "3.txt", "4.txt")
					renameLocal(world, "2.txt", "3.txt")
					renameLocal(world, "tmp.txt", "2.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
		const hashes = new Set([
			result.finalLocal["/1.txt"]!.contentHash,
			result.finalLocal["/2.txt"]!.contentHash,
			result.finalLocal["/3.txt"]!.contentHash,
			result.finalLocal["/4.txt"]!.contentHash
		])
		expect(hashes.size).toBe(4)
	})

	// AF5 — accepted limitation (NOT a fix target). A local 3-way rotation of files that share the exact
	// same byte-size AND whole-second mtime swaps content invisibly: the rename-onto-occupied guard
	// suppresses the rename, and the content-modify fallback sees no size/mtime delta (the engine never
	// hashes in the hot path — md5 is only an optional dedup AFTER size/mtime already flagged a change,
	// and SDK metadata hashes are unreliable). The two sides silently diverge. This asserts the IDEAL
	// (convergence) so it stays a tripwire: if local change-detection ever gains a content signal, this
	// flips to passing and forces a conscious decision. Same family as the C6/E6 whole-second cases.
	knownBug("AF-SAMESIZE-MTIME", "identical-size+mtime local 3-way rotation converges", async () => {
		const result = await runScenario({
			name: "AF5",
			mode: "twoWay",
			// AAA/BBB/CCC: identical 3-byte size; the harness stamps one shared BASE_TIME mtime on all.
			initialLocal: { "/local/a.txt": "AAA", "/local/b.txt": "BBB", "/local/c.txt": "CCC" },
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "a.txt", "tmp.txt")
					renameLocal(world, "c.txt", "a.txt")
					renameLocal(world, "b.txt", "c.txt")
					renameLocal(world, "tmp.txt", "b.txt")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
