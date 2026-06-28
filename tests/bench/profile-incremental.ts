/**
 * Phase profiler for ONE incremental cycle (1 file changed in a large synced tree) — tells us exactly
 * where the per-edit cost goes before we optimize. Not a *.bench.ts, so the bench suite ignores it.
 *
 *   NODE_OPTIONS='--expose-gc' tsx tests/bench/profile-incremental.ts [nodes]
 */
import { makeScaleWorld, sceneToVfsSpec, forceLocalRescan } from "./harness/scale-world"
import { genWideScene, resetIdentity } from "./harness/trees"
import { SYNC_INTERVAL } from "../../src/constants"
import { LOCAL_ROOT } from "../harness/world"

const nodes = Number(process.argv[2] ?? 20_000)

function wrap<T extends object, K extends keyof T>(obj: T, key: K, label: string, acc: Record<string, number>): void {
	const original = obj[key] as unknown as (...args: unknown[]) => unknown

	obj[key] = (async (...args: unknown[]) => {
		const t0 = performance.now()
		const result = await original.apply(obj, args)

		acc[label] = (acc[label] ?? 0) + (performance.now() - t0)

		return result
	}) as unknown as T[K]
}

async function main(): Promise<void> {
	resetIdentity()

	const scene = genWideScene(Math.max(1, Math.round(nodes / 101)), 100)
	const world = await makeScaleWorld({ mode: "twoWay", initialLocal: sceneToVfsSpec(scene) })

	// Settle the initial sync.
	for (let i = 0; i < 3; i++) {
		world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL - 1_000

		await world.sync.runCycle()

		world.messages.length = 0
	}

	const acc: Record<string, number> = {}

	wrap(world.sync.ignorer, "initialize", "ignorer.initialize", acc)
	wrap(world.sync.localFileSystem, "getDirectoryTree", "local.getDirectoryTree", acc)
	wrap(world.sync.remoteFileSystem, "getDirectoryTree", "remote.getDirectoryTree", acc)
	wrap(world.sync.deltas, "process", "deltas.process", acc)
	wrap(world.sync.tasks, "process", "tasks.process", acc)
	wrap(world.sync.state, "save", "state.save", acc)
	wrap(world.sync.lock, "acquire", "lock.acquire", acc)
	wrap(world.sync.lock, "release", "lock.release", acc)

	// One measured incremental cycle: change a single file, force a rescan, run.
	await world.vfs.fs.writeFile(`${LOCAL_ROOT}/dir-0/file-0.txt`, "y".repeat(99), { encoding: "utf-8" })

	forceLocalRescan(world)

	world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL - 1_000

	const t0 = performance.now()

	await world.sync.runCycle()

	const total = performance.now() - t0

	process.stdout.write(`\nIncremental cycle profile — ${scene.length} nodes, 1 file changed:\n`)

	const sorted = Object.entries(acc).sort((a, b) => b[1] - a[1])
	let accounted = 0

	for (const [label, ms] of sorted) {
		accounted += ms
		process.stdout.write(`  ${label.padEnd(26)} ${ms.toFixed(1).padStart(8)} ms  (${((ms / total) * 100).toFixed(1)}%)\n`)
	}

	process.stdout.write(`  ${"[unaccounted/other]".padEnd(26)} ${(total - accounted).toFixed(1).padStart(8)} ms\n`)
	process.stdout.write(`  ${"TOTAL".padEnd(26)} ${total.toFixed(1).padStart(8)} ms\n`)

	if (world.sync.cleanupLocalTrashInterval) {
		clearInterval(world.sync.cleanupLocalTrashInterval)
	}
}

main().then(
	() => process.exit(0),
	e => {
		console.error(e)
		process.exit(1)
	}
)
