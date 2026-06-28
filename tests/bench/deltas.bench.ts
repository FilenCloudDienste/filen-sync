import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import { makeDeltas } from "./harness/fake-sync"
import {
	genWideScene,
	buildLocalTree,
	buildRemoteTree,
	addFiles,
	deleteFiles,
	modifyFiles,
	renameTopDir,
	resetIdentity,
	type Scene
} from "./harness/trees"
import { type SyncMode } from "../../src/types"
import { type LocalTree } from "../../src/lib/filesystems/local"
import { type RemoteTree } from "../../src/lib/filesystems/remote"

/**
 * Delta-engine benchmarks — the CPU hot path. `deltas.process` runs every cycle that has changes and is
 * O(N) over the tree with ~20 passes. We measure it as pure in-memory CPU (synthetic trees, fake Sync),
 * across the change scenarios the real suite exercises (add / delete / modify / rename / mixed / no-op)
 * and across all 5 sync modes. Trees are prebuilt once per scenario (process() never mutates its inputs)
 * so only the algorithm is timed.
 */

const FILES_PER_DIR = 100

function sceneOf(nodes: number): Scene {
	resetIdentity()

	return genWideScene(Math.max(1, Math.round(nodes / (FILES_PER_DIR + 1))), FILES_PER_DIR)
}

type Trees = {
	prevLocal: LocalTree
	prevRemote: RemoteTree
	curLocal: LocalTree
	curRemote: RemoteTree
}

async function runProcess(mode: SyncMode, t: Trees): Promise<number> {
	const deltas = makeDeltas(mode)
	const result = await deltas.process({
		currentLocalTree: t.curLocal,
		currentRemoteTree: t.curRemote,
		previousLocalTree: t.prevLocal,
		previousRemoteTree: t.prevRemote,
		currentLocalTreeErrors: [],
		currentLocalTreeIgnored: []
	})

	return result.deltas.length
}

describe("deltas.process — CPU hot path", () => {
	it("size sweep: bulk local add (twoWay) — the common incremental case", async () => {
		for (const nodes of [10_000, 50_000, 200_000, 500_000]) {
			const base = sceneOf(nodes)
			const prevLocal = buildLocalTree(base)
			const prevRemote = buildRemoteTree(base)
			const addCount = Math.max(1, Math.round(nodes * 0.01))
			const curLocal = buildLocalTree(addFiles(base, addCount))
			const t: Trees = { prevLocal, prevRemote, curLocal, curRemote: prevRemote }

			// Correctness sanity: exactly `addCount` uploadFile deltas (plus nothing else).
			const count = await runProcess("twoWay", t)

			expect(count).toBe(addCount)

			await bench({
				group: "deltas.process / size sweep (twoWay add 1%)",
				name: `add ${addCount} into ${nodes} nodes`,
				n: nodes,
				iterations: nodes >= 200_000 ? 3 : 6,
				setup: () => t,
				run: tr => runProcess("twoWay", tr),
				extra: () => ({ deltas: addCount })
			})
		}
	})

	it("scenario matrix at 200k nodes (twoWay)", async () => {
		const nodes = 200_000
		const base = sceneOf(nodes)
		const prevLocal = buildLocalTree(base)
		const prevRemote = buildRemoteTree(base)
		const k = 2_000

		const scenarios: { name: string; build: () => Trees }[] = [
			{
				name: "no-op (huge tree, 0 deltas)",
				build: () => ({ prevLocal, prevRemote, curLocal: prevLocal, curRemote: prevRemote })
			},
			{
				name: "local add 1%",
				build: () => ({ prevLocal, prevRemote, curLocal: buildLocalTree(addFiles(base, k)), curRemote: prevRemote })
			},
			{
				name: "local delete 1%",
				build: () => ({ prevLocal, prevRemote, curLocal: buildLocalTree(deleteFiles(base, k)), curRemote: prevRemote })
			},
			{
				name: "local modify 1%",
				build: () => ({ prevLocal, prevRemote, curLocal: buildLocalTree(modifyFiles(base, k, "local")), curRemote: prevRemote })
			},
			{
				name: "remote modify 1%",
				build: () => ({ prevLocal, prevRemote, curLocal: prevLocal, curRemote: buildRemoteTree(modifyFiles(base, k, "remote")) })
			},
			{
				name: "rename top dir (subtree collapse)",
				build: () => ({ prevLocal, prevRemote, curLocal: buildLocalTree(renameTopDir(base, "/dir-0", "/dir-renamed")), curRemote: prevRemote })
			}
		]

		for (const scenario of scenarios) {
			const t = scenario.build()

			await bench({
				group: "deltas.process / scenario matrix @200k (twoWay)",
				name: scenario.name,
				n: nodes,
				iterations: 4,
				setup: () => t,
				run: tr => runProcess("twoWay", tr)
			})
		}
	})

	it("all 5 modes: local add 1% @100k", async () => {
		const nodes = 100_000
		const base = sceneOf(nodes)
		const prevLocal = buildLocalTree(base)
		const prevRemote = buildRemoteTree(base)
		const curLocal = buildLocalTree(addFiles(base, 1_000))
		const t: Trees = { prevLocal, prevRemote, curLocal, curRemote: prevRemote }
		const modes: SyncMode[] = ["twoWay", "localToCloud", "localBackup", "cloudToLocal", "cloudBackup"]

		for (const mode of modes) {
			await bench({
				group: "deltas.process / all modes (local add 1% @100k)",
				name: mode,
				n: nodes,
				iterations: 5,
				setup: () => t,
				run: tr => runProcess(mode, tr)
			})
		}
	})
})
