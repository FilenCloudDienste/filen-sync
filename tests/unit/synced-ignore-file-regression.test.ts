import { describe, it, expect } from "vitest"
import { isSyncedIgnoreFile } from "../../src/utils"

/**
 * Regression net for `isSyncedIgnoreFile` — the predicate that exempts the ROOT `.filenignore` from the
 * excludeDotFiles dotfile filter so the shared ignore config syncs across machines. The local scan emits the
 * path WITHOUT a leading slash, the remote scan + delta paths WITH one, so BOTH forms must match; a nested
 * `.filenignore` (a normal file the engine never reads) must NOT match, or excludeDotFiles users would start
 * leaking arbitrary nested dotfiles named `.filenignore`.
 */
describe("isSyncedIgnoreFile — root .filenignore exemption", () => {
	it("matches the root form emitted by the LOCAL scan (no leading slash)", () => {
		expect(isSyncedIgnoreFile(".filenignore")).toBe(true)
	})

	it("matches the root form emitted by the REMOTE scan + delta paths (leading slash)", () => {
		expect(isSyncedIgnoreFile("/.filenignore")).toBe(true)
	})

	it("does NOT match a NESTED .filenignore (a normal file the engine never reads)", () => {
		expect(isSyncedIgnoreFile("sub/.filenignore")).toBe(false)
		expect(isSyncedIgnoreFile("/sub/.filenignore")).toBe(false)
		expect(isSyncedIgnoreFile("a/b/c/.filenignore")).toBe(false)
	})

	it("does NOT match other dotfiles or similarly-named files", () => {
		expect(isSyncedIgnoreFile(".filenignore.txt")).toBe(false)
		expect(isSyncedIgnoreFile(".filenignorex")).toBe(false)
		expect(isSyncedIgnoreFile("filenignore")).toBe(false)
		expect(isSyncedIgnoreFile(".DS_Store")).toBe(false)
		expect(isSyncedIgnoreFile("")).toBe(false)
		expect(isSyncedIgnoreFile("/")).toBe(false)
	})
})
