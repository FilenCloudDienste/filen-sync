import { describe, it, expect, vi } from "vitest"
import pathModule from "path"
import { createWorld, BASE_TIME, LOCAL_ROOT, type CreateWorldOptions, type World } from "../harness/world"
import { toPosixPath } from "../fakes/virtual-fs"
import { LOCAL_TRASH_NAME } from "../../src/constants"

/**
 * Category ZJ — the local-trash eviction sweep must age out trashed DIRECTORIES, and the sweep's timer
 * must be torn down with the pair (M2 + M3).
 *
 * The local trash holds whatever a delete moved aside — and a deleted directory is moved in wholesale by
 * its basename, so it lands as a top-level DIRECTORY inside the trash. The 30-day eviction sweep globbed
 * with `onlyFiles:true`, which skipped every trashed directory (and, with `deep:0`, their contents too),
 * so trashed directories accumulated on disk forever (M2). Separately, the sweep's `setInterval` handle
 * was discarded, so a removed pair's timer kept firing every 5 minutes forever, pinning the whole Sync
 * (and its in-memory trees) and burning a periodic glob on a dead pair (M3).
 *
 * These are LOCAL-only concerns (a folder on the local disk + a client-side timer); the backend plays no
 * part, so there is no e2e counterpart — see the boundary note in tests/e2e/regressions.e2e.test.ts.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const
const CLEANUP_INTERVAL_MS = 300000
const DAY_MS = 86400000
const TRASH_ROOT = pathModule.posix.join(LOCAL_ROOT, LOCAL_TRASH_NAME)

async function withWorld(options: CreateWorldOptions, body: (world: World) => Promise<void>): Promise<void> {
	vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
	vi.setSystemTime(BASE_TIME)

	try {
		const world = await createWorld(options)

		await body(world)
	} finally {
		vi.useRealTimers()
	}
}

// Drop a file or a directory (with one child) straight into the on-disk trash via memfs, then backdate its
// access time so the eviction gate (`atime + 30d < now`) decides it on the next sweep.
function seedTrashEntry(world: World, name: string, kind: "file" | "dir", ageDays: number): string {
	const ifs = world.vfs.ifs
	const entryPath = pathModule.posix.join(TRASH_ROOT, name)

	if (kind === "dir") {
		ifs.mkdirSync(toPosixPath(entryPath), { recursive: true })
		ifs.writeFileSync(toPosixPath(pathModule.posix.join(entryPath, "inner.txt")), "inner")
	} else {
		ifs.mkdirSync(toPosixPath(TRASH_ROOT), { recursive: true })
		ifs.writeFileSync(toPosixPath(entryPath), "leaf")
	}

	// utimesSync takes seconds; set atime to `ageDays` before the (fake) current time.
	const atimeSeconds = (Date.now() - ageDays * DAY_MS) / 1000

	ifs.utimesSync(toPosixPath(entryPath), atimeSeconds, atimeSeconds)

	return entryPath
}

const existsInTrash = (world: World, name: string): boolean => world.vfs.ifs.existsSync(toPosixPath(pathModule.posix.join(TRASH_ROOT, name)))

describe("Category ZJ — local trash cleanup evicts directories and tears down its timer", () => {
	it("ZJ1: an old trashed DIRECTORY is evicted by the sweep (not just old files)", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "a" } }, async world => {
			const oldDir = seedTrashEntry(world, "old-dir", "dir", 40)
			const oldFile = seedTrashEntry(world, "old-file.txt", "file", 40)

			expect(existsInTrash(world, "old-dir")).toBe(true)
			expect(existsInTrash(world, "old-file.txt")).toBe(true)

			await world.sync.cleanupLocalTrashOnce()

			// Both the aged directory (with onlyFiles:true it was skipped and leaked forever) and the aged file
			// are gone.
			expect(world.vfs.ifs.existsSync(toPosixPath(oldDir)), "an aged trashed directory must be removed").toBe(false)
			expect(world.vfs.ifs.existsSync(toPosixPath(oldFile))).toBe(false)
		})
	})

	it("ZJ2: a RECENT trashed directory is kept — the 30-day gate still applies to directories", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "a" } }, async world => {
			seedTrashEntry(world, "recent-dir", "dir", 5)
			seedTrashEntry(world, "old-dir", "dir", 40)

			await world.sync.cleanupLocalTrashOnce()

			expect(existsInTrash(world, "recent-dir"), "a directory trashed 5 days ago is still within the retention window").toBe(true)
			expect(existsInTrash(world, "old-dir")).toBe(false)
		})
	})

	it("ZJ3: cleanup() tears down the sweep timer so a removed pair stops sweeping", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "a" } }, async world => {
			// The constructor armed the periodic sweep and kept its handle.
			expect(world.sync.cleanupLocalTrashInterval, "the sweep timer must be retained so it can be cleared").toBeDefined()

			await world.sync.cleanup({})

			expect(world.sync.cleanupLocalTrashInterval, "cleanup() must clear the sweep timer handle").toBeUndefined()

			// An aged directory appears in the trash AFTER the pair was removed. If the timer were still alive
			// it would fire within one interval and delete it; because it was cleared, the entry survives.
			seedTrashEntry(world, "post-removal-old-dir", "dir", 40)

			await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS * 3 + 1)

			expect(existsInTrash(world, "post-removal-old-dir"), "a removed pair must not keep sweeping the trash").toBe(true)
		})
	})

	it("ZJ4: while the pair is live the timer invokes the sweep once per period", async () => {
		await withWorld({ mode: "twoWay", initialLocal: { "/local/a.txt": "a" } }, async world => {
			// Assert the timer WIRING (it calls the sweep on schedule) rather than the sweep's async filesystem
			// effect — FastGlob's stream completion leans on the real event loop, which a floating timer
			// callback can't deterministically drain under fake timers (ZJ1/ZJ2 cover the eviction effect when
			// the sweep is awaited directly).
			const sweep = vi.spyOn(world.sync, "cleanupLocalTrashOnce").mockResolvedValue()

			expect(sweep).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS + 1)

			expect(sweep, "the armed interval must invoke the sweep once per period").toHaveBeenCalledTimes(1)

			await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS)

			expect(sweep, "and again on the next period").toHaveBeenCalledTimes(2)

			sweep.mockRestore()
		})
	})
})
