import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import State from "../../src/lib/state"
import type Sync from "../../src/lib/sync"
import { createVirtualFS } from "../fakes/virtual-fs"
import { genWideScene, buildLocalTree, buildRemoteTree, resetIdentity } from "./harness/trees"

/**
 * State persistence benchmark (target T4). Every change-cycle persists 4 line-delimited-JSON files
 * (previousLocalTree, previousLocalINodes, previousRemoteTree, previousRemoteUUIDs) and reloads them on
 * restart. The tree and the inodes/uuids files hold the SAME item objects keyed differently, so each
 * item is serialized TWICE — this measures the real cost and the duplication T4 targets. memfs backs the
 * writes so we measure serialization + stream + parse CPU, not real disk latency.
 */

function makeState(scene: ReturnType<typeof genWideScene>): { state: State; sync: Sync } {
	const vfs = createVirtualFS({ "/db": null })
	const localTree = buildLocalTree(scene)
	const remoteTree = buildRemoteTree(scene)

	const sync = {
		dbPath: "/db",
		syncPair: { uuid: "bench-uuid" },
		environment: { fs: vfs.fs, globFs: vfs.globFs },
		localFileHashes: {},
		previousLocalTree: { tree: localTree.tree, inodes: localTree.inodes, size: localTree.size },
		previousRemoteTree: { tree: remoteTree.tree, uuids: remoteTree.uuids, size: remoteTree.size },
		isPreviousSavedTreeStateEmpty: true
	} as unknown as Sync

	return { state: new State(sync), sync }
}

function sceneOf(nodes: number): ReturnType<typeof genWideScene> {
	resetIdentity()

	return genWideScene(Math.max(1, Math.round(nodes / 101)), 100)
}

describe("state persistence", () => {
	it("savePreviousTrees (4 files, tree+inodes duplicated)", async () => {
		for (const nodes of [10_000, 100_000, 300_000]) {
			await bench({
				group: "state.savePreviousTrees",
				name: `${nodes} nodes`,
				n: nodes,
				iterations: 4,
				setup: () => makeState(sceneOf(nodes)),
				run: ({ state }) => state.savePreviousTrees()
			})
		}
	})

	it("loadPreviousTrees (round-trip read of the 4 files)", async () => {
		for (const nodes of [10_000, 100_000, 300_000]) {
			const scene = sceneOf(nodes)
			const expectedSize = scene.length

			await bench({
				group: "state.loadPreviousTrees",
				name: `${nodes} nodes`,
				n: nodes,
				iterations: 4,
				setup: async () => {
					const made = makeState(scene)

					await made.state.savePreviousTrees()

					// Reset the in-memory trees so the load actually re-reads + rebuilds from disk.
					made.sync.previousLocalTree = { tree: {}, inodes: {}, size: 0 }
					made.sync.previousRemoteTree = { tree: {}, uuids: {}, size: 0 }

					return made
				},
				run: async ({ state, sync }) => {
					await state.loadPreviousTrees()

					expect(sync.previousLocalTree.size).toBe(expectedSize)

					return sync.previousLocalTree.size
				}
			})
		}
	})
})
