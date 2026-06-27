import { type E2EWorld } from "./world"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"

/** Resolve a root-relative path (with or without a leading slash) to an absolute local path. */
function abs(world: E2EWorld, relativePath: string): string {
	return pathModule.join(world.localRoot, relativePath.replace(/^\/+/, ""))
}

// ---- Local mutations (real filesystem under the sync root) -------------------------------------------

export async function writeLocal(world: E2EWorld, relativePath: string, content: string): Promise<void> {
	const full = abs(world, relativePath)

	await fs.ensureDir(pathModule.dirname(full))
	await fs.writeFile(full, content)
}

export async function readLocal(world: E2EWorld, relativePath: string): Promise<string> {
	return await fs.readFile(abs(world, relativePath), { encoding: "utf-8" })
}

export async function mkdirLocal(world: E2EWorld, relativePath: string): Promise<void> {
	await fs.ensureDir(abs(world, relativePath))
}

export async function rmLocal(world: E2EWorld, relativePath: string): Promise<void> {
	await fs.rm(abs(world, relativePath), { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
}

export async function renameLocal(world: E2EWorld, fromRelative: string, toRelative: string): Promise<void> {
	const to = abs(world, toRelative)

	await fs.ensureDir(pathModule.dirname(to))
	await fs.move(abs(world, fromRelative), to, { overwrite: true })
}

export async function existsLocal(world: E2EWorld, relativePath: string): Promise<boolean> {
	return await fs.pathExists(abs(world, relativePath))
}

// ---- Remote mutations (real SDK calls under the /<runId> root) ---------------------------------------

const segments = (relativePath: string): string[] => relativePath.split("/").map(segment => segment.trim()).filter(Boolean)

/**
 * Find-or-create the directory chain for a root-relative directory path, returning the leaf directory's
 * uuid. An empty path resolves to the remote root itself.
 */
export async function ensureRemoteDir(world: E2EWorld, relativeDir: string): Promise<string> {
	let parentUUID = world.remoteParentUUID

	for (const segment of segments(relativeDir)) {
		const items = await world.sdk.cloud().listDirectory({ uuid: parentUUID })
		const existing = items.find(item => item.type === "directory" && item.name === segment)

		parentUUID = existing ? existing.uuid : await world.sdk.cloud().createDirectory({ name: segment, parent: parentUUID })
	}

	return parentUUID
}

export async function mkdirRemote(world: E2EWorld, relativePath: string): Promise<string> {
	return await ensureRemoteDir(world, relativePath)
}

/** Upload `content` to the remote at `relativePath`, creating any missing parent directories. */
export async function uploadRemote(world: E2EWorld, relativePath: string, content: string): Promise<void> {
	const parts = segments(relativePath)
	const name = parts[parts.length - 1]

	if (!name) {
		throw new Error(`Invalid remote upload path: ${relativePath}`)
	}

	const parentUUID = await ensureRemoteDir(world, parts.slice(0, -1).join("/"))
	const source = pathModule.join(world.workRoot, `upload-${uuidv4()}.tmp`)

	await fs.writeFile(source, content)

	try {
		await world.sdk.cloud().uploadLocalFile({ source, parent: parentUUID, name })
	} finally {
		await fs.rm(source, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
	}
}

/** The CloudItem at a root-relative path, or null if absent. */
export async function resolveRemote(
	world: E2EWorld,
	relativePath: string
): Promise<Awaited<ReturnType<ReturnType<E2EWorld["sdk"]["cloud"]>["listDirectory"]>>[number] | null> {
	const parts = segments(relativePath)

	if (parts.length === 0) {
		return null
	}

	let parentUUID = world.remoteParentUUID

	for (let i = 0; i < parts.length; i++) {
		const items = await world.sdk.cloud().listDirectory({ uuid: parentUUID })
		const match = items.find(item => item.name === parts[i])

		if (!match) {
			return null
		}

		if (i === parts.length - 1) {
			return match
		}

		if (match.type !== "directory") {
			return null
		}

		parentUUID = match.uuid
	}

	return null
}

/** Permanently delete (no trash) the remote item at `relativePath`. */
export async function deleteRemote(world: E2EWorld, relativePath: string): Promise<void> {
	const item = await resolveRemote(world, relativePath)

	if (!item) {
		return
	}

	if (item.type === "directory") {
		await world.sdk.cloud().deleteDirectory({ uuid: item.uuid })
	} else {
		await world.sdk.cloud().deleteFile({ uuid: item.uuid })
	}
}
