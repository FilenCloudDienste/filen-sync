import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import { makeScaleWorld, sceneToDirTreeResponse, injectDirTreeResponse, forceRemoteRebuild } from "./harness/scale-world"
import { genWideScene, genBalancedScene, resetIdentity, type Scene } from "./harness/trees"
import { type World } from "../harness/world"

/**
 * Remote tree-build benchmark (target T2). `remoteFileSystem.getDirectoryTree` decrypts every folder
 * (SEQUENTIALLY, to build parent paths) and every file (eagerly mapping N promises through a 1024-wide
 * semaphore), then builds the tree+uuids maps.
 *
 * We feed the engine a PRE-BUILT dir-tree response (synthesised from a scene, JSON metadata) so the
 * timed work is ONLY the engine's build loop — NOT the fake cloud's `buildFullTree`, which is O(N²)
 * (test infra: it scans all nodes per directory) and would dominate + mask the engine cost. The fake
 * cloud's decrypt (JSON.parse) is what runs per item, isolating the engine's per-node CPU + the
 * eager-promise/closure memory T2 targets (real SDK crypto is a separate, SDK-owned cost).
 */

async function worldFor(scene: Scene): Promise<World> {
	// Empty remote — we inject the response directly; the world only supplies sdk.crypto + environment.
	const world = await makeScaleWorld({ mode: "twoWay" })

	injectDirTreeResponse(world, sceneToDirTreeResponse(scene, world.cloud.controls.rootUUID))

	return world
}

describe("remoteFileSystem.getDirectoryTree (engine build loop, isolated)", () => {
	it("wide tree size sweep", async () => {
		// NOTE: capped at 200k for the BASELINE — the O(N²) Semaphore (finding 001) makes 500k take
		// minutes. After the semaphore fix this sweep is bumped to 500k/1M (now linear).
		for (const nodes of [10_000, 50_000, 200_000]) {
			resetIdentity()

			const scene = genWideScene(Math.max(1, Math.round(nodes / 101)), 100)
			const world = await worldFor(scene)

			const first = await world.sync.remoteFileSystem.getDirectoryTree(true)

			expect(first.result.size).toBe(scene.length)

			await bench({
				group: "remoteFileSystem.getDirectoryTree / wide",
				name: `${nodes} nodes`,
				n: scene.length,
				iterations: nodes >= 200_000 ? 3 : 5,
				setup: () => {
					forceRemoteRebuild(world)

					return world
				},
				run: w => w.sync.remoteFileSystem.getDirectoryTree(true)
			})
		}
	})

	it("directory-heavy tree (sequential folder-decrypt path)", async () => {
		resetIdentity()

		const scene = genWideScene(10_000, 2)
		const world = await worldFor(scene)

		const first = await world.sync.remoteFileSystem.getDirectoryTree(true)

		expect(first.result.size).toBe(scene.length)

		await bench({
			group: "remoteFileSystem.getDirectoryTree / directory-heavy",
			name: `50k dirs x2 files (${scene.length} nodes)`,
			n: scene.length,
			iterations: 4,
			setup: () => {
				forceRemoteRebuild(world)

				return world
			},
			run: w => w.sync.remoteFileSystem.getDirectoryTree(true)
		})
	})

	it("balanced tree", async () => {
		resetIdentity()

		const scene = genBalancedScene({ fanout: 4, depth: 5, filesPerDir: 8 })
		const world = await worldFor(scene)

		const first = await world.sync.remoteFileSystem.getDirectoryTree(true)

		expect(first.result.size).toBe(scene.length)

		await bench({
			group: "remoteFileSystem.getDirectoryTree / balanced",
			name: `fanout4 depth5 (${scene.length} nodes)`,
			n: scene.length,
			iterations: 4,
			setup: () => {
				forceRemoteRebuild(world)

				return world
			},
			run: w => w.sync.remoteFileSystem.getDirectoryTree(true)
		})
	})
})
