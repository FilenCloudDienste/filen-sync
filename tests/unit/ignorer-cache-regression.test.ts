import { describe, it, expect } from "vitest"
import { createWorld } from "../harness/world"

/**
 * Added regression tests pinning the ignorer cache-preservation optimization: a per-cycle re-init
 * (no passed content) with byte-for-byte unchanged rules must NOT wipe the filesystem ignoredCaches
 * (that wipe defeated the cache and forced the whole tree's per-file ignore checks to recompute every
 * cycle), while a real rule change MUST still clear them and update the decisions.
 *
 * NEW FILE — does not touch the existing Ignorer tests in tests/unit/ignorer.test.ts.
 */
describe("Ignorer — ignoredCache preservation across unchanged re-init (perf guard)", () => {
	it("keeps the filesystem ignoredCache populated when re-init finds unchanged rules", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "*.log" })

		// Populate the local FS ignore cache for a path.
		world.sync.localFileSystem.isPathIgnored("/keep.txt", "/local/keep.txt", "file")

		expect(world.sync.localFileSystem.ignoredCache.has("/keep.txt")).toBe(true)

		// The per-cycle re-init path (no passed content) with identical rules must leave the cache intact.
		await world.sync.ignorer.initialize()

		expect(world.sync.localFileSystem.ignoredCache.has("/keep.txt")).toBe(true)
		expect(world.sync.remoteFileSystem.ignoredCache).toBeDefined()
	})

	it("clears the cache and updates decisions when the rules change (explicit update)", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "*.log" })

		world.sync.localFileSystem.isPathIgnored("/a.txt", "/local/a.txt", "file")

		expect(world.sync.localFileSystem.ignoredCache.has("/a.txt")).toBe(true)
		expect(world.sync.ignorer.ignores("a.txt")).toBe(false)

		await world.sync.ignorer.update("*.txt")

		// The cache was wiped (re-evaluation forced) and the new rule now applies.
		expect(world.sync.localFileSystem.ignoredCache.has("/a.txt")).toBe(false)
		expect(world.sync.ignorer.ignores("a.txt")).toBe(true)
	})

	it("picks up a physical .filenignore change on the next no-arg initialize", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "*.log" })

		expect(world.sync.ignorer.ignores("a.txt")).toBe(false)

		await world.vfs.fs.writeFile("/local/.filenignore", "*.txt", { encoding: "utf-8" })

		// No passed content — exactly the per-cycle path — must still detect the on-disk change.
		await world.sync.ignorer.initialize()

		expect(world.sync.ignorer.ignores("a.txt")).toBe(true)
	})

	it("clear() then a same-content initialize() rebuilds the matcher (no stale empty matcher)", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "*.log" })

		expect(world.sync.ignorer.ignores("a.log")).toBe(true)

		world.sync.ignorer.clear()

		expect(world.sync.ignorer.ignores("a.log")).toBe(false)

		// Same content as before — the baseline reset in clear() must force a rebuild, not a skip.
		await world.sync.ignorer.initialize()

		expect(world.sync.ignorer.ignores("a.log")).toBe(true)
	})
})
