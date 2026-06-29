import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { renameLocal } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category XS — a true cross-side SWAP, where each side performs ONE half of the swap so the two file
 * identities CROSS: local renames a→b while remote renames b→a, in the same cycle. (E/Z cover a LOCAL-only
 * swap via a temp hop; Y9 covers both sides renaming the SAME file to different names. This is the harder
 * shape — the two renames target each other's source.)
 *
 * Renaming onto an occupied name destroys the occupant on each side (local fs.move overwrite; backend
 * renameFile/renameDirectory with overwriteIfExists trashes the occupant — see the fake's movePath, made
 * faithful to that backend rule). So after the mutations the content survives only on its OTHER side:
 * a's bytes at local b, b's bytes at remote a. The engine must converge to the SWAPPED state — a holds the
 * old-b content, b holds the old-a content — with no loss and no duplication.
 *
 * Distinct sizes (so the resurrect/modify guards fire deterministically — the same-size+second corner is
 * the accepted C11 blind spot, not exercised here).
 */
const SECOND = 1000

describe("Category XS — cross-side swap (local a→b, remote b→a)", () => {
	it("XS1: file swap → converges to a=old-b, b=old-a (content really swapped, no loss)", async () => {
		const result = await runScenario({
			name: "XS1",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 50 * SECOND },
				"/local/b.txt": { content: "BBBBBB", mtimeMs: BASE_TIME + 60 * SECOND }
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/b.txt", "/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Swapped: a now holds the old-b bytes, b holds the old-a bytes.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "BBBBBB".length })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
		expect(result.finalLocal["/b.txt"]!.contentHash).toBe(result.finalRemote["/b.txt"]!.contentHash)
		// The two surviving files hold DISTINCT content (no aliasing / both-became-one collapse).
		expect(result.finalLocal["/a.txt"]!.contentHash).not.toBe(result.finalLocal["/b.txt"]!.contentHash)
	})

	it("XS2: directory swap → converges (a holds b's children, b holds a's children)", async () => {
		const result = await runScenario({
			name: "XS2",
			mode: "twoWay",
			initialLocal: {
				"/local/a/ax.txt": "AX",
				"/local/b/bx.txt": "BXBX"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a", "b")),
				remoteMutate(world => world.cloud.controls.movePath("/b", "/a")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// a now holds b's child; b now holds a's child.
		expect(result.finalRemote["/a/bx.txt"]).toMatchObject({ type: "file", size: "BXBX".length })
		expect(result.finalRemote["/b/ax.txt"]).toMatchObject({ type: "file", size: "AX".length })
		expect(result.finalRemote["/a/ax.txt"]).toBeUndefined()
		expect(result.finalRemote["/b/bx.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XS3: localToCloud — local half of the swap is authoritative; the foreign remote half is mirrored away", async () => {
		const result = await runScenario({
			name: "XS3",
			mode: "localToCloud",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 50 * SECOND },
				"/local/b.txt": { content: "BBBBBB", mtimeMs: BASE_TIME + 60 * SECOND }
			},
			steps: [
				runCycle(),
				// Local: a→b (overwrites local b). Remote (foreign peer): b→a (overwrites remote a).
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/b.txt", "/a.txt")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Local truth after the overwrite is just { b: old-a }. The strict mirror forces remote to match:
		// the foreign remote a is removed and b carries the old-a content. The old-b bytes are gone (the
		// user overwrote them locally — additive survival is not a mirror-mode promise).
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XS4: after a cross-side swap converges, an extra cycle is a no-op (stability)", async () => {
		const result = await runScenario({
			name: "XS4",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 50 * SECOND },
				"/local/b.txt": { content: "BBBBBB", mtimeMs: BASE_TIME + 60 * SECOND }
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "a.txt", "b.txt")),
				remoteMutate(world => world.cloud.controls.movePath("/b.txt", "/a.txt")),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)

		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ size: "BBBBBB".length })
		expect(result.finalRemote["/b.txt"]).toMatchObject({ size: "AAAA".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
