import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { renameLocal } from "../harness/mutations"

/**
 * Category XC — a rename CHAIN split across the two sides in one cycle: local renames a→b while remote
 * renames b→c (a and b both exist at the base). AF pins SAME-side rotations; Y9 pins both sides renaming
 * the SAME file to different names; this is the harder shape where one side's rename TARGET is the other
 * side's rename SOURCE, so the moves chain through a shared name.
 *
 * Local renaming a→b overwrites the local copy of b (its old bytes only survive on the remote, which moved
 * them to c). The engine must (a) propagate a→b as a server-side rename (the remote source a is unchanged),
 * (b) NOT mis-propagate b→c as a local rename (the local source b now carries a's identity, not b's), and
 * (c) pull c down so b's original content is preserved at its new name. Net: a's content at b, b's content
 * at c — both renames effectively applied, nothing lost.
 */
const SECOND = 1000

describe("Category XC — cross-side split rename chain (a→b local, b→c remote)", () => {
	it("XC1: local a→b while remote b→c → converges to b=oldA, c=oldB (no loss)", async () => {
		const result = await runScenario({
			name: "XC1",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 50 * SECOND },
				"/local/b.txt": { content: "BBBBBB", mtimeMs: BASE_TIME + 60 * SECOND }
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/b.txt", "/c.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// a's content ends up at b (local rename), b's original content survives at c (remote rename).
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file", size: "BBBBBB".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		// Content integrity: b really holds the old-A bytes and c the old-B bytes.
		expect(result.finalLocal["/b.txt"]!.contentHash).toBe(result.finalRemote["/b.txt"]!.contentHash)
		expect(result.finalLocal["/c.txt"]!.contentHash).toBe(result.finalRemote["/c.txt"]!.contentHash)
		expect(result.finalLocal["/b.txt"]!.contentHash).not.toBe(result.finalLocal["/c.txt"]!.contentHash)
	})

	it("XC2: remote a→b while local b→c → converges (symmetric)", async () => {
		const result = await runScenario({
			name: "XC2",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 50 * SECOND },
				"/local/b.txt": { content: "BBBBBB", mtimeMs: BASE_TIME + 60 * SECOND }
			},
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				localMutate(world => renameLocal(world, "b.txt", "c.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// a's content ends up at b (remote rename), b's original content survives at c (local rename).
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file", size: "BBBBBB".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/b.txt"]!.contentHash).not.toBe(result.finalLocal["/c.txt"]!.contentHash)
	})

	it("XC3: DIRECTORY split chain — local renames dir a→b while remote renames dir b→c → converges", async () => {
		const result = await runScenario({
			name: "XC3",
			mode: "twoWay",
			initialLocal: {
				"/local/a/ax.txt": "AX",
				"/local/b/bx.txt": "BX"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a", "b")),
				remoteMutate(world => world.cloud.controls.movePath("/b", "/c")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// a's child ends up under b; b's original child survives under c.
		expect(result.finalRemote["/b/ax.txt"]).toMatchObject({ type: "file", size: "AX".length })
		expect(result.finalRemote["/c/bx.txt"]).toMatchObject({ type: "file", size: "BX".length })
		expect(result.finalRemote["/a/ax.txt"]).toBeUndefined()
		expect(result.finalRemote["/b/bx.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
