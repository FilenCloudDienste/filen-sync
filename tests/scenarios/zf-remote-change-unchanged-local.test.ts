import { describe, it, expect } from "vitest"
import { runScenario, runCycle, remoteMutate, localMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds } from "../harness/snapshot"
import { readLocal, writeLocalAt } from "../harness/mutations"

/**
 * Category ZF — a genuine REMOTE content change must be pulled in twoWay even when the remote's mtime is
 * not strictly newer than the local copy, AS LONG AS the local copy is itself unchanged since the base.
 *
 * The download gate's `remoteWins` term only resolved a CONFLICT (newer mtime wins), but it applied the
 * newer-mtime tiebreak unconditionally — so when only the remote changed (no conflict, local untouched) a
 * remote edit whose mtime equalled or trailed the local mtime was silently dropped and never re-pulled. The
 * remote re-upload mints a new uuid, so the change is unambiguously detectable; the tiebreak belongs to the
 * both-changed case only. The fix makes `remoteWins` also true when the local copy is unchanged vs the base.
 */
const SECOND = 1000

describe("Category ZF — remote change vs unchanged local (twoWay, mtime tiebreak)", () => {
	it("ZF1: a remote edit with an EQUAL mtime is pulled when local is unchanged", async () => {
		const result = await runScenario({
			name: "ZF1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": { content: "v1", mtimeMs: BASE_TIME }, "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				// Remote re-uploads new content (new uuid) but stamps the SAME whole-second mtime as local.
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "v2-remote-edit", { mtimeMs: BASE_TIME })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The change must actually be downloaded (not just "eventually equal" by some other path).
		expect(transferKinds(result.cycles[1]!.messages)).toContain("download")
		expect(readLocal(result.world, "a.txt")).toBe("v2-remote-edit")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZF2: a remote edit with an OLDER mtime is pulled when local is unchanged", async () => {
		const result = await runScenario({
			name: "ZF2",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": { content: "v1", mtimeMs: BASE_TIME + 10 * SECOND }, "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				// Remote edit lands with an mtime BEHIND the local copy (e.g. an out-of-sync clock on the
				// editing device). It still changed (new uuid) and local is untouched, so it must win.
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "older-but-real", { mtimeMs: BASE_TIME })),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(readLocal(result.world, "a.txt")).toBe("older-but-real")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("ZF3: a real CONFLICT (both edited) still resolves by newer mtime — local newer wins, not the older remote", async () => {
		const result = await runScenario({
			name: "ZF3",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": { content: "v1", mtimeMs: BASE_TIME }, "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				// BOTH sides edit: local becomes strictly newer than the remote edit → local must win the
				// conflict (the fix must NOT turn every remote change into an unconditional pull).
				remoteMutate(world => world.cloud.controls.updateFile("/a.txt", "remote-older", { mtimeMs: BASE_TIME + 1 * SECOND })),
				localMutate(world => writeLocalAt(world, "a.txt", "local-newer", BASE_TIME + 5 * SECOND)),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(readLocal(result.world, "a.txt")).toBe("local-newer")
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
