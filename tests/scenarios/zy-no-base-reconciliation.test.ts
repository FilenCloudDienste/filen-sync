import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, restart, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { writeLocalAt } from "../harness/mutations"

/**
 * Category ZY — reconciliation with NO common base (a genuine first sync where both sides already hold the
 * path, or a sync whose persisted state was lost/corrupted), when the two copies have DIVERGENT content.
 *
 * Category A4 pins identical-content/no-base (no transfer). J5 pins corrupt-state degrade with IDENTICAL
 * content. The remaining shape is no-base + DIFFERENT content: the modify branch has no previous item to
 * attribute change against, so it falls back to a side-vs-side STRICT-newer-mtime comparison (deltas.ts
 * local/remote additions). These pin that the newer copy wins and the worlds converge with no duplication
 * and no loss of the winning version — the real-world "lost the sync database, both sides drifted" recovery.
 */
const SECOND = 1000

describe("Category ZY — no-base divergent-content reconciliation (newer wins)", () => {
	it("ZY1: fresh sync, same path both sides, divergent content, LOCAL newer → local wins", async () => {
		const result = await runScenario({
			name: "ZY1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": { content: "LOCAL-CONTENT", mtimeMs: BASE_TIME + 100 * SECOND } },
			initialRemote: { "/a.txt": { content: "REMOTE", mtimeMs: BASE_TIME + 50 * SECOND } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-CONTENT".length })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "LOCAL-CONTENT".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("ZY2: fresh sync, same path both sides, divergent content, REMOTE newer → remote wins", async () => {
		const result = await runScenario({
			name: "ZY2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": { content: "LOCAL", mtimeMs: BASE_TIME + 50 * SECOND } },
			initialRemote: { "/a.txt": { content: "REMOTE-CONTENT", mtimeMs: BASE_TIME + 100 * SECOND } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-CONTENT".length })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-CONTENT".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
	})

	it("ZY3: fresh sync, divergent content of the SAME byte-size, local newer → local wins on mtime alone", async () => {
		const result = await runScenario({
			name: "ZY3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": { content: "AAAA", mtimeMs: BASE_TIME + 100 * SECOND } },
			initialRemote: { "/a.txt": { content: "BBBB", mtimeMs: BASE_TIME + 50 * SECOND } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		// Same size on both sides — only the newer whole-second mtime distinguishes them with no base.
		expect(result.finalLocal["/a.txt"]!.contentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
		const localContentHash = result.finalLocal["/a.txt"]!.contentHash
		// Local ("AAAA") won, so the converged hash is local's, not remote's ("BBBB").
		expect(result.finalRemote["/a.txt"]).toMatchObject({ size: 4 })
		expect(localContentHash).toBe(result.finalRemote["/a.txt"]!.contentHash)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZY4: settled sync → state corrupted → restart → both sides DRIFTED → newer (remote) wins, no loss", async () => {
		const result = await runScenario({
			name: "ZY4",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "original" },
			steps: [
				runCycle(),
				runCycle(),
				// Both sides edit the same file to different content while "offline"; remote edit is newer.
				localMutate(world => writeLocalAt(world, "a.txt", "LOCAL-DRIFT", BASE_TIME + 100 * SECOND)),
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "REMOTE-DRIFT-NEWER", { mtimeMs: BASE_TIME + 200 * SECOND })),
				// Lose the persisted base (corruption), then restart so the reloaded base is empty.
				control(world => {
					const state = world.sync.state
					const garbage = "broken\n}{not-json\n"

					for (const filePath of [
						state.previousLocalTreePath,
						state.previousLocalINodesPath,
						state.previousRemoteTreePath,
						state.previousRemoteUUIDsPath,
						state.localFileHashesPath
					]) {
						world.vfs.ifs.writeFileSync(filePath, garbage)
					}
				}),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// With no base, the strictly-newer remote copy wins; nothing is duplicated or lost.
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-DRIFT-NEWER".length })
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "REMOTE-DRIFT-NEWER".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZY5: state lost → a file present on only ONE side is ADDED to the other, never spuriously deleted", async () => {
		const result = await runScenario({
			name: "ZY5",
			mode: "twoWay",
			initialLocal: { "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				runCycle(),
				// A new local file appears, then the base is lost before it ever syncs.
				localMutate(world => writeLocalAt(world, "fresh.txt", "FRESH", BASE_TIME + 100 * SECOND)),
				control(world => {
					const state = world.sync.state
					const garbage = "broken\n}{not-json\n"

					for (const filePath of [
						state.previousLocalTreePath,
						state.previousLocalINodesPath,
						state.previousRemoteTreePath,
						state.previousRemoteUUIDsPath,
						state.localFileHashesPath
					]) {
						world.vfs.ifs.writeFileSync(filePath, garbage)
					}
				}),
				restart(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// No base ⇒ no deletion is derivable; the previously-synced file and the new file both survive and
		// are present on BOTH sides (union, never a delete).
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file", size: "k".length })
		expect(result.finalLocal["/fresh.txt"]).toMatchObject({ type: "file", size: "FRESH".length })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/fresh.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
