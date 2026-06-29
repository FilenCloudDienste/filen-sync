import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { rmLocal, mkdirLocal, writeLocal } from "../harness/mutations"
import { transferKinds } from "../harness/snapshot"

/**
 * Category ATC — additive backup modes (localBackup / cloudBackup) TOLERATE a FOREIGN file⇄directory type
 * change on the non-authoritative (target) side, exactly as they tolerate a foreign CONTENT edit (V8/X8).
 *
 * Maintainer decision (2026-06-29): reverting a foreign type change would DELETE data on the very side these
 * modes promise never to delete (localBackup must not delete the remote; cloudBackup must not delete the
 * local). So a foreign type change is left ALONE — the two sides simply diverge at that path, like any
 * tolerated foreign edit. An ORIGINATED type change (the authoritative side changed it) STILL propagates
 * (Category V10/X10). The strict-mirror modes still REVERT a foreign type change (Category ZA).
 */
describe("Category ATC — additive modes tolerate a foreign type change", () => {
	it("ATC1: localBackup — a foreign REMOTE file→directory is TOLERATED (remote folder kept, nothing deleted)", async () => {
		const result = await runScenario({
			name: "ATC1",
			mode: "localBackup",
			initialLocal: { "/local/report.txt": "AAA" },
			steps: [
				runCycle(),
				// Another device replaces the backed-up file with a directory of the same name.
				remoteMutate(world => {
					world.cloud.controls.deletePath("/report.txt")
					world.cloud.controls.addFile("/report.txt/x.txt", "C")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The foreign remote directory + its child survive (no deletion on the 'never delete' remote side)…
		expect(result.finalRemote["/report.txt"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/report.txt/x.txt"]).toMatchObject({ type: "file", size: "C".length })
		// …and the local file is left untouched (the sides diverge at this path — that is the tolerance).
		expect(result.finalLocal["/report.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		// No churn: the steady-state cycle re-asserts nothing.
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("ATC2: cloudBackup — a foreign LOCAL file→directory is TOLERATED (local folder kept, nothing deleted)", async () => {
		const result = await runScenario({
			name: "ATC2",
			mode: "cloudBackup",
			initialRemote: { "/report.txt": "AAA" },
			steps: [
				runCycle(),
				// The user locally replaces the backed-up file with a directory of the same name.
				localMutate(world => {
					rmLocal(world, "report.txt")
					mkdirLocal(world, "report.txt")
					writeLocal(world, "report.txt/x.txt", "C")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The foreign local directory survives (no deletion on the 'never delete' local side)…
		expect(result.finalLocal["/report.txt"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/report.txt/x.txt"]).toMatchObject({ type: "file", size: "C".length })
		// …and the remote file is left untouched.
		expect(result.finalRemote["/report.txt"]).toMatchObject({ type: "file", size: "AAA".length })
		expect(transferKinds(result.cycles[result.cycles.length - 1]!.messages)).toEqual([])
	})

	it("ATC3: localBackup — an ORIGINATED local file→directory STILL propagates to the remote (regression guard)", async () => {
		const result = await runScenario({
			name: "ATC3",
			mode: "localBackup",
			initialLocal: { "/local/doc.txt": "AAA" },
			steps: [
				runCycle(),
				// The LOCAL side (authoritative for the push) originates the type change → it must propagate.
				localMutate(world => {
					rmLocal(world, "doc.txt")
					mkdirLocal(world, "doc.txt")
					writeLocal(world, "doc.txt/child.txt", "C")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/doc.txt"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/doc.txt/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalLocal["/doc.txt/child.txt"]).toMatchObject({ type: "file" })
	})

	it("ATC4: cloudBackup — an ORIGINATED remote file→directory STILL propagates to local (regression guard)", async () => {
		const result = await runScenario({
			name: "ATC4",
			mode: "cloudBackup",
			initialRemote: { "/doc.txt": "AAA" },
			steps: [
				runCycle(),
				// The REMOTE side (authoritative for the pull) originates the type change → it must propagate.
				remoteMutate(world => {
					world.cloud.controls.deletePath("/doc.txt")
					world.cloud.controls.addFile("/doc.txt/child.txt", "C")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/doc.txt"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/doc.txt/child.txt"]).toMatchObject({ type: "file", size: "C".length })
		expect(result.finalRemote["/doc.txt/child.txt"]).toMatchObject({ type: "file" })
	})
})
