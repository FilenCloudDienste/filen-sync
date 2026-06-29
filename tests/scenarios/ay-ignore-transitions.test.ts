import { describe, it, expect } from "vitest"
import pathModule from "path"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { BASE_TIME, DB_ROOT, type World } from "../harness/world"
import { writeLocal, writeLocalAt } from "../harness/mutations"
import { allOps, transferKinds } from "../harness/snapshot"
import { IGNORER_VERSION } from "../../src/ignorer"

/**
 * Category AY — a path crossing the IGNORE boundary over time. Category F pins static ignore rules and
 * F7/F13/ZS pin a rule added mid-run (ignored paths are excluded from sync but never deleted). The
 * remaining shape is UN-ignoring: a path that drifted (was edited / gained content) while ignored, then
 * becomes tracked again, must sync its CURRENT state — the base still holds the last-synced version, so the
 * drift is a normal change to propagate. And toggling a rule on then off on an UNCHANGED path must not churn.
 *
 * Rules are driven through the dbPath-side `.filenignore` copy (merged with the physical one each cycle, like
 * F8) so the test never creates a syncing physical `.filenignore`; a manual watcher trigger forces the rescan
 * that a real `.filenignore` edit would.
 */
const SECOND = 1000

/** Set the dbPath-side `.filenignore` copy AND force the next cycle to rescan (as a real edit would). */
function setIgnore(world: World, content: string): void {
	const dir = pathModule.posix.join(DB_ROOT, "ignorer", `v${IGNORER_VERSION}`, world.syncPair.uuid)

	world.vfs.ifs.mkdirSync(dir, { recursive: true })
	world.vfs.ifs.writeFileSync(pathModule.posix.join(dir, "filenIgnore"), content)
	world.triggerWatcher()
}

describe("Category AY — ignore transitions", () => {
	it("AY1: a file edited WHILE ignored uploads its CURRENT content once un-ignored", async () => {
		const result = await runScenario({
			name: "AY1",
			mode: "twoWay",
			initialLocal: { "/local/data.txt": "v1" },
			steps: [
				runCycle(),
				// Ignore the file, then edit it while it is out of the sync's view.
				control(world => setIgnore(world, "data.txt")),
				localMutate(world => writeLocalAt(world, "data.txt", "v2-modified-content", BASE_TIME + 100 * SECOND)),
				runCycle(),
				// Un-ignore: the next scan sees the drifted file and must push its CURRENT content.
				control(world => setIgnore(world, "")),
				runCycle(),
				runCycle()
			]
		})

		// While ignored, the edit did NOT propagate — the remote copy stayed at v1.
		expect(result.cycles[1]!.remote["/data.txt"]).toMatchObject({ size: "v1".length })
		// After un-ignoring, the CURRENT (v2) content is what converges — not the stale v1.
		expect(result.finalRemote["/data.txt"]).toMatchObject({ type: "file", size: "v2-modified-content".length })
		expect(result.finalLocal["/data.txt"]).toMatchObject({ type: "file", size: "v2-modified-content".length })
		expect(result.finalLocal["/data.txt"]!.contentHash).toBe(result.finalRemote["/data.txt"]!.contentHash)
	})

	it("AY2: toggling a rule on then off on an UNCHANGED file causes no churn", async () => {
		const result = await runScenario({
			name: "AY2",
			mode: "twoWay",
			initialLocal: { "/local/x.txt": "stable" },
			steps: [
				runCycle(),
				control(world => setIgnore(world, "x.txt")),
				runCycle(),
				control(world => setIgnore(world, "")),
				runCycle(),
				runCycle()
			]
		})

		// Re-including an unchanged, already-synced file re-derives nothing.
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
		expect(result.finalRemote["/x.txt"]).toMatchObject({ type: "file", size: "stable".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AY3: a directory that gains content WHILE ignored uploads the whole subtree once un-ignored", async () => {
		const result = await runScenario({
			name: "AY3",
			mode: "twoWay",
			initialLocal: { "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				// Ignore a directory, then fill it while it is out of view.
				control(world => setIgnore(world, "secret/")),
				localMutate(world => {
					writeLocal(world, "secret/a.txt", "A")
					writeLocal(world, "secret/b.txt", "B")
				}),
				runCycle(),
				// Un-ignore: the whole subtree must now sync.
				control(world => setIgnore(world, "")),
				runCycle(),
				runCycle()
			]
		})

		// While ignored, nothing inside secret/ reached the remote.
		expect(result.cycles[1]!.remote["/secret/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/secret/a.txt"]).toMatchObject({ type: "file", size: "A".length })
		expect(result.finalRemote["/secret/b.txt"]).toMatchObject({ type: "file", size: "B".length })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AY4: re-ignoring an already-synced file keeps the remote copy (ignore ≠ delete)", async () => {
		const result = await runScenario({
			name: "AY4",
			mode: "twoWay",
			initialLocal: { "/local/doc.txt": "synced" },
			steps: [
				runCycle(),
				// Ignore the already-synced file; its remote copy must stay (ignore never deletes).
				control(world => setIgnore(world, "doc.txt")),
				runCycle(),
				runCycle()
			]
		})

		// The re-ignored file is left on both sides — ignoring is not a deletion.
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("deleteRemoteFile")
		expect(result.finalRemote["/doc.txt"]).toMatchObject({ type: "file", size: "synced".length })
		expect(result.finalLocal["/doc.txt"]).toMatchObject({ type: "file", size: "synced".length })
	})
})
