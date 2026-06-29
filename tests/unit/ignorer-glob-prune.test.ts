import { describe, it, expect } from "vitest"
import { createWorld } from "../harness/world"

/**
 * Unit coverage for Ignorer.globIgnorePatternsForTraversal — the FastGlob `ignore` globs that prune
 * provably-.filenignore'd subtrees from the local scan. The safety contract (verified here): every glob
 * is a strict SUBSET of the matcher's ignored set, so FastGlob can never drop a path the matcher keeps.
 * The behavioral end-to-end safety (excluded skipped, negation re-includes synced, nothing mis-deleted)
 * lives in tests/scenarios/zs-ignore-traversal-pruning.test.ts and the live e2e. add-only.
 */
async function globsFor(filenIgnore: string): Promise<string[]> {
	const world = await createWorld({ mode: "twoWay", filenIgnore })

	await world.sync.ignorer.initialize()

	return world.sync.ignorer.globIgnorePatternsForTraversal().sort()
}

describe("Ignorer.globIgnorePatternsForTraversal — safe traversal-prune globs", () => {
	it("a bare directory name prunes the ENTRY and its subtree at any depth", async () => {
		const globs = await globsFor("node_modules")

		expect(globs).toContain("**/node_modules")
		expect(globs).toContain("**/node_modules/**/*")
	})

	it("a dir-only pattern prunes only the subtree, NEVER a same-named file", async () => {
		const globs = await globsFor("build/")

		expect(globs).toContain("**/build/**/*")
		// A file literally named "build" must stay syncable, so the bare entry glob is withheld.
		expect(globs).not.toContain("**/build")
	})

	it("an anchored pattern stays anchored to the root (no **/ prefix)", async () => {
		const globs = await globsFor("/dist")

		expect(globs).toContain("dist")
		expect(globs).toContain("dist/**/*")
		expect(globs).not.toContain("**/dist")
	})

	it("a nested anchored pattern keeps its full path", async () => {
		const globs = await globsFor("logs/debug")

		expect(globs).toContain("logs/debug")
		expect(globs).toContain("logs/debug/**/*")
	})

	it("glob patterns are NOT translated — left to the per-entry post-filter", async () => {
		expect(await globsFor("*.log")).toEqual([])
		expect(await globsFor("**/*.tmp")).toEqual([])
		expect(await globsFor("cache-*")).toEqual([])
		expect(await globsFor("file?.txt")).toEqual([])
	})

	it("comments, blank lines and negation lines produce no globs", async () => {
		expect(await globsFor("# a comment\n\n   \n!keep.txt")).toEqual([])
	})

	it("no .filenignore content yields no globs", async () => {
		expect(await globsFor("")).toEqual([])
	})

	it("CRITICAL: a negation re-including a candidate name leaves it un-pruned (probe-gated)", async () => {
		// `cache` ignores cache; `!cache` re-includes it, so the live matcher does NOT ignore cache → the
		// candidate fails its probe and is never pruned. This is what makes the optimization negation-safe.
		const globs = await globsFor("cache\n!cache")

		expect(globs).not.toContain("**/cache")
		expect(globs).not.toContain("**/cache/**")
	})

	it("CRITICAL: an ignored dir with a negated child still prunes (the child stays ignored per gitignore)", async () => {
		// gitignore forbids re-including a file once its parent dir is excluded, so build/keep.txt is STILL
		// ignored — making it safe to prune build's whole subtree.
		const world = await createWorld({ mode: "twoWay", filenIgnore: "build/\n!build/keep.txt" })

		await world.sync.ignorer.initialize()

		expect(world.sync.ignorer.ignores("build/keep.txt")).toBe(true)
		expect(world.sync.ignorer.globIgnorePatternsForTraversal()).toContain("**/build/**/*")
	})

	it("multiple patterns combine; only the safely-translatable ones become globs", async () => {
		const globs = await globsFor("node_modules\n*.log\n/dist\n# c\n!x")

		expect(globs).toContain("**/node_modules")
		expect(globs).toContain("dist")
		expect(globs.some(g => g.includes("*.log"))).toBe(false)
	})
})
