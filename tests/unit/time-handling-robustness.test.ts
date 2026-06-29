import { describe, it, expect } from "vitest"
import { convertTimestampToMs } from "../../src/utils"

/**
 * convertTimestampToMs must tolerate a MISSING/invalid time. File metadata can decrypt without a
 * `lastModified` (older files, or other clients) despite the SDK type declaring it required; a non-finite
 * value flowing through would become NaN and (a) make a file look changed every cycle (NaN !== NaN), and
 * (b) throw via `new Date(NaN)` in the post-download utimes so the file never finishes syncing. An unknown
 * time must resolve to the epoch (0). NEW FILE — does not touch the existing n-unit convertTimestampToMs
 * coverage.
 */
describe("convertTimestampToMs — missing/invalid time robustness", () => {
	it("maps undefined to the epoch (0), never NaN", () => {
		// Runtime can violate the `number` type (older metadata lacks lastModified).
		expect(convertTimestampToMs(undefined as unknown as number)).toBe(0)
	})

	it("maps NaN / Infinity to the epoch (0)", () => {
		expect(convertTimestampToMs(NaN)).toBe(0)
		expect(convertTimestampToMs(Infinity)).toBe(0)
		expect(convertTimestampToMs(-Infinity)).toBe(0)
	})

	it("leaves a valid millisecond timestamp unchanged", () => {
		expect(convertTimestampToMs(1_700_000_000_000)).toBe(1_700_000_000_000)
	})

	it("upconverts a second-precision timestamp to milliseconds", () => {
		expect(convertTimestampToMs(1_700_000_000)).toBe(1_700_000_000_000)
	})

	it("keeps 0 as 0 (a deliberately-unknown time stays the epoch, not re-interpreted)", () => {
		expect(convertTimestampToMs(0)).toBe(0)
	})

	it("the result is always a finite number, so downstream comparisons and Date() never break", () => {
		for (const input of [undefined as unknown as number, NaN, Infinity, 0, 1_700_000_000, 1_700_000_000_000]) {
			const result = convertTimestampToMs(input)

			expect(Number.isFinite(result)).toBe(true)
			expect(Number.isNaN(new Date(result).getTime())).toBe(false)
		}
	})
})
