import { it } from "vitest"

/**
 * A scenario that encodes the CORRECT behavior the engine currently violates (catalogued in
 * docs/sync-bug-catalog.md). Implemented with `it.fails` so the suite stays green while the bug
 * exists: the body asserts correct behavior, the engine produces wrong behavior, the assertion
 * throws, and `it.fails` treats that throw as a pass.
 *
 * When the corresponding Phase 2 fix lands, the assertion starts passing, `it.fails` then FAILS
 * (the body no longer throws) — that is the signal to convert `knownBug(...)` to a plain `it(...)`.
 *
 * Keep the body focused so it fails for the RIGHT reason (the catalogued defect), not an unrelated
 * harness error.
 */
export function knownBug(bugId: string, name: string, fn: () => Promise<void>): void {
	it.fails(`[KB ${bugId}] ${name}`, fn)
}
