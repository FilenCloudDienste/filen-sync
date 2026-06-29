import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { allOps } from "../harness/snapshot"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category IG — the synced `.filenignore` config file (feature, 2026-06-29).
 *
 * The root `.filenignore` is the ignore list the engine reads every cycle; to share one ignore config across
 * all machines on a pair it now SYNCS even when `excludeDotFiles` is on (exempt from the dotfile filter on
 * both scans AND the delta filter — see `isSyncedIgnoreFile`). It remains EXCLUDABLE by an explicit
 * `.filenignore` rule (maintainer decision: "sync, but still ignorable"). These pin: the file syncs under
 * excludeDotFiles, a REMOTE edit round-trips and its new rules take effect next cycle (the realistic
 * multi-device case), an explicit self-ignore opts it out, a NESTED `.filenignore` is NOT special, and
 * deleting it reverts the rules. add-only.
 */
describe("Category IG — synced .filenignore config", () => {
	it("IG1: the root .filenignore SYNCS even under excludeDotFiles (other dotfiles stay excluded)", async () => {
		const result = await runScenario({
			name: "IG1",
			mode: "twoWay",
			excludeDotFiles: true,
			filenIgnore: "ignored.txt",
			initialLocal: {
				"/local/ignored.txt": "should-not-sync",
				"/local/kept.txt": "syncs",
				"/local/.DS_Store": "junk-dotfile"
			},
			steps: [runCycle(), runCycle()]
		})

		// The ignore config reached the remote…
		expect(result.finalRemote["/.filenignore"]).toMatchObject({ type: "file", size: "ignored.txt".length })
		// …a normal file synced, the .filenignore'd file did not, and OTHER dotfiles are still excluded.
		expect(result.finalRemote["/kept.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/ignored.txt"]).toBeUndefined()
		expect(result.finalRemote["/.DS_Store"]).toBeUndefined()
	})

	it("IG2: a REMOTE edit to .filenignore round-trips — the new rule applies next cycle (file kept, not deleted)", async () => {
		const result = await runScenario({
			name: "IG2",
			mode: "twoWay",
			excludeDotFiles: true,
			initialLocal: { "/local/secret.txt": "data", "/local/keep.txt": "keep" },
			steps: [
				// Cycle 1: both files sync up (no .filenignore yet) — secret.txt reaches the remote.
				runCycle(),
				// Another device drops a .filenignore on the remote that will ignore secret.txt.
				remoteMutate(world => world.cloud.controls.addFile("/.filenignore", "secret.txt")),
				// Cycle 2 downloads it; cycle 3 re-reads it and secret.txt becomes ignored.
				runCycle(),
				runCycle(),
				runCycle(),
				// secret.txt is ignored now — a local edit to it must NOT propagate.
				localMutate(world => writeLocal(world, "secret.txt", "locally-edited-but-ignored-now")),
				runCycle(),
				runCycle()
			]
		})

		// The config downloaded and is present on both sides…
		expect(result.finalLocal["/.filenignore"]).toMatchObject({ type: "file", size: "secret.txt".length })
		// …the now-ignored file is KEPT on both sides (ignore ≠ delete), never wiped by the new rule…
		expect(result.finalLocal["/secret.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		// …and the remote copy stays the ORIGINAL bytes (the post-ignore local edit never uploaded).
		expect(result.finalRemote["/secret.txt"]).toMatchObject({ type: "file", size: "data".length })
	})

	it("IG3: an explicit rule that ignores `.filenignore` itself opts it out of syncing (still ignorable)", async () => {
		const result = await runScenario({
			name: "IG3",
			mode: "twoWay",
			excludeDotFiles: true,
			filenIgnore: ".filenignore\nnormal-ignored.txt",
			initialLocal: { "/local/normal-ignored.txt": "x", "/local/synced.txt": "y" },
			steps: [runCycle(), runCycle()]
		})

		// The user explicitly ignored `.filenignore`, so it does NOT sync (Option 2: still ignorable).
		expect(result.finalRemote["/.filenignore"]).toBeUndefined()
		// The other rule still works; a normal file still syncs.
		expect(result.finalRemote["/normal-ignored.txt"]).toBeUndefined()
		expect(result.finalRemote["/synced.txt"]).toMatchObject({ type: "file" })
	})

	it("IG4: a NESTED dir/.filenignore is NOT special — it stays excluded under excludeDotFiles", async () => {
		const result = await runScenario({
			name: "IG4",
			mode: "twoWay",
			excludeDotFiles: true,
			initialLocal: { "/local/sub/.filenignore": "nested", "/local/sub/file.txt": "keep", "/local/.filenignore": "" },
			steps: [runCycle(), runCycle()]
		})

		// Only the ROOT .filenignore is exempt; a nested one is a normal dotfile → excluded.
		expect(result.finalRemote["/sub/.filenignore"]).toBeUndefined()
		expect(result.finalRemote["/sub/file.txt"]).toMatchObject({ type: "file" })
	})

	it("IG5: deleting .filenignore reverts its rules — a previously-ignored file then syncs", async () => {
		const result = await runScenario({
			name: "IG5",
			mode: "twoWay",
			filenIgnore: "temp.txt",
			initialLocal: { "/local/temp.txt": "was-ignored", "/local/normal.txt": "y" },
			steps: [
				// Cycle 1: temp.txt ignored, .filenignore + normal.txt sync.
				runCycle(),
				// Delete the ignore config.
				localMutate(world => rmLocal(world, ".filenignore")),
				runCycle(),
				runCycle()
			]
		})

		// With the rules gone, the previously-ignored file now syncs, and the config is removed on both sides.
		expect(result.finalRemote["/temp.txt"]).toMatchObject({ type: "file", size: "was-ignored".length })
		expect(result.finalRemote["/.filenignore"]).toBeUndefined()
		expect(result.finalLocal["/.filenignore"]).toBeUndefined()
	})

	it("IG6: ignoring the ONLY child of a directory after sync keeps both copies (ignore ≠ delete), no churn", async () => {
		const result = await runScenario({
			name: "IG6",
			mode: "twoWay",
			initialLocal: { "/local/dir/only.txt": "v1", "/local/other.txt": "o" },
			steps: [
				// Cycle 1: dir/only.txt + other.txt sync.
				runCycle(),
				// Now ignore only.txt (its directory's sole child) — dir becomes empty in the scan.
				localMutate(world => writeLocal(world, ".filenignore", "only.txt")),
				runCycle(),
				runCycle()
			]
		})

		// The ignored child is NOT deleted from either side (ignore ≠ delete); the directory survives.
		expect(result.finalRemote["/dir/only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/dir/only.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir"]).toMatchObject({ type: "directory" })

		// And it's a fixed point — no oscillation deleting/recreating the now-ignored child.
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})
})
