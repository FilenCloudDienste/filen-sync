import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { writeLocalAt, rmLocal, renameLocal } from "../harness/mutations"

/**
 * Category LX — OVERLAPPING structural-conflict fuzz at scale (twoWay meta-invariants).
 *
 * Category L is flat + well-behaved (one op per path per round, no dirs, no renames) and Category LP keeps
 * the two sides DISJOINT so it can assert an exact oracle. Neither drives GENUINE structural conflicts at
 * scale: both sides restructuring the SAME deep/wide subtrees in the same cycle — rename-vs-rename,
 * rename-vs-delete, modify-vs-dir-rename, add-vs-add — which is the messy real-world two-device case and
 * the hardest path for the rename detector + rebase + conflict resolver. An exact final state is undecidable
 * here (keep-both, newer-wins), so the assertion is the §2 meta-invariants only: the worlds CONVERGE and a
 * settled trailing run is idempotent. Every write gets a UNIQUE strictly-growing mtime AND a unique size, so
 * a non-convergence is a real ordering/resolution bug, never the documented same-second/same-size blind spot.
 * Seeded → deterministic repro.
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

type Side = "local" | "remote"

/**
 * Track a per-side view of which paths exist (so a side only deletes/renames something it has). The two
 * views diverge as conflicts resolve; that is fine — the views only gate op GENERATION, not the assertion.
 */
function buildConflictHistory(seed: number): Step[] {
	const random = mulberry32(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
	const steps: Step[] = []
	const TOPS = 3
	const localFiles = new Set<string>()
	const remoteFiles = new Set<string>()
	let clock = BASE_TIME + 5000
	let sizePad = 3
	let nameCounter = 0

	const nextName = (): string => `n${nameCounter++}`
	// Unique strictly-growing content: unique size (sizePad grows) AND unique mtime (clock grows).
	const freshContent = (tag: string): string => {
		sizePad += 1

		return `${tag}-${nextName()}-${"x".repeat(sizePad)}`
	}

	const dirsOf = (files: Set<string>): string[] => {
		const set = new Set<string>()

		for (const path of files) {
			const parts = path.split("/")

			for (let i = 1; i < parts.length; i++) {
				set.add(parts.slice(0, i).join("/"))
			}
		}

		return [...set]
	}

	// Generate ONE side's batch (ops decided now against that side's view; closure replays to the world).
	const batchFor = (side: Side, opCount: number): ((world: import("../harness/world").World) => void) => {
		const files = side === "local" ? localFiles : remoteFiles
		const ops: Array<{ kind: string; a: string; b?: string; content?: string; mtime?: number }> = []
		const touched: string[] = []
		const conflicts = (path: string): boolean =>
			touched.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`))

		for (let o = 0; o < opCount; o++) {
			const liveFiles = [...files]
			const choice = random()

			if (choice < 0.34 || liveFiles.length === 0) {
				const root = `t${Math.floor(random() * TOPS)}`
				const depth = 1 + Math.floor(random() * 2)
				const segments = [root]

				for (let d = 0; d < depth; d++) {
					segments.push(nextName())
				}

				const path = segments.join("/")

				if (conflicts(path)) {
					continue
				}

				clock += 1000

				const content = freshContent("add")

				files.add(path)
				touched.push(path)
				ops.push({ kind: "write", a: path, content, mtime: clock })
			} else if (choice < 0.55) {
				const path = pick(liveFiles)

				if (conflicts(path)) {
					continue
				}

				clock += 1000

				const content = freshContent("mod")

				touched.push(path)
				ops.push({ kind: "write", a: path, content, mtime: clock })
			} else if (choice < 0.7) {
				const path = pick(liveFiles)

				if (conflicts(path)) {
					continue
				}

				files.delete(path)
				touched.push(path)
				ops.push({ kind: "delFile", a: path })
			} else if (choice < 0.86) {
				const from = pick(liveFiles)
				const root = `t${Math.floor(random() * TOPS)}`
				const to = `${root}/${nextName()}.txt`

				if (conflicts(from) || conflicts(to)) {
					continue
				}

				files.delete(from)
				files.add(to)
				touched.push(from)
				touched.push(to)
				ops.push({ kind: "renFile", a: from, b: to })
			} else {
				const dirs = dirsOf(files).filter(dir => dir.includes("/"))

				if (dirs.length === 0) {
					continue
				}

				const fromDir = pick(dirs)

				if (conflicts(fromDir)) {
					continue
				}

				const parent = fromDir.slice(0, fromDir.lastIndexOf("/"))
				const toDir = `${parent}/d${nameCounter++}`

				for (const path of [...files]) {
					if (path === fromDir || path.startsWith(`${fromDir}/`)) {
						files.delete(path)
						files.add(`${toDir}${path.slice(fromDir.length)}`)
					}
				}

				touched.push(fromDir)
				touched.push(toDir)
				ops.push({ kind: "renDir", a: fromDir, b: toDir })
			}
		}

		// Each op is a best-effort ATTEMPT against the real, engine-mutated state — in an overlapping-conflict
		// history the disk/cloud diverge from any tracked view as conflicts resolve, so an op whose source has
		// since moved/changed type simply does not apply. Swallowing the per-op error keeps the fuzz driving
		// genuine churn; engine correctness is judged solely by the convergence + idempotence assertions.
		return (world): void => {
			for (const op of ops) {
				try {
					if (side === "local") {
						if (op.kind === "write") {
							writeLocalAt(world, op.a, op.content!, op.mtime!)
						} else if (op.kind === "delFile") {
							rmLocal(world, op.a)
						} else {
							renameLocal(world, op.a, op.b!)
						}
					} else {
						if (op.kind === "write") {
							if (world.cloud.controls.getByPath(`/${op.a}`)) {
								world.cloud.controls.updateFile(`/${op.a}`, op.content!, { mtimeMs: op.mtime! })
							} else {
								world.cloud.controls.addFile(`/${op.a}`, op.content!, { mtimeMs: op.mtime! })
							}
						} else if (op.kind === "delFile") {
							world.cloud.controls.trashPath(`/${op.a}`)
						} else {
							world.cloud.controls.movePath(`/${op.a}`, `/${op.b}`)
						}
					}
				} catch {
					// Op no longer applicable against the current state — skip it.
				}
			}
		}
	}

	// Seed a shared base tree on local, sync it so BOTH sides share the same starting identity.
	const seedWrites: Array<{ path: string; content: string; mtime: number }> = []

	for (let t = 0; t < TOPS; t++) {
		for (let f = 0; f < 3; f++) {
			clock += 1000

			const path = `t${t}/base-${f}.txt`
			const content = freshContent("seed")

			localFiles.add(path)
			remoteFiles.add(path)
			seedWrites.push({ path, content, mtime: clock })
		}
	}

	steps.push(localMutate(world => seedWrites.forEach(write => writeLocalAt(world, write.path, write.content, write.mtime))))
	steps.push(runCycle())

	const ROUNDS = 12

	for (let round = 0; round < ROUNDS; round++) {
		// BOTH sides act every round on the SAME namespace → genuine cross-side conflicts.
		steps.push(localMutate(batchFor("local", 1 + Math.floor(random() * 3))))
		steps.push(remoteMutate(batchFor("remote", 1 + Math.floor(random() * 3))))
		steps.push(runCycle())
	}

	// Generous settle — structural conflicts can take a few cycles to reach the fixed point.
	for (let cycle = 0; cycle < 8; cycle++) {
		steps.push(runCycle())
	}

	return steps
}

describe("Category LX — overlapping structural-conflict fuzz (twoWay convergence)", () => {
	const ITERATIONS = 30

	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const seed = 0x5ca1e + iteration * 0x9e3779b1

		it(`LX seed=${seed}: overlapping cross-side structural conflicts converge + settle`, async () => {
			const steps = buildConflictHistory(seed)
			const result = await runScenario({ name: `LX-${seed}`, mode: "twoWay", steps })

			// Convergence — both sides byte-identical after the storm (content hashes + mtimes).
			expect(result.finalLocal, `seed=${seed} did not converge`).toEqual(result.finalRemote)

			// Idempotence — the settled trailing cycle did no work (no oscillation / churn loop).
			const lastCycle = result.cycles[result.cycles.length - 1]!

			expect(allOps(lastCycle.messages), `seed=${seed} not idempotent`).toEqual([])

			// Sanity — the history was NOT vacuous: real ops ran across the cycles and a non-trivial tree
			// survived, so convergence above is a meaningful result rather than "both sides ended empty".
			const totalOps = result.cycles.reduce((sum, cycle) => sum + allOps(cycle.messages).length, 0)

			expect(totalOps, `seed=${seed} did no work`).toBeGreaterThan(5)
			expect(Object.keys(result.finalLocal).length, `seed=${seed} ended empty`).toBeGreaterThan(0)
		})
	}
})
