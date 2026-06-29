import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { renameLocal, rmLocal } from "../harness/mutations"

/**
 * Category FD — the DEEP file↔directory name-swap: a path that is a FILE at the base is turned into a
 * DIRECTORY on one side, and another file is MOVED into a brand-new SUBDIRECTORY of it in the same cycle
 * (e.g. file /x → /x/sub/child.txt). This is the exact case `renameDestinationBlockedByFileAncestor` exists
 * for: the moved child's destination has an ANCESTOR (/x) that is still a FILE in the other side's current
 * tree, so a server-side rename of the child cannot be placed under it (the backend can't create a directory
 * under a file). The engine must SUPPRESS the cheap rename and instead delete-the-file + create-the-dir +
 * (re)upload/download the child — converging with the moved content intact and never wedging on the order.
 *
 * AS4 covers the shallow file→dir-at-the-old-path swap; FD pins the DEEP (multi-level) move-into-it and the
 * symmetric remote case (the function's second caller).
 */
describe("Category FD — deep file→dir type change with a nested move into it", () => {
	it("FD1: local turns file /x into a dir AND moves a file into /x/sub/child.txt → converges, content intact", async () => {
		const result = await runScenario({
			name: "FD1",
			mode: "twoWay",
			initialLocal: { "/local/x": "X-FILE-CONTENT", "/local/other.txt": "MOVED-CONTENT" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					// Move other.txt into a brand-new subdirectory of the path that was a file — its ancestor /x is
					// still a FILE on the remote, so the rename must be suppressed and rebuilt as delete+create+upload.
					renameLocal(world, "other.txt", "x/sub/child.txt")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/x/sub/child.txt"]).toMatchObject({ type: "file", size: "MOVED-CONTENT".length })
		expect(result.finalRemote["/other.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		// The moved bytes really survived the type-change-driven delete+recreate.
		expect(result.finalLocal["/x/sub/child.txt"]!.contentHash).toBe(result.finalRemote["/x/sub/child.txt"]!.contentHash)
	})

	it("FD2: remote turns file /x into a dir AND moves a file into /x/sub/child.txt → converges (symmetric)", async () => {
		const result = await runScenario({
			name: "FD2",
			mode: "twoWay",
			initialLocal: { "/local/x": "X-FILE-CONTENT", "/local/other.txt": "MOVED-CONTENT" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.deletePath("/x")
					// movePath re-creates /x and /x/sub as directories and reparents other.txt's uuid under them.
					world.cloud.controls.movePath("/other.txt", "/x/sub/child.txt")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalLocal["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/x/sub/child.txt"]).toMatchObject({ type: "file", size: "MOVED-CONTENT".length })
		expect(result.finalLocal["/other.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("FD3: after the deep file→dir move converges, an extra cycle is a no-op (no wedge, no re-download loop)", async () => {
		const result = await runScenario({
			name: "FD3",
			mode: "twoWay",
			initialLocal: { "/local/x": "X-FILE-CONTENT", "/local/other.txt": "MOVED-CONTENT" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					renameLocal(world, "other.txt", "x/sub/child.txt")
				}),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		const lastCycle = result.cycles[result.cycles.length - 1]!
		const taskErrors = lastCycle.messages.filter(m => m.type === "taskErrors")
		const kinds = lastCycle.messages.filter(m => m.type === "transfer").map(m => (m as Extract<typeof m, { type: "transfer" }>).data.of)

		// No wedge: the steady state does no work and emits no task errors.
		expect(taskErrors).toHaveLength(0)
		expect(kinds).not.toContain("upload")
		expect(kinds).not.toContain("download")
		expect(result.finalRemote["/x/sub/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
