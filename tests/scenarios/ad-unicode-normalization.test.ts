import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"

/**
 * Category AD — Unicode normalization (KNOWN, DEFERRED LIMITATION).
 *
 * A filename like "cafe<accent>.txt" can be encoded two ways that look identical but are different bytes:
 *   - NFC (precomposed):  the accented letter is one code point  (U+00E9)
 *   - NFD (decomposed):   base letter + combining accent          (U+0065 U+0301)
 *
 * The engine compares names BYTEWISE and does NOT Unicode-normalize — and neither does @filen/sdk
 * (verified: the SDK only uses path.normalize for `..`/separators, never String.normalize("NFC")). So
 * the SAME visual filename in two normalization forms is treated as two distinct files, which on a
 * mixed-normalization cross-sync ends as a permanent DUPLICATE on both sides.
 *
 * In practice NFD names come almost exclusively from old macOS HFS+ (which forced NFD on write); modern
 * Windows/Linux/APFS-macOS produce NFC. For a modern user base this is rare, so the fix (NFC-normalize
 * keys for comparison + migrate the persisted base trees so the first post-upgrade cycle stays a no-op)
 * is DEFERRED by maintainer decision (2026-06-27). See docs/hardening-findings.md and the
 * filen-sync-caveats memory.
 *
 * These tests PIN the current behavior (golden master): if normalization is ever added, AD1 flips and
 * forces this note + the fix to be reconciled, rather than the change sliding in silently.
 *
 * NFC below is the precomposed byte sequence and NFD the decomposed one of the same visual name;
 * verified distinct-but-NFC-equal in the first two assertions of AD1.
 */
const NFC: string = "café.txt" // precomposed: U+00E9
const NFD: string = "café.txt" // decomposed: U+0065 U+0301

describe("Category AD — Unicode normalization (known, deferred limitation)", () => {
	it("AD1: KNOWN LIMITATION — NFC-remote vs NFD-local of the same visual name DUPLICATE (no normalization yet)", async () => {
		// Sanity: different bytes, yet the SAME name once normalized — exactly the trap the engine misses.
		expect(NFC).not.toBe(NFD)
		expect(NFC.normalize("NFC")).toBe(NFD.normalize("NFC"))

		const result = await runScenario({
			name: "AD1",
			mode: "twoWay",
			initialLocal: { [`/local/${NFD}`]: "from-an-nfd-client" },
			initialRemote: { [`/${NFC}`]: "from-an-nfc-client" },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		const localForms = [NFC, NFD].filter(name => result.finalLocal[`/${name}`] !== undefined)
		const remoteForms = [NFC, NFD].filter(name => result.finalRemote[`/${name}`] !== undefined)

		// DOCUMENTED current behavior: BOTH forms end up on BOTH sides — the duplication bug. When
		// NFC-normalized comparison lands, each side collapses to a single form and these flip to 1.
		expect(localForms.length).toBe(2)
		expect(remoteForms.length).toBe(2)
	})

	it("AD2: a pure-ASCII name is unaffected (normalization would be a no-op here) — sanity", async () => {
		const result = await runScenario({
			name: "AD2",
			mode: "twoWay",
			initialLocal: { "/local/plain.txt": "ascii" },
			initialRemote: { "/plain.txt": "ascii" },
			steps: [runCycle(), runCycle()]
		})

		// No duplication for ASCII: exactly one converged copy on each side.
		expect(Object.keys(result.finalLocal).filter(key => key.includes("plain")).length).toBe(1)
		expect(Object.keys(result.finalRemote).filter(key => key.includes("plain")).length).toBe(1)
	})
})
