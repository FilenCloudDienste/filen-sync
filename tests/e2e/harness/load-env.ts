/**
 * Side-effect module: load the gitignored `.env.e2e` (KEY=VALUE lines) at the repo root into process.env
 * WITHOUT overriding anything already set, so a standalone script (e.g. cleanup.ts run via tsx) gets the
 * same credentials the vitest e2e config loads. Import this BEFORE any module that reads the credentials
 * at load time — account.ts computes E2E_ENABLED on import. In CI the real secrets are already in
 * process.env, so this is a no-op there.
 */
import fs from "fs"
import pathModule from "path"

const file = pathModule.join(__dirname, "..", "..", "..", ".env.e2e")

if (fs.existsSync(file)) {
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
