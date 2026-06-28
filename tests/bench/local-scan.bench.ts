import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import { makeScaleWorld, sceneToVfsSpec, forceLocalRescan } from "./harness/scale-world"
import { genWideScene, genBalancedScene, resetIdentity, type Scene } from "./harness/trees"
import { type World } from "../harness/world"

/**
 * Local tree-scan benchmark (targets T5, T10). `localFileSystem.getDirectoryTree` runs whenever the local
 * side changed: fast-glob walks the whole tree (materialising an N-string array), then per entry does
 * lstat + access(R_OK) (two fs ops) and builds the LocalItem maps. memfs backs the fs so we measure the
 * walk + per-entry CPU + allocation, not real disk latency (the relative cost of fast-glob vs the loop
 * vs the double-stat is what transfers to real disk).
 */

async function buildWorld(scene: Scene): Promise<World> {
	return await makeScaleWorld({ mode: "twoWay", initialLocal: sceneToVfsSpec(scene) })
}

describe("localFileSystem.getDirectoryTree", () => {
	it("wide tree size sweep", async () => {
		for (const nodes of [10_000, 50_000, 100_000]) {
			resetIdentity()

			const scene = genWideScene(Math.max(1, Math.round(nodes / 101)), 100)
			const world = await buildWorld(scene)

			// Correctness: the scan finds exactly the scene's nodes.
			forceLocalRescan(world)

			const first = await world.sync.localFileSystem.getDirectoryTree()

			expect(first.result.size).toBe(scene.length)

			await bench({
				group: "localFileSystem.getDirectoryTree / wide",
				name: `${nodes} nodes`,
				n: scene.length,
				iterations: 4,
				setup: () => {
					forceLocalRescan(world)

					return world
				},
				run: w => w.sync.localFileSystem.getDirectoryTree()
			})
		}
	})

	it("balanced (directory-heavy) tree", async () => {
		resetIdentity()

		const scene = genBalancedScene({ fanout: 4, depth: 6, filesPerDir: 8 })
		const world = await buildWorld(scene)

		forceLocalRescan(world)

		const first = await world.sync.localFileSystem.getDirectoryTree()

		expect(first.result.size).toBe(scene.length)

		await bench({
			group: "localFileSystem.getDirectoryTree / balanced",
			name: `fanout4 depth6 (${scene.length} nodes)`,
			n: scene.length,
			iterations: 4,
			setup: () => {
				forceLocalRescan(world)

				return world
			},
			run: w => w.sync.localFileSystem.getDirectoryTree()
		})
	})
})
