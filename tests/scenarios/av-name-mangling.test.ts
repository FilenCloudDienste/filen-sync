import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { writeLocal } from "../harness/mutations"
import { messagesOfType } from "../harness/snapshot"
import { type SyncMessage } from "../../src/types"

/**
 * Category AV — Windows name-mangling (trailing dots / spaces), the M5 guard in `isValidPath`. Windows
 * silently strips a trailing "." or " " from a name, so a path ending in either would be created under a
 * DIFFERENT name than recorded — an endless re-sync / duplication loop. The engine rejects such names as
 * `invalidPath` on win32 (skipped, never deleted), while POSIX (linux/darwin) treats them as ordinary
 * legal names and syncs them. This is win32-specific behavior forced via `process.platform`, so it is a
 * mocked-only category by nature (the e2e host cannot be win32, and the real all-dots case can't round-
 * trip a non-win32 fs) — the live counterpart is the existing platform.e2e on the host's real platform.
 * Add-only; extends category AC without touching it.
 */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process, "platform")!

	Object.defineProperty(process, "platform", { value: platform, configurable: true })

	try {
		return await fn()
	} finally {
		Object.defineProperty(process, "platform", original)
	}
}

function ignoredReasons(messages: SyncMessage[]): string[] {
	const local = messagesOfType(messages, "localTreeIgnored").flatMap(message => message.data.ignored.map(entry => entry.reason))
	const remote = messagesOfType(messages, "remoteTreeIgnored").flatMap(message => message.data.ignored.map(entry => entry.reason))

	return [...local, ...remote]
}

describe("Category AV — Windows name-mangling (trailing dots/spaces)", () => {
	it("AV1: win32 skips a remote file whose name ends in a dot (invalidPath), never deletes it, syncs the sibling", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AV1",
				mode: "twoWay",
				initialRemote: { "/report.": "trailing dot mangles on windows", "/ok.txt": "fine" },
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal["/report."]).toBeUndefined()
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
		expect(result.finalLocal["/ok.txt"]).toMatchObject({ type: "file" })
		// ignore ≠ delete: the un-representable remote file is kept.
		expect(result.finalRemote["/report."]).toMatchObject({ type: "file" })
	})

	it("AV2: win32 skips a remote file whose name ends in a space (invalidPath)", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AV2",
				mode: "twoWay",
				initialRemote: { "/draft .txt": "ok", "/trailing ": "trailing space mangles", "/ok.txt": "fine" },
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal["/trailing "]).toBeUndefined()
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
		// An INTERIOR space is fine; only a trailing one mangles.
		expect(result.finalLocal["/draft .txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/trailing "]).toMatchObject({ type: "file" })
	})

	it("AV3: win32 skips an all-dots name (strips to nothing)", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AV3",
				mode: "twoWay",
				initialRemote: { "/...": "strips to empty on windows", "/ok.txt": "fine" },
				steps: [runCycle(), runCycle()]
			})
		)

		expect(result.finalLocal["/..."]).toBeUndefined()
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
		expect(result.finalLocal["/ok.txt"]).toMatchObject({ type: "file" })
	})

	it("AV4: win32 does NOT upload a LOCAL file whose name ends in a dot (outbound guard)", async () => {
		const result = await withPlatform("win32", () =>
			runScenario({
				name: "AV4",
				mode: "twoWay",
				initialLocal: {},
				steps: [
					runCycle(),
					{ type: "localMutate", mutate: world => writeLocal(world, "out.", "should not upload on win32") },
					runCycle(),
					runCycle()
				]
			})
		)

		expect(result.finalRemote["/out."]).toBeUndefined()
		expect(ignoredReasons(result.messages)).toContain("invalidPath")
	})

	it("AV5: linux/darwin treat a trailing-dot name as legal and sync it", async () => {
		for (const platform of ["linux", "darwin"] as const) {
			const result = await withPlatform(platform, () =>
				runScenario({
					name: `AV5-${platform}`,
					mode: "twoWay",
					initialRemote: { "/report.": "legal on posix", "/ok.txt": "fine" },
					steps: [runCycle(), runCycle()]
				})
			)

			expect(result.finalLocal["/report."]).toMatchObject({ type: "file" })
			expect(ignoredReasons(result.messages)).not.toContain("invalidPath")
		}
	})
})
