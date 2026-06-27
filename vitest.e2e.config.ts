import { defineConfig } from "vitest/config"
import fs from "fs"
import pathModule from "path"

/**
 * Load credentials from a gitignored `.env.e2e` at the repo root (KEY=VALUE lines) into process.env
 * WITHOUT overriding anything already set (CI passes real GitHub secrets via env). This keeps the
 * account creds out of the repo and out of any command line during local runs.
 */
function loadDotEnvE2E(): void {
	const file = pathModule.join(__dirname, ".env.e2e")

	if (!fs.existsSync(file)) {
		return
	}

	for (const rawLine of fs.readFileSync(file, "utf-8").split("\n")) {
		const line = rawLine.trim()

		if (!line || line.startsWith("#")) {
			continue
		}

		const eq = line.indexOf("=")

		if (eq === -1) {
			continue
		}

		const key = line.slice(0, eq).trim()
		const value = line
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "")

		if (key && process.env[key] === undefined) {
			process.env[key] = value
		}
	}
}

loadDotEnvE2E()

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
		// Very generous: CI runners can be slow and real transfers + tree fetches add up. Better to wait
		// than to flake on a slow-but-healthy run.
		testTimeout: 3600_000,
		hookTimeout: 3600_000,
		teardownTimeout: 3600_000,
		// One retry absorbs a transient network blip without masking a persistent failure.
		retry: 1,
		// Never run e2e files concurrently — they share one account.
		fileParallelism: false,
		sequence: {
			concurrent: false
		}
	}
})
