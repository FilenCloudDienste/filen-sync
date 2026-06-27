import { describe, it, expect } from "vitest"
import pathModule from "path"
import { createWorld } from "../harness/world"
import { IGNORER_VERSION } from "../../src/ignorer"

/**
 * Unit coverage for the `Ignorer` public methods the scenario suite (Category F) drives only
 * indirectly: `clearFile` (empties BOTH the dbPath copy and the physical `.filenignore`), `clear`
 * (resets the in-memory matcher), and the `ignores` root/empty-path short-circuit. The matcher
 * itself (gitignore semantics) is covered behaviorally in F; here we pin the management surface.
 */
function dbIgnorePath(dbPath: string, uuid: string): string {
	return pathModule.posix.join(dbPath, "ignorer", `v${IGNORER_VERSION}`, uuid, "filenIgnore")
}

describe("Ignorer — management surface", () => {
	it("clearFile empties both the dbPath copy and the physical .filenignore when both exist", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "secret.txt" })
		// posix joins: these paths are read back through the RAW memfs `ifs` (which is posix-only), so on a
		// Windows runner a platform `pathModule.join` would normalize to backslashes and miss the key.
		const physicalPath = pathModule.posix.join(world.syncPair.localPath, ".filenignore")
		const dbPath = dbIgnorePath(world.sync.dbPath, world.syncPair.uuid)

		// The physical `.filenignore` is written by the `filenIgnore` option. The dbPath copy is the
		// engine's merged-on-disk mirror, seeded out-of-band in the harness (as Category F does); seed it
		// so clearFile sees BOTH files present and exercises both blank-out branches.
		world.vfs.ifs.mkdirSync(pathModule.posix.dirname(dbPath), { recursive: true })
		world.vfs.ifs.writeFileSync(dbPath, "db-secret.txt")

		expect(world.vfs.ifs.readFileSync(physicalPath, "utf-8")).toBe("secret.txt")
		expect(world.vfs.ifs.readFileSync(dbPath, "utf-8").length).toBeGreaterThan(0)

		await world.sync.ignorer.clearFile()

		// Both copies are now blanked (clearFile preserves the files but empties them).
		expect(world.vfs.ifs.readFileSync(physicalPath, "utf-8")).toBe("")
		expect(world.vfs.ifs.readFileSync(dbPath, "utf-8")).toBe("")
	})

	it("clear resets the in-memory matcher so a previously-ignored path is no longer ignored", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "*.log" })

		await world.sync.ignorer.initialize()

		expect(world.sync.ignorer.ignores("a.log")).toBe(true)

		world.sync.ignorer.clear()

		expect(world.sync.ignorer.ignores("a.log")).toBe(false)
	})

	it("ignores treats the root/empty path as not ignored even under a catch-all pattern", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "*" })

		await world.sync.ignorer.initialize()

		// A normal path under "*" is ignored…
		expect(world.sync.ignorer.ignores("anything.txt")).toBe(true)
		// …but the root, the leading-slash root, and the empty string short-circuit to false.
		expect(world.sync.ignorer.ignores("/")).toBe(false)
		expect(world.sync.ignorer.ignores("")).toBe(false)
	})
})
