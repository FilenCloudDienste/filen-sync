import { describe, it, expect, vi, afterEach } from "vitest"

/**
 * Unit coverage for the iCloud-backed-path detection in `src/utils.ts`
 * (`pathSyncedByICloud` / `isPathSyncedByICloud`). These warn the user when a sync pair points at a
 * folder iCloud is also managing. The darwin path shells out to `xattr`; we mock `child_process.exec`
 * so the probe is deterministic (no real `xattr`, no real filesystem) and exercise both the
 * provider-attribute match and the ancestry walk.
 */
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock("child_process", async importOriginal => {
	const actual = await importOriginal<typeof import("child_process")>()

	return { ...actual, exec: execMock }
})

import { pathSyncedByICloud, isPathSyncedByICloud } from "../../src/utils"

/** Run `fn` with `process.platform` temporarily forced to `platform`, restoring it afterwards. */
async function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
	const original = Object.getOwnPropertyDescriptor(process, "platform")

	Object.defineProperty(process, "platform", { value: platform, configurable: true })

	try {
		await fn()
	} finally {
		if (original) {
			Object.defineProperty(process, "platform", original)
		}
	}
}

/** Drive the mocked `exec` callback with a fixed `(err, stdout, stderr)` result for every invocation. */
function execYields(err: Error | null, stdout: string, stderr: string): void {
	execMock.mockImplementation((_command: string, callback: (e: Error | null, o: string, s: string) => void) => {
		callback(err, stdout, stderr)
	})
}

/** Extract the quoted path from an `xattr "<path>"` command. */
function pathOf(command: string): string {
	return /^xattr "(.*)"$/.exec(command)?.[1] ?? ""
}

afterEach(() => {
	execMock.mockReset()
})

describe("iCloud detection (utils)", () => {
	it("pathSyncedByICloud short-circuits to false off darwin without probing xattr", async () => {
		await withPlatform("linux", async () => {
			expect(await pathSyncedByICloud("/home/user/docs")).toBe(false)
		})

		expect(execMock).not.toHaveBeenCalled()
	})

	it("pathSyncedByICloud is true when xattr lists a file-provider / iCloud attribute", async () => {
		await withPlatform("darwin", async () => {
			execYields(null, "com.apple.quarantine\ncom.apple.fileprovider.fpfs#P", "")

			expect(await pathSyncedByICloud("/Users/me/Mobile Documents")).toBe(true)
		})
	})

	it("pathSyncedByICloud is false when xattr lists only non-cloud attributes", async () => {
		await withPlatform("darwin", async () => {
			execYields(null, "com.apple.quarantine\nuser.custom", "")

			expect(await pathSyncedByICloud("/Users/me/local")).toBe(false)
		})
	})

	it("pathSyncedByICloud resolves false when xattr errors", async () => {
		await withPlatform("darwin", async () => {
			execYields(new Error("xattr: No such file"), "", "")

			expect(await pathSyncedByICloud("/missing")).toBe(false)
		})
	})

	it("pathSyncedByICloud resolves false when xattr writes to stderr", async () => {
		await withPlatform("darwin", async () => {
			execYields(null, "", "xattr: permission denied")

			expect(await pathSyncedByICloud("/denied")).toBe(false)
		})
	})

	it("isPathSyncedByICloud is false off darwin", async () => {
		await withPlatform("win32", async () => {
			expect(await isPathSyncedByICloud("/Users/me/x/y")).toBe(false)
		})

		expect(execMock).not.toHaveBeenCalled()
	})

	it("isPathSyncedByICloud walks up the ancestry and is true when an ANCESTOR is iCloud-backed", async () => {
		await withPlatform("darwin", async () => {
			// Only the grandparent directory carries the marker; the leaf and its parent do not.
			execMock.mockImplementation((command: string, callback: (e: Error | null, o: string, s: string) => void) => {
				const target = pathOf(command)

				callback(null, target === "/Users/me/iCloudDrive" ? "com.apple.icloud.marker" : "com.apple.quarantine", "")
			})

			expect(await isPathSyncedByICloud("/Users/me/iCloudDrive/docs/file.txt")).toBe(true)
		})
	})

	it("isPathSyncedByICloud walks to the root and is false when nothing in the ancestry is iCloud-backed", async () => {
		await withPlatform("darwin", async () => {
			execYields(null, "com.apple.quarantine", "")

			expect(await isPathSyncedByICloud("/Users/me/local/docs/file.txt")).toBe(false)
		})
	})
})
