import { defineConfig } from "vitest/config"

/**
 * Benchmark config — completely separate from the deterministic mocked suite (vitest.config.ts) and the
 * live e2e suite (vitest.e2e.config.ts). Bench files are `tests/bench/**\/*.bench.ts`, which the mocked
 * suite's include (`tests/**\/*.test.ts`) does NOT match, so they never run in `npm test` / CI.
 *
 * Run with NODE_OPTIONS so the measure harness can force GC for stable retained-heap numbers and large
 * trees fit:
 *   NODE_OPTIONS='--expose-gc --max-old-space-size=120000' npx vitest run --config vitest.bench.config.ts
 * then render the report (see docs/perf/02-benchmarks.md). NODE_OPTIONS is inherited by the worker forks
 * (verified) — Vitest 4 removed per-pool execArgv config.
 *
 * - REAL timers + REAL clock (we measure wall time).
 * - Serial, no file parallelism: clean memory measurements + ordered JSONL appends.
 * - Huge timeout: million-node trees take a while to build + process.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/bench/**/*.bench.ts"],
		testTimeout: 3_600_000,
		hookTimeout: 3_600_000,
		teardownTimeout: 600_000,
		pool: "forks",
		fileParallelism: false,
		sequence: {
			concurrent: false
		}
	}
})
