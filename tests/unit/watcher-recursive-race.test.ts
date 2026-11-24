import { describe, it, expect } from "vitest"
import { spawnSync } from "child_process"
import pathModule from "path"
import { isLocalTrashPath, isRecursiveWatchRace } from "../../src/lib/environment"
import { LOCAL_TRASH_NAME } from "../../src/constants"

/**
 * Linux has no native recursive fs.watch, and since Node 24.22.0 its JS emulation stats a reported path inside its
 * own event callback, tolerating only ENOENT: a watched directory replaced by a file of the same name throws ENOTDIR
 * there, uncaught, ending the sync worker. Every download stages exactly that way in the local trash, so the
 * watcher skips the trash, and the remaining race (the user's own directory replaced by a file) is contained.
 */
describe("the recursive watcher's directory-to-file race", () => {
	it("recognises the local trash and only it", () => {
		expect(isLocalTrashPath(LOCAL_TRASH_NAME)).toBe(true)
		expect(isLocalTrashPath(LOCAL_TRASH_NAME + pathModule.sep + "uuid")).toBe(true)
		expect(isLocalTrashPath(LOCAL_TRASH_NAME + "/uuid/uuid")).toBe(true)
		expect(isLocalTrashPath(LOCAL_TRASH_NAME + ".txt")).toBe(false)
		expect(isLocalTrashPath("notes/" + LOCAL_TRASH_NAME)).toBe(false)
		expect(isLocalTrashPath("docs")).toBe(false)
	})

	it("contains only the emulated watcher's stat errors", () => {
		const raised = (code: string, frame: string): Error => {
			const error = Object.assign(new Error(`${code}: not a directory, lstat '/root/a/a'`), { code })

			error.stack = `Error: ${error.message}\n    at lstatSync (node:fs:1770:25)\n    at #onFolderEvent (${frame}:268:21)`

			return error
		}

		expect(isRecursiveWatchRace(raised("ENOTDIR", "node:internal/fs/recursive_watch"))).toBe(true)
		expect(isRecursiveWatchRace(raised("ENOENT", "node:internal/fs/recursive_watch"))).toBe(true)
		expect(isRecursiveWatchRace(raised("EACCES", "node:internal/fs/recursive_watch"))).toBe(false)
		expect(isRecursiveWatchRace(raised("ENOTDIR", "/app/src/lib/sync.ts"))).toBe(false)
		expect(isRecursiveWatchRace("ENOTDIR")).toBe(false)
	})

	it.skipIf(process.platform === "darwin" || process.platform === "win32")(
		"survives a directory replaced by a file, in the trash and outside it",
		() => {
			const result = spawnSync(
				process.execPath,
				["--import", "tsx", pathModule.join(__dirname, "fixtures", "recursive-watch-race.ts")],
				{ encoding: "utf-8", timeout: 30_000 }
			)

			expect(result.stderr).toBe("")
			expect(result.status).toBe(0)

			const { trashChanges, userChanges } = JSON.parse(result.stdout) as { trashChanges: number; userChanges: number }

			// Nothing in the trash is watched; the user's directories are.
			expect(trashChanges).toBe(0)
			expect(userChanges).toBeGreaterThan(0)
		},
		40_000
	)
})
