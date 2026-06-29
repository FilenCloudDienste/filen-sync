import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { writeLocal, rmLocal } from "../harness/mutations"

/**
 * Category AI — type changes (file⇄directory) at one path, alone and combined with a cross-side edit
 * (twoWay). The same path flipping kind is a delete+create that must be ordered correctly so the new
 * kind wins on both sides; the cross-side variant is a genuine type conflict that must at least
 * CONVERGE (both sides agree) without crashing. Add-only.
 */
describe("Category AI — file⇄directory type changes", () => {
	it("AI1: a file becomes a directory at the same path — converges to the directory", async () => {
		const result = await runScenario({
			name: "AI1",
			mode: "twoWay",
			initialLocal: { "/local/x": "i am a file" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					writeLocal(world, "x/inner.txt", "now a dir")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/x/inner.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AI2: a directory becomes a file at the same path — converges to the file", async () => {
		const result = await runScenario({
			name: "AI2",
			mode: "twoWay",
			initialLocal: { "/local/x/inner.txt": "child" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					writeLocal(world, "x", "now a file")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/x"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/x/inner.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("AI3: local creates a file where the remote creates a directory (same fresh path) — must converge", async () => {
		const result = await runScenario({
			name: "AI3",
			mode: "twoWay",
			initialLocal: { "/local/anchor.txt": "anchor" },
			steps: [
				runCycle(),
				localMutate(world => writeLocal(world, "x", "local file")),
				remoteMutate(world => {
					world.cloud.controls.addDir("/x")
					world.cloud.controls.addFile("/x/inner.txt", "remote child")
				}),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Hard requirement: the two sides must agree on what /x is (a file-vs-directory conflict must not
		// leave the replicas permanently diverged or crash the cycle).
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/anchor.txt"]).toMatchObject({ type: "file" })
	})

	it("AI4: a file becomes a directory locally while the remote edits the old file — converges to the directory", async () => {
		const result = await runScenario({
			name: "AI4",
			mode: "twoWay",
			initialLocal: { "/local/x": "original file" },
			steps: [
				runCycle(),
				localMutate(world => {
					rmLocal(world, "x")
					writeLocal(world, "x/inner.txt", "dir child")
				}),
				remoteMutate(world => world.cloud.controls.updateFile("/x", "remote edit")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The local type-change and the remote content edit collide at /x; both sides must converge.
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
