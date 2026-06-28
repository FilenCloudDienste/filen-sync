import { describe, it, expect } from "vitest"
import { recordCustom } from "./harness/measure"
import { makeScaleWorld, sceneToVfsSpec, forceLocalRescan } from "./harness/scale-world"
import { genWideScene, resetIdentity } from "./harness/trees"
import { SYNC_INTERVAL } from "../../src/constants"
import { LOCAL_ROOT, type World } from "../harness/world"

/**
 * Long-running benchmark — simulates many "fake hours" of a desktop sync (hundreds of cycles, a small
 * change each cycle) and watches for two failure modes a long-lived process must not have:
 *   1. memory leak — heapUsed trending up cycle over cycle (accumulating signals, caches, hashes…).
 *   2. perf degradation — later cycles getting slower than earlier ones (growing structures, GC churn).
 * Reports the heap slope (KB/cycle) and the late-vs-early cycle-time ratio.
 */

function ageDebounce(world: World): void {
	world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL - 1_000
}

function gc(): void {
	globalThis.gc?.()
}

/** Least-squares slope of y over x (MB per cycle here). */
function slope(xs: number[], ys: number[]): number {
	const n = xs.length
	const meanX = xs.reduce((a, b) => a + b, 0) / n
	const meanY = ys.reduce((a, b) => a + b, 0) / n
	let num = 0
	let den = 0

	for (let i = 0; i < n; i++) {
		num += (xs[i]! - meanX) * (ys[i]! - meanY)
		den += (xs[i]! - meanX) ** 2
	}

	return den === 0 ? 0 : num / den
}

describe("long-running sync (leak + degradation)", () => {
	it("hundreds of incremental cycles stay flat in memory and time", async () => {
		const CYCLES = 300
		const SAMPLE_EVERY = 25

		resetIdentity()

		const scene = genWideScene(50, 100) // ~5,050 nodes
		const world = await makeScaleWorld({ mode: "twoWay", initialLocal: sceneToVfsSpec(scene) })

		// Settle the initial sync.
		for (let i = 0; i < 3; i++) {
			ageDebounce(world)

			await world.sync.runCycle()

			world.messages.length = 0
		}

		const targetPath = `${LOCAL_ROOT}/dir-0/file-0.txt`
		const cycleTimes: number[] = []
		const sampleCycles: number[] = []
		const sampleHeapMB: number[] = []

		for (let c = 0; c < CYCLES; c++) {
			await world.vfs.fs.writeFile(targetPath, "y".repeat(64 + (c % 500)), { encoding: "utf-8" })

			forceLocalRescan(world)
			ageDebounce(world)

			const t0 = performance.now()

			await world.sync.runCycle()

			cycleTimes.push(performance.now() - t0)

			// Clear the harness message log so we measure ENGINE memory, not the test's growing array.
			world.messages.length = 0

			if (c % SAMPLE_EVERY === 0) {
				gc()

				sampleCycles.push(c)
				sampleHeapMB.push(process.memoryUsage().heapUsed / (1024 * 1024))
			}
		}

		gc()

		sampleCycles.push(CYCLES)
		sampleHeapMB.push(process.memoryUsage().heapUsed / (1024 * 1024))

		const heapSlopeMBPerCycle = slope(sampleCycles, sampleHeapMB)
		const heapSlopeKBPerCycle = heapSlopeMBPerCycle * 1024

		const half = Math.floor(cycleTimes.length / 2)
		const earlyAvg = cycleTimes.slice(0, half).reduce((a, b) => a + b, 0) / half
		const lateAvg = cycleTimes.slice(half).reduce((a, b) => a + b, 0) / (cycleTimes.length - half)
		const degradationRatio = lateAvg / earlyAvg

		recordCustom({
			group: "long-run / leak + degradation",
			name: `${CYCLES} incremental cycles, ${scene.length} nodes`,
			n: CYCLES,
			msMean: cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length,
			msMin: Math.min(...cycleTimes),
			heapRetainedMB: sampleHeapMB[sampleHeapMB.length - 1]!,
			extra: {
				heapStartMB: Number(sampleHeapMB[0]!.toFixed(1)),
				heapEndMB: Number(sampleHeapMB[sampleHeapMB.length - 1]!.toFixed(1)),
				heapSlopeKBPerCycle: Number(heapSlopeKBPerCycle.toFixed(2)),
				earlyCycleMs: Number(earlyAvg.toFixed(2)),
				lateCycleMs: Number(lateAvg.toFixed(2)),
				degradationRatio: Number(degradationRatio.toFixed(3))
			}
		})

		process.stdout.write(
			`[longrun] heap ${sampleHeapMB[0]!.toFixed(1)}→${sampleHeapMB[sampleHeapMB.length - 1]!.toFixed(
				1
			)}MB (slope ${heapSlopeKBPerCycle.toFixed(2)} KB/cycle) | cycle early ${earlyAvg.toFixed(2)}ms late ${lateAvg.toFixed(
				2
			)}ms (x${degradationRatio.toFixed(3)})\n`
		)

		// Leak guard: a flat engine should not trend up more than a few KB/cycle (well under a MB over 300).
		expect(heapSlopeKBPerCycle).toBeLessThan(200)
		// Degradation guard: late cycles within 2x of early ones (generous — absorbs gc noise).
		expect(degradationRatio).toBeLessThan(2)
	})
})
