import { describe, it, expect, vi } from "vitest"
import { runScenario, runCycle, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { writeLocalAt, readLocal } from "../harness/mutations"

/**
 * Category ZG — a file edited WHILE the local scan is running must not be lost.
 *
 * getDirectoryTree() skips a rescan while `lastDirectoryChangeTimestamp < cache.timestamp`. The cache used
 * to be stamped when the walk ENDED, so a file changed after the engine lstat'd it (but before the walk
 * returned) recorded a change time EARLIER than the stamp — the next cycle then judged the cache fresh and
 * never re-read the edit. Stamping at the walk's START closes that window: the change time is >= the stamp,
 * the strict `<` fails, and the next cycle rescans. This reproduces the race deterministically by editing
 * the file from inside the lstat hook (after the engine read it) and advancing the fake clock so that an
 * end-of-walk stamp WOULD have beaten the edit.
 */
const SECOND = 1000

describe("Category ZG — an edit during the local scan is not lost", () => {
	it("ZG1: a file edited mid-scan is re-detected and uploaded on the next cycle (twoWay)", async () => {
		let fired = false

		const result = await runScenario({
			name: "ZG1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": { content: "v1", mtimeMs: BASE_TIME }, "/local/keep.txt": "k" },
			steps: [
				// Cycle 0: settle the initial state — a.txt="v1" is uploaded and becomes the base.
				runCycle(),
				// Force the next cycle to actually scan (bump the change clock) and arm a one-shot hook that,
				// the moment the engine lstats a.txt, simulates the user overwriting it AFTER it was read, then
				// advances the clock so an end-of-walk stamp would land after the edit's change time.
				control(world => {
					world.triggerWatcher()

					world.vfs.controls.onStat(posixPath => {
						if (fired || !posixPath.endsWith("/a.txt")) {
							return
						}

						fired = true

						const editAt = Date.now()

						writeLocalAt(world, "a.txt", "v2-edited-mid-scan", editAt)
						world.triggerWatcher()
						vi.setSystemTime(editAt + 30 * SECOND)
						world.vfs.controls.clearStatHook()
					})
				}),
				// Cycle 1: the racy scan reads "v1"; the hook overwrites to v2, bumps the change clock, and
				// jumps the clock forward. With the bug the cache is stamped AFTER the edit's change time.
				runCycle(),
				// Cycle 2: must rescan (change time >= scan-start stamp) and upload v2. The bug skips it as a
				// "fresh" cache, so the edit never reaches the remote.
				runCycle(),
				runCycle()
			]
		})

		// The hook edited the local file in BOTH the fixed and buggy worlds, so the discriminating signal is
		// whether the edit reached the REMOTE: convergence holds only if the mid-scan edit was re-detected.
		expect(fired, "the mid-scan lstat hook must have fired").toBe(true)
		expect(readLocal(result.world, "a.txt")).toBe("v2-edited-mid-scan")
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "v2-edited-mid-scan".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
