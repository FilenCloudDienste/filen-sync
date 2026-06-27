import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferOps } from "../harness/snapshot"
import { writeLocalAt, rmLocal } from "../harness/mutations"

/**
 * Category AB — randomized property tests for the directional MIRROR modes (localToCloud / cloudToLocal),
 * the directional analogue of Category L (twoWay). The defining invariant of a mirror is stronger than
 * twoWay convergence: the AUTHORITATIVE side dictates the whole tree, so no matter what foreign NOISE the
 * other side injects (adds, edits, deletes), the engine must drive the two worlds back to the
 * authoritative side's exact state and stay there (idempotence). This exercises mirror-delete + F5
 * (authoritative wins) + F6 (foreign-edit revert) together under thousands of random operations.
 *
 * Histories are well-behaved on the authoritative side (strictly-increasing whole-second mtimes, one op
 * per path per round, non-empty content, case-distinct names) so a failure is a real bug. The foreign
 * noise is deliberately adversarial.
 */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = Math.imul(state ^ (state >>> 15), 1 | state)

		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const FILE_POOL = ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]
const ROUNDS = 8
const MAX_OPS_PER_ROUND = 3
const SETTLE_CYCLES = 4

/**
 * Build a directional-mirror history. `side` is the authoritative side: its mutations are the source of
 * truth, and we additionally inject foreign noise on the OTHER side that the mirror must undo. Returns
 * the step list. After settling, the two worlds must be identical.
 */
function buildMirrorHistory(seed: number, authoritative: "local" | "remote"): Step[] {
	const random = mulberry32(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
	const steps: Step[] = []
	const exists = new Set<string>()
	let clock = BASE_TIME + 1000

	const authWrite = (path: string, content: string, mtime: number): void => {
		if (authoritative === "local") {
			steps.push(localMutate(world => writeLocalAt(world, path, content, mtime)))
		} else {
			steps.push(remoteMutate(world => world.cloud.controls.addFile(`/${path}`, content, { mtimeMs: mtime })))
		}
	}
	const authUpdate = (path: string, content: string, mtime: number): void => {
		if (authoritative === "local") {
			steps.push(localMutate(world => writeLocalAt(world, path, content, mtime)))
		} else {
			steps.push(remoteMutate(world => world.cloud.controls.updateFile(`/${path}`, content, { mtimeMs: mtime })))
		}
	}
	const authDelete = (path: string): void => {
		if (authoritative === "local") {
			steps.push(localMutate(world => rmLocal(world, path)))
		} else {
			steps.push(remoteMutate(world => world.cloud.controls.trashPath(`/${path}`)))
		}
	}
	// Foreign noise lands on the NON-authoritative side; the mirror must erase its effect. `noiseClock` is
	// captured by VALUE per call — the closures must NOT close over the mutable `clock` (it advances during
	// generation, so a by-reference capture would stamp every foreign edit with the final, largest mtime and
	// collapse them all into one whole-second, the §C11 ambiguity this suite deliberately avoids).
	const foreignNoise = (round: number, noiseClock: number): void => {
		const r = random()

		if (authoritative === "local") {
			if (r < 0.4) {
				steps.push(remoteMutate(world => world.cloud.controls.addFile(`/foreign-${round}.txt`, `foreign${round}`, { mtimeMs: noiseClock })))
			} else if (r < 0.7 && exists.size > 0) {
				const target = pick([...exists])

				steps.push(remoteMutate(world => world.cloud.controls.updateFile(`/${target}`, `tampered${round}`, { mtimeMs: noiseClock })))
			} else if (exists.size > 0) {
				const target = pick([...exists])

				steps.push(remoteMutate(world => world.cloud.controls.trashPath(`/${target}`)))
			}
		} else {
			if (r < 0.4) {
				steps.push(localMutate(world => writeLocalAt(world, `foreign-${round}.txt`, `foreign${round}`, noiseClock)))
			} else if (r < 0.7 && exists.size > 0) {
				const target = pick([...exists])

				steps.push(localMutate(world => writeLocalAt(world, target, `tampered${round}`, noiseClock)))
			} else if (exists.size > 0) {
				const target = pick([...exists])

				steps.push(localMutate(world => rmLocal(world, target)))
			}
		}
	}

	// Seed one authoritative file.
	clock += 1000
	authWrite("f0.txt", "seed-0", clock)
	exists.add("f0.txt")
	steps.push(runCycle())

	for (let round = 0; round < ROUNDS; round++) {
		const touched = new Set<string>()
		const ops = 1 + Math.floor(random() * MAX_OPS_PER_ROUND)

		for (let op = 0; op < ops; op++) {
			const path = pick(FILE_POOL)

			if (touched.has(path)) {
				continue
			}

			touched.add(path)
			clock += 1000

			const content = `s${seed}-r${round}-o${op}-${Math.floor(random() * 1_000_000)}`
			const doDelete = exists.has(path) && random() < 0.3

			if (doDelete) {
				exists.delete(path)
				authDelete(path)
			} else if (exists.has(path)) {
				authUpdate(path, content, clock)
			} else {
				exists.add(path)
				authWrite(path, content, clock)
			}
		}

		// Inject adversarial foreign noise most rounds.
		if (random() < 0.7) {
			clock += 1000
			foreignNoise(round, clock)
		}

		steps.push(runCycle())
	}

	for (let cycle = 0; cycle < SETTLE_CYCLES; cycle++) {
		steps.push(runCycle())
	}

	return steps
}

describe("Category AB — directional mirror property tests", () => {
	const ITERATIONS = 16

	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const seed = 0x5151 + iteration * 0x9e37

		it(`AB-localToCloud seed=${seed}: the remote is driven to exactly mirror the authoritative local tree`, async () => {
			const steps = buildMirrorHistory(seed, "local")
			const result = await runScenario({ name: `AB-ltc-${seed}`, mode: "localToCloud", steps })

			// Mirror: the remote equals the authoritative local tree, every foreign edit undone.
			expect(result.finalRemote, `seed=${seed} remote did not mirror local`).toEqual(result.finalLocal)

			// Idempotence: the final settled cycle did no transfers.
			const lastCycle = result.cycles[result.cycles.length - 1]!

			expect(transferOps(lastCycle.messages), `seed=${seed} not idempotent`).toEqual([])
		})
	}

	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const seed = 0x7333 + iteration * 0x9e37

		it(`AB-cloudToLocal seed=${seed}: local is driven to exactly mirror the authoritative remote tree`, async () => {
			const steps = buildMirrorHistory(seed, "remote")
			const result = await runScenario({ name: `AB-ctl-${seed}`, mode: "cloudToLocal", steps })

			expect(result.finalLocal, `seed=${seed} local did not mirror remote`).toEqual(result.finalRemote)

			const lastCycle = result.cycles[result.cycles.length - 1]!

			expect(transferOps(lastCycle.messages), `seed=${seed} not idempotent`).toEqual([])
		})
	}
})
