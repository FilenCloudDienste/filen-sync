import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control } from "../harness/runner"
import { LOCAL_ROOT } from "../harness/world"
import { LOCAL_TRASH_NAME } from "../../src/constants"

/**
 * Category ZO — a download that fails AFTER staging its file must not orphan the staged temp (L1).
 *
 * download() streams the remote file into a uuid-named temp under the local trash dir, then commits it
 * with a single move into place. The size-mismatch guard already discards the temp before throwing, but
 * the general catch (a rejected/partial transfer, or a failure during the commit move) re-threw without
 * removing it — so every failed download leaked a temp file into .filen.trash.local. The periodic trash
 * sweep only ages them out later, so under a flaky connection these accumulate and waste disk in the
 * meantime. The fix discards the temp in the catch path too.
 *
 * Reproduced deterministically by letting the staging succeed and then failing the commit move (the only
 * move whose SOURCE is in the trash dir), which lands execution in the catch with a fully-staged temp.
 *
 * No e2e counterpart: the leak is a LOCAL artifact and the trigger is a failure of the local commit move,
 * which the real backend cannot be made to produce on demand (a backend-side download abort takes the
 * size-mismatch path, which already cleaned up). Boundary noted in tests/e2e/regressions.e2e.test.ts.
 */
describe("Category ZO — a failed download does not orphan its staged temp file", () => {
	it("ZO1: a download that fails while committing its staged file leaves no temp behind", async () => {
		let moveAttempted = false

		const result = await runScenario({
			name: "ZO1",
			mode: "cloudToLocal",
			initialRemote: { "/file.txt": "hello world contents" },
			steps: [
				// Fail the commit move (staging dir -> final path) so the download lands in its catch with a
				// fully-staged temp. Only the download's commit move has a trash-dir source, so nothing else is hit.
				control(world => {
					const realMove = world.vfs.fs.move.bind(world.vfs.fs)

					;(world.vfs.fs as { move: typeof world.vfs.fs.move }).move = (async (
						src: string,
						dest: string,
						opts?: { overwrite?: boolean }
					) => {
						if (src.includes(LOCAL_TRASH_NAME)) {
							moveAttempted = true

							throw new Error("simulated disk error committing the download")
						}

						return realMove(src, dest, opts)
					}) as typeof world.vfs.fs.move
				}),
				runCycle()
			]
		})

		// The failure path was actually exercised: the staged temp's commit move was attempted (a temp existed).
		expect(moveAttempted, "the download must have staged a temp and attempted to commit it").toBe(true)
		// The download did not land (its commit failed), so the local file is absent...
		expect(result.world.vfs.ifs.existsSync(`${LOCAL_ROOT}/file.txt`)).toBe(false)
		// ...and crucially the staged temp file is NOT orphaned in the local trash directory.
		const trashDir = `${LOCAL_ROOT}/${LOCAL_TRASH_NAME}`
		const orphaned = result.world.vfs.ifs.existsSync(trashDir) ? result.world.vfs.ifs.readdirSync(trashDir) : []

		expect(orphaned, "a failed download must not leak its staged temp file").toEqual([])
	})
})
