import { describe, it, expect } from "vitest"
import crypto from "crypto"
import { runScenario, runCycle, localMutate, remoteMutate, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { writeLocalAt, rmLocal, renameLocal } from "../harness/mutations"

/**
 * Category LP — a STRUCTURAL property fuzz at scale with an EXACT content oracle.
 *
 * Category L is deliberately flat (6 files, no directories, no renames) so its only oracle is the
 * convergence/idempotence meta-invariant. That cannot catch a SYMMETRIC "both sides converge to the WRONG
 * state" structural bug (the BUG-A/B / ZW family). This fuzz instead models a rich, DEEP, WIDE tree and
 * drives randomized structural histories — nested adds, modifies, deletes, file renames/moves, and whole
 * DIRECTORY renames/deletes — while maintaining an authoritative in-memory model. Each round is either a
 * single side acting, or BOTH sides acting on DISJOINT top-level subtrees (concurrent structural
 * propagation with no genuine conflict), so the model stays unambiguous. At the end the converged worlds
 * must EXACTLY equal the model (every path, type, and file content), proving no silent loss/dup/resurrection
 * at scale. Seeded → any failure reproduces from its seed. twoWay.
 */

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = Math.imul(state ^ (state >>> 15), 1 | state)

		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function sha512Hex(data: string): string {
	return crypto.createHash("sha512").update(Uint8Array.from(Buffer.from(data, "utf-8"))).digest("hex")
}

type Side = "local" | "remote"

/** Counts type-change ops actually GENERATED across all seeds, so the fuzz can't silently stop exercising
 * the (historically buggiest) file↔dir type-change path if thresholds/tree-shapes drift. */
let typeChangeOpsGenerated = 0

/**
 * Build a randomized structural history from a seed. Maintains `model` (relpath → content for files),
 * emitting the matching real-world mutation for each modeled change. Top-level subtrees are `t0..t<TOPS-1>`
 * so a concurrent round can split the namespace cleanly. Returns the step list + the final model.
 */
function buildStructuralHistory(seed: number): { steps: Step[]; model: Map<string, string> } {
	const random = mulberry32(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
	const steps: Step[] = []
	const model = new Map<string, string>()
	const TOPS = 4
	let clock = BASE_TIME + 5000
	let nameCounter = 0

	const nextName = (): string => `it${nameCounter++}`

	// Apply a batch of structural ops to ONE side, mutating the model in lockstep. `roots` limits which
	// top-level subtrees this batch may touch (for disjoint concurrency).
	const batchFor = (side: Side, roots: string[], opCount: number): ((world: import("../harness/world").World) => void) => {
		// Decide the ops up front (against the model snapshot) so the closure just replays them. Track which
		// paths/dirs this batch touched so we never touch a path twice in one batch.
		const ops: Array<{ kind: string; a: string; b?: string; content?: string; mtime?: number }> = []
		const touchedPrefixes: string[] = []
		const live = (): string[] => [...model.keys()].filter(path => roots.some(root => path === root || path.startsWith(`${root}/`)))
		const conflicts = (path: string): boolean =>
			touchedPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`))
		const dirsOf = (): string[] => {
			const set = new Set<string>()

			for (const path of live()) {
				const parts = path.split("/")

				for (let i = 1; i < parts.length; i++) {
					set.add(parts.slice(0, i).join("/"))
				}
			}

			return [...set]
		}

		for (let o = 0; o < opCount; o++) {
			const liveFiles = live()
			const choice = random()

			if (choice < 0.32 || liveFiles.length === 0) {
				// add a (possibly nested) file under a random allowed root
				const root = pick(roots)
				const depth = 1 + Math.floor(random() * 3)
				const segments = [root]

				for (let d = 0; d < depth; d++) {
					segments.push(nextName())
				}

				const path = segments.join("/")

				if (conflicts(path) || model.has(path)) {
					continue
				}

				clock += 1000
				const content = `add-${nextName()}-${Math.floor(random() * 1e6)}`

				model.set(path, content)
				touchedPrefixes.push(path)
				ops.push({ kind: "add", a: path, content, mtime: clock })
			} else if (choice < 0.5) {
				// modify a live file
				const path = pick(liveFiles)

				if (conflicts(path)) {
					continue
				}

				clock += 1000
				const content = `mod-${nextName()}-${Math.floor(random() * 1e6)}-tail`

				model.set(path, content)
				touchedPrefixes.push(path)
				ops.push({ kind: "modify", a: path, content, mtime: clock })
			} else if (choice < 0.66) {
				// delete a live file
				const path = pick(liveFiles)

				if (conflicts(path)) {
					continue
				}

				model.delete(path)
				touchedPrefixes.push(path)
				ops.push({ kind: "delFile", a: path })
			} else if (choice < 0.82) {
				// rename/move a live file to a new (possibly different-dir) path
				const from = pick(liveFiles)
				const root = pick(roots)
				const to = `${root}/${nextName()}.txt`

				if (conflicts(from) || conflicts(to) || model.has(to)) {
					continue
				}

				const content = model.get(from)!

				model.delete(from)
				model.set(to, content)
				touchedPrefixes.push(from)
				touchedPrefixes.push(to)
				ops.push({ kind: "renFile", a: from, b: to })
			} else if (choice < 0.84) {
				// Rename a NESTED directory (never a top-level root) to a guaranteed-FRESH sibling name under
				// its own parent — `d<counter>` can never collide with an existing `it<n>` dir/file name, so no
				// overwrite/merge is possible and the model stays exact.
				const dirs = dirsOf().filter(dir => dir.includes("/") && roots.some(root => dir.startsWith(`${root}/`)))

				if (dirs.length === 0) {
					continue
				}

				const fromDir = pick(dirs)

				if (conflicts(fromDir)) {
					continue
				}

				const parent = fromDir.slice(0, fromDir.lastIndexOf("/"))
				const toDir = `${parent}/d${nameCounter++}`

				// Collect the whole modeled subtree under fromDir/ and its rebased target (toDir is fresh).
				const moved: Array<[string, string, string]> = []

				for (const path of [...model.keys()]) {
					if (path === fromDir || path.startsWith(`${fromDir}/`)) {
						moved.push([path, `${toDir}${path.slice(fromDir.length)}`, model.get(path)!])
					}
				}

				if (moved.length === 0) {
					continue
				}

				for (const [from, target, content] of moved) {
					model.delete(from)
					model.set(target, content)
				}

				touchedPrefixes.push(fromDir)
				touchedPrefixes.push(toDir)
				ops.push({ kind: "renDir", a: fromDir, b: toDir })
			} else if (choice < 0.9) {
				// TYPE CHANGE file→dir: replace a live FILE with a DIRECTORY holding a child. The historically
				// buggiest path (AX/AS/F1). Modeled exactly: the file path leaves, a child path appears under it.
				const file = pick(liveFiles)

				if (conflicts(file)) {
					continue
				}

				clock += 1000

				const child = `${file}/${nextName()}.txt`
				const content = `f2d-${nextName()}-${Math.floor(random() * 1e6)}`

				model.delete(file)
				model.set(child, content)
				touchedPrefixes.push(file)
				ops.push({ kind: "fileToDir", a: file, b: child, content, mtime: clock })
				typeChangeOpsGenerated++
			} else if (choice < 0.96) {
				// TYPE CHANGE dir→file: replace a NESTED directory subtree with a single FILE at the dir's path
				// (exercises the type-change pass + markSubtreeAdded over a removed subtree).
				const dirs = dirsOf().filter(dir => dir.includes("/") && roots.some(root => dir.startsWith(`${root}/`)))

				if (dirs.length === 0) {
					continue
				}

				const dir = pick(dirs)

				if (conflicts(dir)) {
					continue
				}

				clock += 1000

				const content = `d2f-${nextName()}-${Math.floor(random() * 1e6)}`

				for (const path of [...model.keys()]) {
					if (path === dir || path.startsWith(`${dir}/`)) {
						model.delete(path)
					}
				}

				model.set(dir, content)
				touchedPrefixes.push(dir)
				ops.push({ kind: "dirToFile", a: dir, content, mtime: clock })
				typeChangeOpsGenerated++
			} else {
				// delete a whole directory subtree
				const dirs = dirsOf().filter(dir => roots.some(root => dir === root || dir.startsWith(`${root}/`)))

				if (dirs.length === 0) {
					continue
				}

				const dir = pick(dirs)

				if (conflicts(dir)) {
					continue
				}

				for (const path of [...model.keys()]) {
					if (path === dir || path.startsWith(`${dir}/`)) {
						model.delete(path)
					}
				}

				touchedPrefixes.push(dir)
				ops.push({ kind: "delDir", a: dir })
			}
		}

		// Replay closure: translate each op to the side's real mutation.
		return (world): void => {
			for (const op of ops) {
				if (side === "local") {
					switch (op.kind) {
						case "add":
						case "modify":
							writeLocalAt(world, op.a, op.content!, op.mtime!)

							break
						case "delFile":
						case "delDir":
							rmLocal(world, op.a)

							break
						case "renFile":
						case "renDir":
							renameLocal(world, op.a, op.b!)

							break
						case "fileToDir":
							// Remove the file, then write the child (creating the directory at the same path).
							rmLocal(world, op.a)
							writeLocalAt(world, op.b!, op.content!, op.mtime!)

							break
						case "dirToFile":
							// Remove the directory subtree, then write a file at its path.
							rmLocal(world, op.a)
							writeLocalAt(world, op.a, op.content!, op.mtime!)

							break
					}
				} else {
					switch (op.kind) {
						case "add":
							world.cloud.controls.addFile(`/${op.a}`, op.content!, { mtimeMs: op.mtime! })

							break
						case "modify":
							world.cloud.controls.updateFile(`/${op.a}`, op.content!, { mtimeMs: op.mtime! })

							break
						case "delFile":
						case "delDir":
							world.cloud.controls.trashPath(`/${op.a}`)

							break
						case "renFile":
						case "renDir":
							world.cloud.controls.movePath(`/${op.a}`, `/${op.b}`)

							break
						case "fileToDir":
							world.cloud.controls.trashPath(`/${op.a}`)
							world.cloud.controls.addFile(`/${op.b}`, op.content!, { mtimeMs: op.mtime! })

							break
						case "dirToFile":
							world.cloud.controls.trashPath(`/${op.a}`)
							world.cloud.controls.addFile(`/${op.a}`, op.content!, { mtimeMs: op.mtime! })

							break
					}
				}
			}
		}
	}

	// Seed a starting tree on local so early rounds have material (a few files across the top subtrees).
	// CRITICAL: the model must be mutated at GENERATION time (exactly as batchFor does) so the rounds'
	// live()/dirsOf() see the seed files; the closure only performs the world write at run time. (If the
	// model.set ran inside the closure it would execute AFTER all round generation, leaving the model and
	// the world built on different clocks.)
	const seedWrites: Array<{ path: string; content: string; mtime: number }> = []

	for (let t = 0; t < TOPS; t++) {
		clock += 1000

		const path = `t${t}/seed.txt`

		model.set(path, `seed-${t}`)
		seedWrites.push({ path, content: `seed-${t}`, mtime: clock })
	}

	steps.push(
		localMutate(world => {
			for (const write of seedWrites) {
				writeLocalAt(world, write.path, write.content, write.mtime)
			}
		})
	)

	steps.push(runCycle())

	const ROUNDS = 14

	for (let round = 0; round < ROUNDS; round++) {
		const concurrent = random() < 0.4

		if (concurrent) {
			// Split the top subtrees into two disjoint halves; each side acts on its own half in ONE cycle.
			const half = Math.floor(TOPS / 2)
			const localRoots: string[] = []
			const remoteRoots: string[] = []

			for (let t = 0; t < TOPS; t++) {
				;(t < half ? localRoots : remoteRoots).push(`t${t}`)
			}

			const localBatch = batchFor("local", localRoots, 1 + Math.floor(random() * 3))
			const remoteBatch = batchFor("remote", remoteRoots, 1 + Math.floor(random() * 3))

			steps.push(localMutate(localBatch))
			steps.push(remoteMutate(remoteBatch))
		} else {
			const side: Side = random() < 0.5 ? "local" : "remote"
			const allRoots = Array.from({ length: TOPS }, (_unused, t) => `t${t}`)
			const batch = batchFor(side, allRoots, 1 + Math.floor(random() * 4))

			steps.push(side === "local" ? localMutate(batch) : remoteMutate(batch))
		}

		steps.push(runCycle())
	}

	// Quiet settle.
	for (let cycle = 0; cycle < 5; cycle++) {
		steps.push(runCycle())
	}

	return { steps, model }
}

describe("Category LP — structural property fuzz with exact oracle (twoWay)", () => {
	const ITERATIONS = 30

	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const seed = 0xc0ffee + iteration * 0x9e3779b1

		it(`LP seed=${seed}: a random structural history converges to the exact modeled tree`, async () => {
			const { steps, model } = buildStructuralHistory(seed)
			const result = await runScenario({ name: `LP-${seed}`, mode: "twoWay", steps })

			// 1) Convergence — the two sides are byte-identical (content hashes + mtimes included).
			expect(result.finalLocal, `seed=${seed} did not converge`).toEqual(result.finalRemote)

			// 2) Exact oracle — the set of FILE paths and each file's content match the model exactly (no
			//    silent loss, duplication, or resurrection anywhere in the tree).
			const actualFiles = Object.entries(result.finalLocal)
				.filter(([, entry]) => entry.type === "file")
				.map(([path]) => path)
				.sort()
			const expectedFiles = [...model.keys()].map(path => `/${path}`).sort()

			expect(actualFiles, `seed=${seed} file-path set mismatch`).toEqual(expectedFiles)

			for (const [relPath, content] of model) {
				const entry = result.finalLocal[`/${relPath}`]

				expect(entry, `seed=${seed} missing ${relPath}`).toBeDefined()
				expect(entry!.contentHash, `seed=${seed} content mismatch at ${relPath}`).toBe(sha512Hex(content))
			}

			// 3) Idempotence — the settled trailing cycle did no work.
			const lastCycle = result.cycles[result.cycles.length - 1]!

			expect(allOps(lastCycle.messages), `seed=${seed} not idempotent`).toEqual([])
		})
	}

	// Guard: the seeds above must actually have exercised the (historically buggiest) file↔dir type-change
	// path — otherwise the oracle could pass vacuously on that dimension. Runs after the seed cases.
	it("LP: the corpus actually exercised file↔dir type changes", () => {
		expect(typeChangeOpsGenerated, "no type-change ops were generated across the corpus").toBeGreaterThan(20)
	})
})
