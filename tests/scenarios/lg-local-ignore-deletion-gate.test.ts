import { describe, it, expect } from "vitest"
import pathModule from "path"
import { runScenario, runCycle, control, remoteMutate } from "../harness/runner"
import { DB_ROOT, type World } from "../harness/world"
import { messagesOfType, transferKinds } from "../harness/snapshot"
import { IGNORER_VERSION } from "../../src/ignorer"

/**
 * Category LG — newly `.filenignore`'ing a synced subtree AT THE SAME TIME another device deletes it. ZT pins
 * the ignore-only case (the deletes the local prune would imply are dropped without spuriously tripping the
 * large-deletion gate). This adds the race where BOTH sides "remove" the subtree: the local side prunes it
 * (ignore), and the remote side trashes it. The engine must converge with the ignored local copy KEPT
 * (ignore ≠ delete wins over the remote deletion) and raise NO confirmation prompt — the dropped deletes for
 * the ignored path must not double-count into the gate from either direction.
 */
function setIgnore(world: World, content: string): void {
	const dir = pathModule.posix.join(DB_ROOT, "ignorer", `v${IGNORER_VERSION}`, world.syncPair.uuid)

	world.vfs.ifs.mkdirSync(dir, { recursive: true })
	world.vfs.ifs.writeFileSync(pathModule.posix.join(dir, "filenIgnore"), content)
	world.triggerWatcher()
}

describe("Category LG — ignore vs concurrent remote deletion of the same subtree", () => {
	it("LG1: ignoring a subtree the remote concurrently deletes keeps the local copy + fires no gate prompt", async () => {
		const result = await runScenario({
			name: "LG1",
			mode: "twoWay",
			requireConfirmationOnLargeDeletion: true,
			excludeDotFiles: true,
			initialLocal: { "/local/sub/a.txt": "a", "/local/sub/b.txt": "b" },
			steps: [
				runCycle(),
				// Newly ignore the whole subtree, and at the same time another device deletes it remotely.
				control(world => setIgnore(world, "sub/")),
				remoteMutate(world => world.cloud.controls.trashPath("/sub")),
				runCycle(),
				runCycle()
			]
		})

		// The now-ignored local copy is kept (ignore wins over the remote deletion)…
		expect(result.finalLocal["/sub/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/sub/b.txt"]).toMatchObject({ type: "file" })
		// …no actual deletion is executed on either side…
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("deleteRemoteDirectory")
		expect(transferKinds(result.cycles[1]!.messages)).not.toContain("deleteLocalDirectory")
		// …and the dropped deletes do not spuriously trip the large-deletion confirmation prompt.
		expect(messagesOfType(result.messages, "confirmDeletion").length).toBe(0)
	})
})
