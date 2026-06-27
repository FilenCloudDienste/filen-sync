import { defineConfig } from "vitest/config"

/**
 * E2E config — real @filen/sdk against a live test account. Completely separate from the deterministic
 * unit/scenario suite: a REAL clock (no fake timers), generous network timeouts, and serial execution
 * (one world at a time against the shared account). No coverage gate — these validate live behavior, not
 * lines. The suite skips itself when FILEN_TEST_EMAIL / FILEN_TEST_PASSWORD are absent.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/e2e/**/*.test.ts"],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		teardownTimeout: 120_000,
		// One retry absorbs a transient network blip without masking a persistent failure.
		retry: 1,
		// Never run e2e files concurrently — they share one account.
		fileParallelism: false,
		sequence: {
			concurrent: false
		}
	}
})
