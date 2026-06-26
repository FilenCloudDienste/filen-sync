import pathModule from "path"
import { type World } from "./world"

/**
 * Local filesystem mutations applied to a {@link World} between cycles. All paths are relative to the
 * local sync root (e.g. "a.txt", "dir/b.txt"). Parent directories are created as needed. After a
 * local mutation the runner fires the watcher so the next cycle rescans.
 */

function localFull(world: World, relativePath: string): string {
	return pathModule.posix.join(world.localPath, relativePath.replace(/^\/+/, ""))
}

export function writeLocal(world: World, relativePath: string, content: string): void {
	const full = localFull(world, relativePath)

	world.vfs.ifs.mkdirSync(pathModule.posix.dirname(full), { recursive: true })
	world.vfs.ifs.writeFileSync(full, content)
}

/** Write a local file and force a specific mtime (whole-second precision drives conflict resolution). */
export function writeLocalAt(world: World, relativePath: string, content: string, mtimeMs: number): void {
	writeLocal(world, relativePath, content)

	const seconds = mtimeMs / 1000

	world.vfs.ifs.utimesSync(localFull(world, relativePath), seconds, seconds)
}

/** Update a local file's mtime WITHOUT changing its content or inode (a pure touch). */
export function touchLocal(world: World, relativePath: string, mtimeMs: number): void {
	const seconds = mtimeMs / 1000

	world.vfs.ifs.utimesSync(localFull(world, relativePath), seconds, seconds)
}

export function mkdirLocal(world: World, relativePath: string): void {
	world.vfs.ifs.mkdirSync(localFull(world, relativePath), { recursive: true })
}

export function rmLocal(world: World, relativePath: string): void {
	world.vfs.ifs.rmSync(localFull(world, relativePath), { recursive: true, force: true })
}

export function renameLocal(world: World, fromRelativePath: string, toRelativePath: string): void {
	const from = localFull(world, fromRelativePath)
	const to = localFull(world, toRelativePath)

	world.vfs.ifs.mkdirSync(pathModule.posix.dirname(to), { recursive: true })
	world.vfs.ifs.renameSync(from, to)
}

export function readLocal(world: World, relativePath: string): string {
	return world.vfs.ifs.readFileSync(localFull(world, relativePath), "utf-8") as string
}

export function existsLocal(world: World, relativePath: string): boolean {
	try {
		world.vfs.ifs.statSync(localFull(world, relativePath))

		return true
	} catch {
		return false
	}
}
