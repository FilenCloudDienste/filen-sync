import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			reporter: ["text", "html", "lcov"]
			// 100% thresholds are enabled in plan Task 1.20 once the suite is comprehensive.
		}
	}
})
