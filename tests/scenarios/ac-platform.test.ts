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
 *              COM1-9/LPT1-9, with or without an extension), and paths over the 32767-WCHAR long-path
 *              ceiling (NOT the legacy 260/512 — Node/libuv handles long paths via the `\\?\` prefix).
 *   - darwin → forbids `:` and NUL; paths over 1024 chars.
 *   - linux  → forbids only NUL; paths over 4096 chars.
 *   - freebsd → forbids only NUL, same as linux; paths over 4096 chars (generic-platform fallback).
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

// A ~563-char absolute path: over the OLD (buggy) 512 win32 cap, but comfortably under macOS 1024 and Linux
// 4096 — and now under the corrected win32 32767 ceiling too. Every NAME stays under the 255-char limit, so
// only `pathLength` (never `nameLength`) is at play.
const LONG_DIR = "d".repeat(200)
const LONG_SUB = "s".repeat(200)
const LONG_LEAF = `${"f".repeat(150)}.txt`
const LONG_PATH = `/${LONG_DIR}/${LONG_SUB}/${LONG_LEAF}`

// A path whose absolute form genuinely exceeds the 32767-WCHAR win32 long-path ceiling — the only length a
// win32 client truly cannot represent. Built from 255-char segments (each within the NAME limit) so only
// `pathLength` fires. 140 × (255 + 1) ≈ 35840 chars.
const WIN32_TOO_LONG = `/${Array.from({ length: 140 }, () => "x".repeat(255)).join("/")}/leaf.txt`

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

	it("AC2b: freebsd also syncs the colon file down — same rule as linux (regression: freebsd used to fall into the default `invalidPath` branch and reject every path)", async () => {
		const result = await withPlatform("freebsd", () =>
			runScenario({
				name: "AC2b",
				mode: "twoWay",
				initialRemote: {
					"/report:v2.txt": "legal on freebsd",
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

	it("AC8: win32 SYNCS a ~563-char path (regression: not dropped at the old 512 cap) but skips one over 32767", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AC8",
				mode: "cloudToLocal",
				initialRemote: {
					[LONG_PATH]: "fine on modern windows",
					[WIN32_TOO_LONG]: "genuinely unrepresentable",
					"/short.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		// The ~563-char path now downloads (Node handles long paths via `\\?\`); the old 512 cap silently
		// dropped it — the "how deep can it sync / files missing" regression.
		expect(result.finalLocal[LONG_PATH]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/short.txt"]).toMatchObject({ type: "file" })
		// A path over the true 32767 ceiling is still skipped (pathLength) — a graceful skip, not a crash.
		expect(result.finalLocal[WIN32_TOO_LONG]).toBeUndefined()
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

	// A name that fits in 255 UTF-16 code units but exceeds 255 UTF-8 BYTES — legal on macOS/Windows
	// (which count code units) but over Linux's byte-based NAME_MAX. "あ" is 1 code unit / 3 bytes, so
	// 100 of them is 100 units (under 255) yet 300 bytes (over 255).
	const MULTIBYTE_NAME = "あ".repeat(100)
	const MULTIBYTE_PATH = `/${MULTIBYTE_NAME}.txt`

	it("AC11: linux skips a remote name that exceeds 255 BYTES (nameLength) instead of failing forever", async () => {
		const result = await withPlatform("linux", () =>
			runScenario({
				name: "AC11",
				mode: "cloudToLocal",
				initialRemote: {
					[MULTIBYTE_PATH]: "too many bytes for linux",
					"/short.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		// The over-long name is skipped (not materialized locally), the valid sibling syncs, and the remote
		// copy is untouched — a graceful skip, not a per-cycle ENAMETOOLONG retry loop.
		expect(result.finalLocal[MULTIBYTE_PATH]).toBeUndefined()
		expect(result.finalLocal["/short.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote[MULTIBYTE_PATH]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("nameLength")
	})

	it("AC12: darwin SYNCS the same name down — it is 100 UTF-16 units, under the 255-unit macOS limit", async () => {
		const result = await withPlatform("darwin", () =>
			runScenario({
				name: "AC12",
				mode: "cloudToLocal",
				initialRemote: {
					[MULTIBYTE_PATH]: "fine on macOS",
					"/short.txt": "fine"
				},
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal[MULTIBYTE_PATH]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/short.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).not.toContain("nameLength")
	})
})
