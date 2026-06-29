import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"

/**
 * Category MF — the no-base size-divergence reconciliation (F9 / `noBaseSizeDiverged`) on the ADDITIVE
 * backup modes. F9 fires when a path exists on BOTH sides with NO common base and DIFFERENT sizes: the
 * authoritative side is forced to win (it can't be the synced copy if the sizes differ). It is pinned for
 * the mirror modes (localToCloud U18, cloudToLocal W17) but `directionalPush`/`directionalPull` also cover
 * the backup modes (`deltas.ts` — directionalPush = localToCloud||localBackup, directionalPull =
 * cloudToLocal||cloudBackup), so the backup-mode branch was an untested code path. add-only.
 */
describe("Category MF — F9 no-base size divergence on backup modes", () => {
	it("MF1: localBackup — a no-base remote stray of a DIFFERENT size is overwritten by the authoritative local copy", async () => {
		const result = await runScenario({
			name: "MF1",
			mode: "localBackup",
			// Both sides independently have /file.txt with NO common base, different sizes (4 vs 8).
			initialLocal: { "/local/file.txt": "AAAA" },
			initialRemote: { "/file.txt": "BBBBBBBB" },
			steps: [runCycle(), runCycle()]
		})

		// directionalPush forces local to win the no-base size conflict → the remote stray is replaced.
		expect(result.finalRemote["/file.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
		expect(result.finalLocal["/file.txt"]).toMatchObject({ type: "file", size: "AAAA".length })
	})

	it("MF2: cloudBackup — a no-base local stray of a DIFFERENT size is overwritten by the authoritative remote copy", async () => {
		const result = await runScenario({
			name: "MF2",
			mode: "cloudBackup",
			initialLocal: { "/local/file.txt": "AAAA" },
			initialRemote: { "/file.txt": "BBBBBBBB" },
			steps: [runCycle(), runCycle()]
		})

		// directionalPull forces remote to win the no-base size conflict → the local stray is replaced.
		expect(result.finalLocal["/file.txt"]).toMatchObject({ type: "file", size: "BBBBBBBB".length })
		expect(result.finalRemote["/file.txt"]).toMatchObject({ type: "file", size: "BBBBBBBB".length })
	})
})
