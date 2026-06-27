import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			// Excluded from the gate: the real-I/O DI seams the suite intentionally bypasses
			// (environment wiring, the enabled-logger path that writes to the user filesystem) and the
			// declaration-only modules. The engine logic itself is gated below.
			exclude: ["src/lib/environment.ts", "src/lib/logger.ts", "src/constants.ts", "src/types.ts"],
			reporter: ["text", "html", "lcov"],
			thresholds: {
				statements: 90,
				branches: 85,
				functions: 90,
				lines: 90
			}
		}
	}
})
