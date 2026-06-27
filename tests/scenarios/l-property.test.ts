import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferOps } from "../harness/snapshot"
import { writeLocalAt, rmLocal } from "../harness/mutations"

/**
 * Category L — cross-mode property tests (behavioral spec §L, §2). Randomized but WELL-BEHAVED
 * histories of local/remote add/modify/delete operations, asserting the §2 meta-invariants:
 * convergence (the worlds end identical), idempotence (a fully settled cycle does no work), and — via
 * convergence over content hashes — no silent data loss.
 *
 * "Well-behaved" deliberately excludes the codified limitations so a failure means a REAL bug, not a
 * known gap: every write gets a strictly-increasing whole-second mtime (so latest-mtime-wins is
 * unambiguous — avoids the §C6 equal-second tie), each path is touched at most once per round (so
 * there is no same-path delete-vs-modify ambiguity within a single cycle), content is never empty
 * (BUG-002), and names are case-distinct (no §F11 collisions). Renames-under-concurrency are covered
 * structurally by Category E and the BUG-004 note, so they are not generated here. Each case is
 * seeded, so any failure reproduces deterministically from its seed.
 */

/** Deterministic PRNG (mulberry32) — same seed yields the same history. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = Math.imul(state ^ (state >>> 15), 1 | state)

		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const FILE_POOL = ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]
const ROUNDS = 8
const MAX_MUTATIONS_PER_ROUND = 3
const SETTLE_CYCLES = 4

/**
 * Build a randomized scenario from a seed: a sequence of rounds (each a few one-sided add/modify/delete
 * mutations on distinct paths, followed by a cycle), then several quiet settling cycles. Returns the
 * step list plus a count of how many mutations were emitted (for a sanity check that work happened).
 */
function buildHistory(seed: number): { steps: Step[]; mutationCount: number } {
	const random = mulberry32(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
	const steps: Step[] = []
	const exists = new Set<string>()
	let clock = BASE_TIME + 1000
	let mutationCount = 0

	// Seed the world with an initial file so deletes/modifies have something to act on early. Capture
	// the mtime as a const — closures must NOT close over the mutable `clock` (it advances during
	// generation, so a by-reference capture would stamp every write with the final, largest mtime).
	clock += 1000
	const seedMtime = clock

	steps.push(localMutate(world => writeLocalAt(world, "f0.txt", "seed-0", seedMtime)))
	exists.add("f0.txt")

	for (let round = 0; round < ROUNDS; round++) {
		const touched = new Set<string>()
		const mutations = 1 + Math.floor(random() * MAX_MUTATIONS_PER_ROUND)

		for (let m = 0; m < mutations; m++) {
			const path = pick(FILE_POOL)

			if (touched.has(path)) {
				continue
			}

			touched.add(path)

			const side = random() < 0.5 ? "local" : "remote"
			// Only delete a path that currently exists; otherwise write (add or modify).
			const doDelete = exists.has(path) && random() < 0.35

			clock += 1000
			const mtime = clock
			const content = `s${seed}-r${round}-m${m}-${Math.floor(random() * 1_000_000)}`

			if (doDelete) {
				exists.delete(path)

				if (side === "local") {
					steps.push(localMutate(world => rmLocal(world, path)))
				} else {
					steps.push(remoteMutate(world => world.cloud.controls.trashPath(`/${path}`)))
				}
			} else {
				const isAdd = !exists.has(path)

				exists.add(path)

				if (side === "local") {
					steps.push(localMutate(world => writeLocalAt(world, path, content, mtime)))
				} else if (isAdd) {
					steps.push(remoteMutate(world => world.cloud.controls.addFile(`/${path}`, content, { mtimeMs: mtime })))
				} else {
					steps.push(remoteMutate(world => world.cloud.controls.updateFile(`/${path}`, content, { mtimeMs: mtime })))
				}
			}

			mutationCount++
		}

		steps.push(runCycle())
	}

	// Quiet settling cycles: with no further changes the engine must reach a fixed point.
	for (let cycle = 0; cycle < SETTLE_CYCLES; cycle++) {
		steps.push(runCycle())
	}

	return { steps, mutationCount }
}

describe("Category L — property tests (twoWay meta-invariants)", () => {
	const ITERATIONS = 24

	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const seed = 0x1234 + iteration * 0x9e37

		it(`L-prop seed=${seed}: a random well-behaved history converges and is idempotent`, async () => {
			const { steps, mutationCount } = buildHistory(seed)

			const result = await runScenario({ name: `L-${seed}`, mode: "twoWay", steps })

			// Convergence (§2.3) — the normalized worlds are identical (content hashes included).
			expect(result.finalLocal, `seed=${seed} did not converge`).toEqual(result.finalRemote)

			// Idempotence (§2.2) — the final settled cycle performed no file transfers.
			const lastCycle = result.cycles[result.cycles.length - 1]!

			expect(transferOps(lastCycle.messages), `seed=${seed} was not idempotent`).toEqual([])

			// Sanity: the history actually exercised the engine.
			expect(mutationCount).toBeGreaterThan(0)
		})
	}
})
