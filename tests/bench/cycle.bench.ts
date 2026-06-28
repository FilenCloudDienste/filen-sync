import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import { makeScaleWorld, sceneToVfsSpec, forceLocalRescan } from "./harness/scale-world"
import { genWideScene, resetIdentity } from "./harness/trees"
import { SYNC_INTERVAL } from "../../src/constants"
import { LOCAL_ROOT, type World } from "../harness/world"

/**
 * End-to-end cycle benchmark — ties the whole pipeline together (scan + deltas + tasks + state.save)
 * through a real in-memory world. The headline real-world cost is the INCREMENTAL cycle: on a large
 * synced tree, changing ONE file still forces a full-tree rescan + full delta pass + full state.save,
 * all O(N). This is what a desktop user pays on every small edit inside a big folder.
 *
 * Real timers; the debounce is bypassed by ageing lastDirectoryChangeTimestamp, and the uncontended
 * in-memory lock acquires instantly, so a cycle never awaits a scheduled timer.
 */

function ageDebounce(world: World): void {
	world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL - 1_000
}

async function runCycle(world: World): Promise<void> {
	ageDebounce(world)

	await world.sync.runCycle()
}

async function syncToConvergence(world: World): Promise<void> {
	// A few cycles settle an initial sync (uploads, then a no-change confirmation).
	for (let i = 0; i < 3; i++) {
		await runCycle(world)
	}
}

describe("full runCycle", () => {
	it("initial sync (upload everything)", async () => {
		for (const nodes of [2_000, 10_000]) {
			resetIdentity()

			const scene = genWideScene(Math.max(1, Math.round(nodes / 101)), 100)

			await bench({
				group: "runCycle / initial sync (twoWay)",
				name: `${scene.length} nodes`,
				n: scene.length,
				iterations: 3,
				// Fresh world each iteration: initial sync mutates cloud + state irreversibly.
				setup: () => makeScaleWorld({ mode: "twoWay", initialLocal: sceneToVfsSpec(scene) }),
				run: async world => {
					await runCycle(world)

					return world.sync.remoteFileSystem.getDirectoryTreeCache.size
				}
			})
		}
	})

	it("no-change cycle (steady state — engine fixed overhead, network excluded)", async () => {
		resetIdentity()

		const scene = genWideScene(50, 100)
		const world = await makeScaleWorld({ mode: "twoWay", initialLocal: sceneToVfsSpec(scene) })

		await syncToConvergence(world)

		await bench({
			group: "runCycle / no-change steady state",
			name: `${scene.length} nodes synced`,
			n: scene.length,
			iterations: 10,
			setup: () => world,
			run: w => w.sync.runCycle()
		})
	})

	it("incremental: ONE file changed in a large synced tree (the real per-edit cost)", async () => {
		// Baseline capped (initial sync uses the O(N²) transfers semaphore); bumped after the fix.
		for (const nodes of [10_000, 20_000]) {
			resetIdentity()

			const scene = genWideScene(Math.max(1, Math.round(nodes / 101)), 100)
			const world = await makeScaleWorld({ mode: "twoWay", initialLocal: sceneToVfsSpec(scene) })

			await syncToConvergence(world)

			const targetPath = `${LOCAL_ROOT}/dir-0/file-0.txt`
			let counter = 0

			await bench({
				group: "runCycle / incremental 1-file change (twoWay)",
				name: `1 of ${scene.length} nodes`,
				n: scene.length,
				iterations: 5,
				setup: async () => {
					// A growing payload guarantees a size change → detected as a real modify each iteration.
					counter++

					await world.vfs.fs.writeFile(targetPath, "y".repeat(64 + counter), { encoding: "utf-8" })

					forceLocalRescan(world)

					return world
				},
				run: w => runCycle(w)
			})

			// Sanity: still converged (the one change propagated, nothing else churned).
			expect(world.sync.remoteFileSystem.getDirectoryTreeCache.size).toBe(scene.length)
		}
	})
})
