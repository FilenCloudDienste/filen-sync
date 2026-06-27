import { describe, it, expect } from "vitest"
import { runScenario, runCycle, restart } from "../harness/runner"
import { messagesOfType, hadTransfers } from "../harness/snapshot"
import { type SyncMessage } from "../../src/types"

/**
 * Category AC — cross-platform / per-OS path rules (behavioral spec §platform). A production sync
 * engine runs on Windows, macOS and Linux against ONE shared backend, so a name that is perfectly
 * legal where it was created can be illegal on the machine syncing it down. The engine guards this in
 * BOTH filesystem walks via `isValidPath` / `isPathOverMaxLength` / `isNameOverMaxLength` (utils.ts),
 * each of which reads `process.platform` at call time. The rule:
 *
 *   - win32  → forbids `< > : " | ? *`, control chars, the reserved device names (CON/PRN/AUX/NUL/
 *              COM1-9/LPT1-9, with or without an extension), and paths over 512 chars.
 *   - darwin → forbids `:` and NUL; paths over 1024 chars.
 *   - linux  → forbids only NUL; paths over 4096 chars.
 *
 * A path the local platform can't represent must be SKIPPED (reason `invalidPath` / `pathLength` /
 * `nameLength`) — never downloaded, never crashing the cycle, and (crucially) never deleted from the
 * side that legitimately holds it. The opposite OS, where the name is legal, must sync it normally.
 *
 * These tests force `process.platform` so every branch runs deterministically on ANY host — darwin
 * locally, and all three runners in CI. The host's real platform is irrelevant to the assertions.
 */

/** Run an entire scenario with `process.platform` forced to `platform`, restoring it afterwards. */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process, "platform")!

	Object.defineProperty(process, "platform", { value: platform, configurable: true })

	try {
		return await fn()
	} finally {
		Object.defineProperty(process, "platform", original)
	}
}

/** Every structural-ignore reason reported across the whole message stream (local + remote walks). */
function ignoredReasons(messages: SyncMessage[]): string[] {
	const local = messagesOfType(messages, "localTreeIgnored").flatMap(message => message.data.ignored.map(entry => entry.reason))
	const remote = messagesOfType(messages, "remoteTreeIgnored").flatMap(message => message.data.ignored.map(entry => entry.reason))

	return [...local, ...remote]
}

// A path long enough that its absolute local form (prefixed with "/local") exceeds Windows' 512-char
// limit, but every individual NAME stays under the uniform 255-char name limit (so only `pathLength`,
// not `nameLength`, is exercised). 6 + 1 + 200 + 1 + 200 + 1 + 154 = 563 chars absolute.
const LONG_DIR = "d".repeat(200)
const LONG_SUB = "s".repeat(200)
const LONG_LEAF = `${"f".repeat(150)}.txt`
const LONG_PATH = `/${LONG_DIR}/${LONG_SUB}/${LONG_LEAF}`

describe("Category AC — cross-platform path rules", () => {
	it("AC1: win32 skips a remote file with a colon (invalidPath), syncs valid siblings, never deletes it", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AC1",
				mode: "twoWay",
				initialRemote: {
					"/report:v2.txt": "colon is illegal on windows",
					"/ok.txt": "fine everywhere"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		// The colon file is skipped on the way down…
		expect(result.finalLocal["/report:v2.txt"]).toBeUndefined()
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
		// …the valid sibling converges on both sides…
		expect(result.finalLocal["/ok.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/ok.txt"]).toMatchObject({ type: "file" })
		// …and the skipped remote file is NOT deleted (ignore ≠ delete; it just can't land on win32).
		expect(result.finalRemote["/report:v2.txt"]).toMatchObject({ type: "file" })
	})

	it("AC2: linux DOES sync the colon file down — a colon is a legal filename on linux", async () => {
		const result = await withPlatform("linux", () =>
			runScenario({
				name: "AC2",
				mode: "twoWay",
				initialRemote: {
					"/report:v2.txt": "legal on linux",
					"/ok.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal["/report:v2.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/ok.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).not.toContain("invalidPath")
	})

	it("AC3: darwin also skips the colon file — `:` is illegal on macOS too (unlike linux)", async () => {
		const result = await withPlatform("darwin", () =>
			runScenario({
				name: "AC3",
				mode: "twoWay",
				initialRemote: {
					"/a:b.txt": "illegal on macOS",
					"/ok.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal["/a:b.txt"]).toBeUndefined()
		expect(result.finalLocal["/ok.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/a:b.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
	})

	it("AC4: win32 skips remote files using reserved device names (CON, com1.txt, nul); a normal file syncs", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AC4",
				mode: "cloudToLocal",
				initialRemote: {
					"/CON": "reserved",
					"/com1.txt": "reserved even with an extension",
					"/nul": "reserved",
					"/normal.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal["/CON"]).toBeUndefined()
		expect(result.finalLocal["/com1.txt"]).toBeUndefined()
		expect(result.finalLocal["/nul"]).toBeUndefined()
		expect(result.finalLocal["/normal.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
	})

	it("AC5: linux treats reserved device names as ordinary filenames and syncs them", async () => {
		const result = await withPlatform("linux", () =>
			runScenario({
				name: "AC5",
				mode: "cloudToLocal",
				initialRemote: {
					"/CON": "just a name on linux",
					"/com1.txt": "fine",
					"/nul": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal["/CON"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/com1.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/nul"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).not.toContain("invalidPath")
	})

	it("AC6: win32 skips each illegal metacharacter (< > | ? * \") while a clean file syncs", async () => {
		const illegal: Record<string, string> = {
			"/lt<name.txt": "x",
			"/gt>name.txt": "x",
			"/pipe|name.txt": "x",
			"/q?name.txt": "x",
			"/star*name.txt": "x",
			"/quote\"name.txt": "x"
		}

		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AC6",
				mode: "twoWay",
				initialRemote: { ...illegal, "/clean.txt": "ok" },
				steps: [runCycle(), runCycle()]
			})
		)

		for (const path of Object.keys(illegal)) {
			// Skipped locally (can't be represented on win32)…
			expect(result.finalLocal[path]).toBeUndefined()
			// …but never deleted from the remote.
			expect(result.finalRemote[path]).toMatchObject({ type: "file" })
		}

		expect(result.finalLocal["/clean.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
	})

	it("AC7: win32 skips uploading a LOCAL file whose name is illegal on the platform (outbound guard)", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AC7",
				mode: "twoWay",
				initialLocal: {
					"/local/bad:name.txt": "colon illegal on win32",
					"/local/good.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		// The illegal-named local file is never uploaded…
		expect(result.finalRemote["/bad:name.txt"]).toBeUndefined()
		// …but it stays on local disk (ignore ≠ delete) and the valid file uploads.
		expect(result.finalLocal["/bad:name.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/good.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
	})

	it("AC8: win32 skips a remote path over its 512-char limit (pathLength); a short sibling syncs", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AC8",
				mode: "cloudToLocal",
				initialRemote: {
					[LONG_PATH]: "too long for windows",
					"/short.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal[LONG_PATH]).toBeUndefined()
		expect(result.finalLocal["/short.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("pathLength")
	})

	it("AC9: linux syncs the same long path — its 4096-char limit permits it", async () => {
		const result = await withPlatform("linux", () =>
			runScenario({
				name: "AC9",
				mode: "cloudToLocal",
				initialRemote: {
					[LONG_PATH]: "fine on linux",
					"/short.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal[LONG_PATH]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/short.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).not.toContain("pathLength")
	})

	it("AC10: win32 converges a mixed tree (valid synced, illegal skipped) and stays stable across a restart", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AC10",
				mode: "twoWay",
				initialRemote: {
					"/docs/readme.txt": "valid",
					"/docs/a:b.txt": "illegal colon",
					"/CON": "reserved",
					"/photos/pic.txt": "valid"
				},
				steps: [runCycle(), runCycle(), restart(), runCycle()]
			})
		)

		// Valid files synced down…
		expect(result.finalLocal["/docs/readme.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/photos/pic.txt"]).toMatchObject({ type: "file" })
		// …illegal ones skipped locally but intact on the remote.
		expect(result.finalLocal["/docs/a:b.txt"]).toBeUndefined()
		expect(result.finalLocal["/CON"]).toBeUndefined()
		expect(result.finalRemote["/docs/a:b.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/CON"]).toMatchObject({ type: "file" })

		// The post-restart cycle does NO transfers — the skipped files never cause repeated churn, and
		// the valid files are already reconciled, so a long-lived win32 sync stays quiet.
		const lastCycle = result.cycles[result.cycles.length - 1]!

		expect(hadTransfers(lastCycle.messages)).toBe(false)
	})
})
