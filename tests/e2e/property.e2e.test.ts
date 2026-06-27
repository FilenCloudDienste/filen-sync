import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { cycle, settle, expectConverged, transferOps } from "./harness/drive"
import { writeLocal, rmLocal, uploadRemote, deleteRemote } from "./harness/mutations"

/**
 * Phase 3 e2e — property/fuzz convergence against the live backend. The live counterpart of mocked
 * Category L: a seeded PRNG builds a random history of one-sided add/modify/delete mutations over
 * several rounds (settling between rounds), then asserts the §2 meta-invariants on the REAL backend —
 * convergence (both sides end identical, content hashes included) and idempotence (a settled cycle does
 * no transfers). Seeded, so any failure reproduces deterministically.
 *
 * "Well-behaved" like Category L, and ENFORCED (not just asserted): each path is touched at most once
 * per round (no same-cycle same-path ambiguity), rounds are separated by a real settle, and — crucially —
 * every write carries a UNIQUE SIZE (a strictly-growing payload, see `nextContent`). The engine detects
 * changes by (whole-second mtime, size), never by re-hashing content every cycle (that per-cycle cost is
 * the exact thing the perf/memory budget forbids), so two same-size edits that land in the same whole
 * second are — by design — indistinguishable to it (the documented §C11 blind spot; an accepted tradeoff,
 * not a bug, and avoided by construction in the mocked Category L too). Unique sizes keep the fuzz off
 * that blind spot: the size delta always reveals the edit, so a divergence here is a REAL convergence bug.
 * Renames are covered exhaustively by conflict.e2e/edge.e2e, so the fuzz stays on add/modify/delete.
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

const FILE_POOL = ["p0.txt", "p1.txt", "p2.txt", "p3.txt"]
const ROUNDS = 4
const MAX_PER_ROUND = 2
const SEEDS = [0xc0ffee, 0x5eed01]

describe.skipIf(!E2E_ENABLED)("E2E — property/fuzz (live convergence)", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 300_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	for (const seed of SEEDS) {
		it(`fuzz seed=${seed}: a random history converges and is idempotent on the real backend`, async () => {
			await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
				const random = mulberry32(seed)
				const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
				const exists = new Set<string>()
				let mutationCount = 0

				// Every write gets a strictly-growing payload, so no two writes (to the same path or any
				// other) ever share a size. That keeps the engine's (whole-second mtime, size) change-detector
				// able to see every edit even when a fast settle ties the mtimes — steering the fuzz clear of
				// the documented same-size/same-second blind spot (§C11) so any divergence is a real bug.
				let writeSeq = 0
				const nextContent = (): string => `s${seed}-w${writeSeq}-${"x".repeat(writeSeq++)}`

				// Seed a file so early deletes/modifies have something to act on, and converge once.
				await writeLocal(world, "p0.txt", nextContent())
				exists.add("p0.txt")
				await settle(world)

				for (let round = 0; round < ROUNDS; round++) {
					const touched = new Set<string>()
					const mutations = 1 + Math.floor(random() * MAX_PER_ROUND)

					for (let m = 0; m < mutations; m++) {
						const path = pick(FILE_POOL)

						if (touched.has(path)) {
							continue
						}

						touched.add(path)

						const side = random() < 0.5 ? "local" : "remote"
						const doDelete = exists.has(path) && random() < 0.35

						if (doDelete) {
							exists.delete(path)

							if (side === "local") {
								await rmLocal(world, path)
							} else {
								await deleteRemote(world, path)
							}
						} else {
							exists.add(path)

							const content = nextContent()

							if (side === "local") {
								await writeLocal(world, path, content)
							} else {
								await uploadRemote(world, path, content)
							}
						}

						mutationCount++
					}

					// Settle between rounds so each round starts from a converged state and the next round's
					// writes carry a strictly-newer real mtime than anything before them.
					await settle(world)
				}

				// Convergence (§2.3): the two sides are byte-for-byte identical.
				await settle(world)
				await expectConverged(world)

				// Idempotence (§2.2): a further settled cycle performs no file transfers.
				const messages = await cycle(world)

				expect(transferOps(messages), `seed=${seed} was not idempotent`).toEqual([])
				// Sanity: the history actually exercised the engine.
				expect(mutationCount).toBeGreaterThan(0)
			})
		})
	}
})
