import pathModule from "path"
import crypto from "crypto"
import { LOCAL_TRASH_NAME } from "../../src/constants"
import { type SyncMessage } from "../../src/types"
import { type World } from "./world"

export type SnapshotEntry = { type: "file" | "directory"; size: number; mtimeSec: number; contentHash: string }

/**
 * The normalized assertion unit: `path → { type, size, mtime(sec), contentHash }`, excluding the
 * local trash directory. Local and remote snapshots are directly comparable — same content yields
 * the same sha512 hash and the same whole-second mtime on both sides.
 */
export type WorldSnapshot = Record<string, SnapshotEntry>

function sha512Hex(data: Buffer): string {
	return crypto.createHash("sha512").update(Uint8Array.from(data)).digest("hex")
}

/**
 * Normalized snapshot of the local sync directory (relative POSIX paths), excluding the local trash.
 */
export function snapshotLocal(world: World): WorldSnapshot {
	const result: WorldSnapshot = {}
	const ifs = world.vfs.ifs
	const root = world.localPath

	const walk = (directory: string): void => {
		let entries: string[]

		try {
			entries = ifs.readdirSync(directory) as string[]
		} catch {
			return
		}

		for (const entry of entries) {
			if (entry === LOCAL_TRASH_NAME) {
				continue
			}

			const full = pathModule.posix.join(directory, entry)
			const relativePath = full.slice(root.length)
			const stats = ifs.statSync(full)

			if (stats.isDirectory()) {
				result[relativePath] = { type: "directory", size: 0, mtimeSec: 0, contentHash: "" }

				walk(full)
			} else if (stats.isFile()) {
				const content = ifs.readFileSync(full) as Buffer

				result[relativePath] = {
					type: "file",
					size: stats.size,
					mtimeSec: Math.floor(stats.mtimeMs / 1000),
					contentHash: sha512Hex(content)
				}
			}
		}
	}

	walk(root)

	return result
}

/**
 * Normalized snapshot of the live remote tree (relative POSIX paths).
 */
export function snapshotRemote(world: World): WorldSnapshot {
	return world.cloud.controls.snapshot()
}

/** All messages of a given `type`. */
export function messagesOfType<T extends SyncMessage["type"]>(messages: SyncMessage[], type: T): Extract<SyncMessage, { type: T }>[] {
	return messages.filter((message): message is Extract<SyncMessage, { type: T }> => message.type === type)
}

/** Count messages of a given `type`. */
export function countMessages(messages: SyncMessage[], type: SyncMessage["type"]): number {
	return messages.filter(message => message.type === type).length
}

/** The `of` discriminators of every "transfer" message (e.g. "upload", "downloadFile", ...). */
export function transferKinds(messages: SyncMessage[]): string[] {
	return messagesOfType(messages, "transfer").map(message => message.data.of)
}
