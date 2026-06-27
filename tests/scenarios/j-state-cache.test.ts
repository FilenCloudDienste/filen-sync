import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart, control, localMutate } from "../harness/runner"
import { transferOps, countMessages, snapshotLocal, snapshotRemote } from "../harness/snapshot"
import { rmLocal } from "../harness/mutations"

/**
 * Category J — state persistence / cache (behavioral spec §J, §9).
 *
 * These pin the durability layer that lets the engine stay quiet across restarts and remote-tree
 * cache hits:
 *
 * - The persisted state lives under `state/v2/<uuid>/` as five line-delimited-JSON files
 *   (`previousLocalTree`, `previousLocalINodes`, `previousRemoteTree`, `previousRemoteUUIDs`,
 *   `localFileHashes`); `restart()` rebuilds the engine over the same vfs+cloud so that state is
 *   reloaded from disk (see {@link restartSync}).
 * - The `deviceId/v1/<uuid>` file drives the SDK `dir().tree()` cache: once a deviceId has fetched at
 *   a given revision, the next fetch returns an EMPTY `{files:[],folders:[]}` "unchanged" response,
 *   which {@link RemoteFileSystem.getDirectoryTree} treats as "data did not change, use cache" — NOT
 *   as "the remote was emptied".
 * - `worker.resetCache(uuid)` drops both in-memory tree caches (and the deviceId-cache timestamp) so
 *   the next cycle performs a fresh full re-scan.
 * - `localFileHashes` is pruned during the local tree scan: any stored path absent from the freshly
 *   scanned tree is dropped.
 * - Corrupt/partial state files degrade to an empty previous state (the line reader swallows
 *   unparseable lines) rather than throwing, so the engine re-converges instead of crashing.
 */
describe("Category J — state persistence / cache", () => {
	it("J1: persisted previous-trees + hashes round-trip through a restart → next cycle is a no-op", async () => {
		let preLocalTree: Record<string, unknown> = {}
		let preRemoteTree: Record<string, unknown> = {}
		let preHashes: Record<string, string> = {}
		let postLocalTree: Record<string, unknown> = {}
		let postRemoteTree: Record<string, unknown> = {}
		let postHashes: Record<string, string> = {}

		const result = await runScenario({
			name: "J1",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "alpha", "/local/dir/b.txt": "beta" },
			steps: [
				runCycle(),
				runCycle(),
				runCycle(),
				// Capture the in-memory persisted state of the converged engine just before the restart.
				control(world => {
					preLocalTree = structuredClone(world.sync.previousLocalTree.tree)
					preRemoteTree = structuredClone(world.sync.previousRemoteTree.tree)
					preHashes = structuredClone(world.sync.localFileHashes)
				}),
				restart(),
				// After the restart the NEW engine has loaded its previous state straight from disk.
				control(world => {
					postLocalTree = structuredClone(world.sync.previousLocalTree.tree)
					postRemoteTree = structuredClone(world.sync.previousRemoteTree.tree)
					postHashes = structuredClone(world.sync.localFileHashes)
				}),
				runCycle(),
				runCycle()
			]
		})

		// The reloaded state is non-empty and exactly equals what was persisted (a faithful round-trip).
		expect(Object.keys(postLocalTree).length).toBeGreaterThan(0)
		expect(postLocalTree).toEqual(preLocalTree)
		expect(postRemoteTree).toEqual(preRemoteTree)
		expect(postHashes).toEqual(preHashes)
		expect(postLocalTree).toHaveProperty("/a.txt")
		expect(postRemoteTree).toHaveProperty("/dir/b.txt")
		expect(postHashes).toHaveProperty("/a.txt")

		// The two cycles after the restart (indices 3 and 4) transfer nothing: state proves convergence.
		expect(transferOps(result.cycles[3]!.messages)).toEqual([])
		expect(transferOps(result.cycles[4]!.messages)).toEqual([])
		expect(countMessages(result.messages, "cycleError")).toBe(0)
		expect(countMessages(result.messages, "cycleNoChanges")).toBeGreaterThanOrEqual(1)

		// The worlds remain converged and intact across the restart (no data loss).
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: 5 })
		expect(result.finalLocal["/dir/b.txt"]).toMatchObject({ type: "file", size: 4 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("J2: an empty deviceId cache-hit tree is read as 'unchanged', not 'remote emptied'", async () => {
		let revisionBefore = -1
		let revisionAfter = -1

		const result = await runScenario({
			name: "J2",
			mode: "twoWay",
			initialLocal: { "/local/one.txt": "one", "/local/sub/two.txt": "two" },
			steps: [
				runCycle(),
				runCycle(),
				runCycle(),
				// Record the cloud's mutation counter just before a steady-state cycle...
				control(world => {
					revisionBefore = world.cloud.controls.revision()
				}),
				runCycle(),
				// ...and again right after it.
				control(world => {
					revisionAfter = world.cloud.controls.revision()
				})
			]
		})

		// The steady-state cycle drove the remote tree fetch into its cache-hit (empty-tree) path. The
		// engine used its cache: no cloud mutation happened (the revision counter is stable) and the
		// cycle performed no file transfers.
		expect(revisionBefore).toBeGreaterThanOrEqual(0)
		expect(revisionAfter).toBe(revisionBefore)
		expect(transferOps(result.cycles[3]!.messages)).toEqual([])
		expect(countMessages(result.messages, "cycleNoChanges")).toBeGreaterThanOrEqual(1)

		// Crucially: the empty cache-hit response did NOT delete everything locally — all files survive
		// on both sides and the worlds stay converged.
		expect(result.finalLocal["/one.txt"]).toMatchObject({ type: "file", size: 3 })
		expect(result.finalLocal["/sub/two.txt"]).toMatchObject({ type: "file", size: 3 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("J3: resetCache drops the tree caches and forces a fresh full re-scan that still converges", async () => {
		let timestampAfterReset = -1
		let treeKeysAfterReset: string[] = []
		let timestampAfterRescan = -1
		let treeKeysAfterRescan: string[] = []
		let convergedRemote: Record<string, unknown> = {}

		const result = await runScenario({
			name: "J3",
			mode: "twoWay",
			initialLocal: { "/local/keep.txt": "keep-me", "/local/nested/deep.txt": "deep-content" },
			steps: [
				runCycle(),
				runCycle(),
				runCycle(),
				// Force a full cache reset on the converged engine, then observe the now-empty remote cache.
				control(world => {
					convergedRemote = snapshotRemote(world)

					world.worker.resetCache(world.syncPair.uuid)

					timestampAfterReset = world.sync.remoteFileSystem.getDirectoryTreeCache.timestamp
					treeKeysAfterReset = Object.keys(world.sync.remoteFileSystem.getDirectoryTreeCache.tree)
				}),
				runCycle(),
				// The cycle had to re-fetch the full remote tree (cache timestamp was 0, forcing a
				// skipCache fetch) — the cache is repopulated with every node.
				control(world => {
					timestampAfterRescan = world.sync.remoteFileSystem.getDirectoryTreeCache.timestamp
					treeKeysAfterRescan = Object.keys(world.sync.remoteFileSystem.getDirectoryTreeCache.tree)
				})
			]
		})

		// resetCache cleared the remote tree cache outright.
		expect(timestampAfterReset).toBe(0)
		expect(treeKeysAfterReset).toEqual([])

		// The next cycle did a fresh full re-scan: a new timestamp and the full tree are back.
		expect(timestampAfterRescan).toBeGreaterThan(0)
		expect(treeKeysAfterRescan).toContain("/keep.txt")
		expect(treeKeysAfterRescan).toContain("/nested/deep.txt")

		// A forced re-scan must not corrupt or lose data: no transfers, no deletions, same converged state.
		expect(transferOps(result.cycles[3]!.messages)).toEqual([])
		expect(countMessages(result.messages, "cycleError")).toBe(0)
		expect(snapshotRemote(result.world)).toEqual(convergedRemote)
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file", size: 7 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("J4: a deleted local path's stored hash is pruned while a surviving path's hash is kept", async () => {
		let hashesBeforeDelete: Record<string, string> = {}

		const result = await runScenario({
			name: "J4",
			mode: "twoWay",
			initialLocal: { "/local/gone.txt": "to-be-deleted", "/local/stays.txt": "survivor" },
			steps: [
				runCycle(),
				runCycle(),
				// Both uploaded files have a stored md5 hash at this point.
				control(world => {
					hashesBeforeDelete = structuredClone(world.sync.localFileHashes)
				}),
				localMutate(world => rmLocal(world, "gone.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Pre-delete: both paths had a stored hash.
		expect(hashesBeforeDelete["/gone.txt"]).toEqual(expect.any(String))
		expect(hashesBeforeDelete["/stays.txt"]).toEqual(expect.any(String))

		// Post-delete cycle: the local scan pruned the now-missing path's hash and kept the survivor's
		// (still equal to the value it held before the deletion).
		expect(result.world.sync.localFileHashes["/gone.txt"]).toBeUndefined()
		expect(result.world.sync.localFileHashes["/stays.txt"]).toBe(hashesBeforeDelete["/stays.txt"])

		// The deletion itself propagated correctly and the surviving file is intact.
		expect(result.finalLocal["/gone.txt"]).toBeUndefined()
		expect(result.finalRemote["/gone.txt"]).toBeUndefined()
		expect(result.finalLocal["/stays.txt"]).toMatchObject({ type: "file", size: "survivor".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("J5: corrupt/partial state files degrade to an empty previous state and the engine re-converges", async () => {
		let postRestartLocalKeys = -1
		let postRestartRemoteKeys = -1

		const result = await runScenario({
			name: "J5",
			mode: "twoWay",
			initialLocal: { "/local/safe.txt": "safe-content", "/local/dir/child.txt": "child-content" },
			steps: [
				runCycle(),
				runCycle(),
				runCycle(),
				// Overwrite the persisted tree records with unparseable garbage (the dir/files still exist,
				// so the loader proceeds to read them rather than short-circuiting to "no saved state").
				control(world => {
					const state = world.sync.state
					const garbage = " not-json\n}{ broken line\n<<< corrupt >>>\n"

					for (const filePath of [
						state.previousLocalTreePath,
						state.previousLocalINodesPath,
						state.previousRemoteTreePath,
						state.previousRemoteUUIDsPath,
						state.localFileHashesPath
					]) {
						world.vfs.ifs.writeFileSync(filePath, garbage)
					}
				}),
				restart(),
				// The corrupt lines were swallowed: the reloaded previous trees are empty (treated as a
				// fresh, blank previous state) and the restart did not throw.
				control(world => {
					postRestartLocalKeys = Object.keys(world.sync.previousLocalTree.tree).length
					postRestartRemoteKeys = Object.keys(world.sync.previousRemoteTree.tree).length
				}),
				runCycle(),
				runCycle()
			]
		})

		// The corruption was recovered as "empty previous state", not loaded as real data.
		expect(postRestartLocalKeys).toBe(0)
		expect(postRestartRemoteKeys).toBe(0)

		// No crash, and because both sides already hold identical content the re-diff needs no transfers.
		expect(countMessages(result.messages, "cycleError")).toBe(0)
		expect(transferOps(result.cycles[3]!.messages)).toEqual([])
		expect(transferOps(result.cycles[4]!.messages)).toEqual([])

		// All originally-synced data survives intact on both sides and the worlds stay converged.
		expect(snapshotLocal(result.world)["/safe.txt"]).toMatchObject({ type: "file", size: "safe-content".length })
		expect(result.finalLocal["/safe.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/dir/child.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
