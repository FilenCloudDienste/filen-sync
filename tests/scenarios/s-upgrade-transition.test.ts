import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart, localMutate, control, type Step } from "../harness/runner"
import { DB_ROOT } from "../harness/world"
import { transferKinds, messagesOfType } from "../harness/snapshot"
import pathModule from "path"

/**
 * Category S — upgrade transition (the backwards-compat safety net).
 *
 * The desktop client bundles this sync engine. When a user updates the client they keep the on-disk
 * state the PREVIOUS engine wrote (`state/v2/<uuid>/…` trees, the `deviceId`, the local file hashes).
 * The guarantee: the first cycle after the upgrade over an unchanged sync is a no-op — no re-sync the
 * user notices, no spurious deletion, no data loss.
 *
 * `restart()` reloads that persisted v2 state over the SAME virtual fs + cloud (so inodes and uuids are
 * preserved), faithfully simulating "a sync was settled, then a new engine boots on its state". These
 * cases assert the Phase 2 behavior changes (empty-file handling, symlink skip, deletion gating, the
 * msgpack tree fetch) do not disturb a tree that was already settled. The state FORMAT itself is pinned
 * by S5 so a future serialization change that would silently break old state fails loudly here.
 */
function settle(): Step[] {
	return [runCycle(), runCycle()]
}

const statePath = (uuid: string): string => pathModule.join(DB_ROOT, "state", "v2", uuid)
const deviceIdPath = (uuid: string): string => pathModule.join(DB_ROOT, "deviceId", "v1", uuid)

describe("Category S — upgrade transition (backwards compat)", () => {
	it("S1: a settled two-way sync does ZERO work on the first cycle after an upgrade/restart", async () => {
		const result = await runScenario({
			name: "S1",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": "alpha",
				"/local/dir/b.txt": "bravo",
				"/local/dir/sub/c.txt": "charlie"
			},
			steps: [...settle(), restart(), runCycle()]
		})

		const settled = result.cycles[1]!
		const afterUpgrade = result.cycles[2]!

		// The post-upgrade cycle moved no bytes and prompted no deletion.
		expect(transferKinds(afterUpgrade.messages)).toEqual([])
		expect(messagesOfType(afterUpgrade.messages, "confirmDeletion")).toEqual([])
		// Nothing added or removed on either side; both sides still match the settled state exactly.
		expect(afterUpgrade.local).toEqual(settled.local)
		expect(afterUpgrade.remote).toEqual(settled.remote)
		expect(afterUpgrade.local).toEqual(afterUpgrade.remote)
		// Sanity: a non-empty tree was actually synced.
		expect(Object.keys(settled.local).length).toBeGreaterThan(0)
	})

	it("S2: the deviceId is reused across a restart (server-side tree cache stays valid)", async () => {
		let before: string | null = null
		let after: string | null = null

		const result = await runScenario({
			name: "S2",
			mode: "twoWay",
			initialLocal: { "/local/keep.txt": "k" },
			steps: [
				...settle(),
				control(async world => {
					before = (await world.vfs.fs.readFile(deviceIdPath(world.syncPair.uuid), { encoding: "utf-8" })) as unknown as string
				}),
				restart(),
				control(async world => {
					after = (await world.vfs.fs.readFile(deviceIdPath(world.syncPair.uuid), { encoding: "utf-8" })) as unknown as string
				}),
				runCycle()
			]
		})

		expect(before).toBeTruthy()
		// A regenerated deviceId would invalidate the server's per-device tree cache and force a full
		// re-download storm on every client update — it must survive the restart unchanged.
		expect(after).toBe(before)
		expect(transferKinds(result.cycles[2]!.messages)).toEqual([])
	})

	it("S3: a settled sync with large-deletion confirmation enabled raises NO deletion prompt after upgrade (BUG-001)", async () => {
		// The deletion-gating fix must not misfire when a fresh engine reloads a settled tree: the
		// previous trees are non-empty and the current trees match them, so nothing looks deleted.
		const result = await runScenario({
			name: "S3",
			mode: "twoWay",
			requireConfirmationOnLargeDeletion: true,
			initialLocal: {
				"/local/x.txt": "x",
				"/local/y.txt": "y",
				"/local/z/w.txt": "w"
			},
			steps: [...settle(), restart(), runCycle()]
		})

		const afterUpgrade = result.cycles[2]!

		expect(messagesOfType(afterUpgrade.messages, "confirmDeletion")).toEqual([])
		expect(transferKinds(afterUpgrade.messages)).toEqual([])
		expect(afterUpgrade.local).toEqual(afterUpgrade.remote)
	})

	it("S4: after upgrade a newly-visible empty file uploads WITHOUT disturbing already-synced files (BUG-002)", async () => {
		// The old engine ignored 0-byte files, so they were never in its state. The new engine includes
		// them — uploading the empty file is the intended new behavior, but it must be purely additive:
		// the previously-synced file is neither re-uploaded nor deleted.
		const result = await runScenario({
			name: "S4",
			mode: "twoWay",
			initialLocal: { "/local/keep.txt": "content" },
			steps: [
				...settle(),
				restart(),
				localMutate(world => world.vfs.ifs.writeFileSync("/local/empty.txt", "")),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/empty.txt"]).toMatchObject({ type: "file", size: 0 })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("S5: persisted state is the stable v2 line-delimited {prop,data} JSON (old state stays readable)", async () => {
		let localTreeRaw = ""
		let remoteTreeRaw = ""

		await runScenario({
			name: "S5",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "alpha", "/local/d/b.txt": "bravo" },
			steps: [
				...settle(),
				control(async world => {
					const base = statePath(world.syncPair.uuid)

					localTreeRaw = (await world.vfs.fs.readFile(pathModule.join(base, "previousLocalTree"), { encoding: "utf-8" })) as unknown as string
					remoteTreeRaw = (await world.vfs.fs.readFile(pathModule.join(base, "previousRemoteTree"), { encoding: "utf-8" })) as unknown as string
				})
			]
		})

		const localLines = localTreeRaw.trim().split("\n").filter(Boolean)

		expect(localLines.length).toBeGreaterThan(0)

		for (const line of localLines) {
			const parsed = JSON.parse(line)

			expect(parsed).toHaveProperty("prop")
			expect(parsed.data).toHaveProperty("path")
			expect(parsed.data).toHaveProperty("inode")
			expect(parsed.data).toHaveProperty("type")
		}

		const remoteLines = remoteTreeRaw.trim().split("\n").filter(Boolean)

		expect(remoteLines.length).toBeGreaterThan(0)

		for (const line of remoteLines) {
			const parsed = JSON.parse(line)

			expect(parsed).toHaveProperty("prop")
			expect(parsed.data).toHaveProperty("uuid")
			expect(parsed.data).toHaveProperty("path")
		}
	})
})
