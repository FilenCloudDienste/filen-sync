import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { writeLocal } from "../harness/mutations"
import { makeErrnoError } from "../fakes/virtual-fs"

/**
 * Category ZV — a previously-synced file that becomes UNREADABLE must not lose its remote copy.
 *
 * Real-world: a user chmods a synced file to 0o000, or another process exclusively locks it, so the next
 * scan can't stat/read it. The path is then physically present but absent from the scanned tree — exactly
 * the M4 case. The engine must treat it as "ignored (permissions)", NOT as a deletion, so the remote
 * backup survives (propagating the would-be delete would be silent data loss). This is the data-loss half
 * of the permission story that the e2e only tests for a brand-new denied file. add-only.
 */
describe("Category ZV — permission revoked after sync", () => {
	it("ZV1: a synced file that becomes unreadable is kept on the remote, not deleted", async () => {
		const result = await runScenario({
			name: "ZV1",
			mode: "twoWay",
			initialLocal: { "/local/keep.txt": "keep", "/local/secret.txt": "secret" },
			steps: [
				runCycle(),
				// The next fs op that touches secret.txt throws EACCES — the scan's lstat fails, so the file is
				// recorded as "permissions"-ignored rather than scanned.
				control(world => world.vfs.controls.setError("/local/secret.txt", makeErrnoError("EACCES", "permission denied"))),
				localMutate(world => writeLocal(world, "trigger.txt", "t")),
				runCycle()
			]
		})

		// The unreadable-but-previously-synced file must NOT be deleted from the remote.
		expect(result.finalRemote["/secret.txt"]).toMatchObject({ type: "file", size: "secret".length })
		// The unrelated files still sync normally.
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/trigger.txt"]).toMatchObject({ type: "file" })
	})
})
