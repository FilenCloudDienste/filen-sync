import { describe, it, expect } from "vitest"
import crypto from "crypto"
import { runScenario, runCycle, localMutate, remoteMutate, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { writeLocalAt, rmLocal, renameLocal } from "../harness/mutations"

/**
 * Category LM — directional STRICT-MIRROR fuzz at scale with an EXACT oracle.
 *
 * The mirror modes (localToCloud / cloudToLocal) have their OWN code paths — directional push/pull forcing
 * the authoritative side to win (F5), revert-foreign-edit (F6), and noBaseSizeDiverged (F9) — and the
 * existing U/V/W/X tests pin them only at trivial scale. A mirror is exactly oracle-able: the engine NEVER
 * writes the authoritative side, so the converged tree MUST equal the authoritative side's own history,
 * however much FOREIGN churn the other side throws at it (every foreign add/edit/delete/rename is reverted
 * or overwritten). This drives a rich structural history on the authoritative side (modeled exactly) while
 * bombarding the non-authoritative side with random structural noise, then asserts both sides equal the
 * model. Seeded → deterministic. Catches a mirror-revert that fails to fire at scale (silent foreign-state
 * leakage) — which convergence-only fuzzing cannot see.
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

function sha512Hex(data: string): string {
	return crypto.createHash("sha512").update(Uint8Array.from(Buffer.from(data, "utf-8"))).digest("hex")
}

type Mode = "localToCloud" | "cloudToLocal"

function buildMirrorHistory(seed: number, mode: Mode): { steps: Step[]; model: Map<string, string> } {
	const random = mulberry32(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
	const steps: Step[] = []
	const model = new Map<string, string>() // the AUTHORITATIVE side's exact tree
	const TOPS = 3
	let clock = BASE_TIME + 5000
	let sizePad = 4
	let nameCounter = 0
	const authoritative: "local" | "remote" = mode === "localToCloud" ? "local" : "remote"

	const nextName = (): string => `m${nameCounter++}`
	const freshContent = (tag: string): string => {
		sizePad += 1

		return `${tag}-${nextName()}-${"y".repeat(sizePad)}`
	}
	const dirsOf = (): string[] => {
		const set = new Set<string>()

		for (const path of model.keys()) {
			const parts = path.split("/")

			for (let i = 1; i < parts.length; i++) {
				set.add(parts.slice(0, i).join("/"))
			}
		}

		return [...set]
	}

	// Apply a structural batch to the AUTHORITATIVE side, modeled exactly (the engine never overwrites this
	// side in a mirror, so the model is precise and these mutations never fail).
	const authBatch = (opCount: number): ((world: import("../harness/world").World) => void) => {
		const ops: Array<{ kind: string; a: string; b?: string; content?: string; mtime?: number }> = []
		const touched: string[] = []
		const conflicts = (path: string): boolean =>
			touched.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`))

		for (let o = 0; o < opCount; o++) {
			const liveFiles = [...model.keys()]
			const choice = random()

			if (choice < 0.36 || liveFiles.length === 0) {
				const segments = [`t${Math.floor(random() * TOPS)}`]
				const depth = 1 + Math.floor(random() * 2)

				for (let d = 0; d < depth; d++) {
					segments.push(nextName())
				}

				const path = segments.join("/")

				if (conflicts(path) || model.has(path)) {
					continue
				}

				clock += 1000

				const content = freshContent("add")

				model.set(path, content)
				touched.push(path)
				ops.push({ kind: "write", a: path, content, mtime: clock })
			} else if (choice < 0.56) {
				const path = pick(liveFiles)

				if (conflicts(path)) {
					continue
				}

				clock += 1000

				const content = freshContent("mod")

				model.set(path, content)
				touched.push(path)
				ops.push({ kind: "write", a: path, content, mtime: clock })
			} else if (choice < 0.72) {
				const path = pick(liveFiles)

				if (conflicts(path)) {
					continue
				}

				model.delete(path)
				touched.push(path)
				ops.push({ kind: "delFile", a: path })
			} else if (choice < 0.88) {
				const from = pick(liveFiles)
				const to = `t${Math.floor(random() * TOPS)}/${nextName()}.txt`

				if (conflicts(from) || conflicts(to) || model.has(to)) {
					continue
				}

				const content = model.get(from)!

				model.delete(from)
				model.set(to, content)
				touched.push(from)
				touched.push(to)
				ops.push({ kind: "renFile", a: from, b: to })
			} else {
				const dirs = dirsOf().filter(dir => dir.includes("/"))

				if (dirs.length === 0) {
					continue
				}

				const fromDir = pick(dirs)

				if (conflicts(fromDir)) {
					continue
				}

				const parent = fromDir.slice(0, fromDir.lastIndexOf("/"))
				const toDir = `${parent}/d${nameCounter++}`

				for (const path of [...model.keys()]) {
					if (path === fromDir || path.startsWith(`${fromDir}/`)) {
						const content = model.get(path)!

						model.delete(path)
						model.set(`${toDir}${path.slice(fromDir.length)}`, content)
					}
				}

				touched.push(fromDir)
				touched.push(toDir)
				ops.push({ kind: "renDir", a: fromDir, b: toDir })
			}
		}

		return (world): void => {
			for (const op of ops) {
				if (authoritative === "local") {
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
			}
		}
	}

	// Bombard the NON-authoritative side with random structural noise (best-effort; all reverted/overwritten
	// by the mirror). Not modeled — the oracle is the authoritative model, period.
	const foreignNoise = (opCount: number): ((world: import("../harness/world").World) => void) => {
		const foreign: "local" | "remote" = authoritative === "local" ? "remote" : "local"

		return (world): void => {
			for (let o = 0; o < opCount; o++) {
				const path = `t${Math.floor(random() * TOPS)}/foreign-${nameCounter++}.txt`
				const existing = [...model.keys()]
				const target = existing.length > 0 && random() < 0.5 ? pick(existing) : path
				const kind = random()

				try {
					if (foreign === "remote") {
						if (kind < 0.5) {
							if (world.cloud.controls.getByPath(`/${target}`)) {
								world.cloud.controls.updateFile(`/${target}`, `FOREIGN-${nameCounter++}-zzz`, { mtimeMs: clock + 1_000_000 })
							} else {
								world.cloud.controls.addFile(`/${target}`, `FOREIGN-${nameCounter++}-zzz`, { mtimeMs: clock + 1_000_000 })
							}
						} else if (kind < 0.75) {
							world.cloud.controls.trashPath(`/${target}`)
						} else {
							world.cloud.controls.movePath(`/${target}`, `/t${Math.floor(random() * TOPS)}/foreign-moved-${nameCounter++}.txt`)
						}
					} else {
						if (kind < 0.5) {
							writeLocalAt(world, target, `FOREIGN-${nameCounter++}-zzz`, clock + 1_000_000)
						} else if (kind < 0.75) {
							rmLocal(world, target)
						} else {
							renameLocal(world, target, `t${Math.floor(random() * TOPS)}/foreign-moved-${nameCounter++}.txt`)
						}
					}
				} catch {
					// Best effort — foreign op no longer applicable.
				}
			}
		}
	}

	const pushAuth = (fn: (world: import("../harness/world").World) => void): void => {
		steps.push(authoritative === "local" ? localMutate(fn) : remoteMutate(fn))
	}
	const pushForeign = (fn: (world: import("../harness/world").World) => void): void => {
		steps.push(authoritative === "local" ? remoteMutate(fn) : localMutate(fn))
	}

	// Seed the authoritative side and sync so the foreign side has material to corrupt.
	const seedWrites: Array<{ path: string; content: string; mtime: number }> = []

	for (let t = 0; t < TOPS; t++) {
		for (let f = 0; f < 2; f++) {
			clock += 1000

			const path = `t${t}/seed-${f}.txt`
			const content = freshContent("seed")

			model.set(path, content)
			seedWrites.push({ path, content, mtime: clock })
		}
	}

	pushAuth(world => {
		for (const write of seedWrites) {
			if (authoritative === "local") {
				writeLocalAt(world, write.path, write.content, write.mtime)
			} else {
				world.cloud.controls.addFile(`/${write.path}`, write.content, { mtimeMs: write.mtime })
			}
		}
	})
	steps.push(runCycle())

	const ROUNDS = 12

	for (let round = 0; round < ROUNDS; round++) {
		pushAuth(authBatch(1 + Math.floor(random() * 3)))
		pushForeign(foreignNoise(1 + Math.floor(random() * 3)))
		steps.push(runCycle())
	}

	for (let cycle = 0; cycle < 6; cycle++) {
		steps.push(runCycle())
	}

	return { steps, model }
}

describe("Category LM — strict-mirror fuzz with exact oracle", () => {
	const ITERATIONS = 16

	for (const mode of ["localToCloud", "cloudToLocal"] as const) {
		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			const seed = 0xababa + iteration * 0x9e3779b1

			it(`LM ${mode} seed=${seed}: foreign churn is fully reverted; both sides equal the authoritative tree`, async () => {
				const { steps, model } = buildMirrorHistory(seed, mode)
				const result = await runScenario({ name: `LM-${mode}-${seed}`, mode, steps })

				// Convergence + exact oracle: both sides equal the authoritative side's modeled tree.
				expect(result.finalLocal, `${mode} seed=${seed} did not converge`).toEqual(result.finalRemote)

				const actualFiles = Object.entries(result.finalLocal)
					.filter(([, entry]) => entry.type === "file")
					.map(([path]) => path)
					.sort()
				const expectedFiles = [...model.keys()].map(path => `/${path}`).sort()

				expect(actualFiles, `${mode} seed=${seed} file-set mismatch (foreign leak?)`).toEqual(expectedFiles)

				for (const [relPath, content] of model) {
					const entry = result.finalLocal[`/${relPath}`]

					expect(entry, `${mode} seed=${seed} missing ${relPath}`).toBeDefined()
					expect(entry!.contentHash, `${mode} seed=${seed} content mismatch at ${relPath}`).toBe(sha512Hex(content))
				}

				// Idempotence — the settled trailing cycle did no work.
				expect(allOps(result.cycles[result.cycles.length - 1]!.messages), `${mode} seed=${seed} not idempotent`).toEqual([])
			})
		}
	}
})
