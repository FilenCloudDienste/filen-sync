import type FilenSDK from "@filen/sdk"
import { type E2EWorld } from "./world"
import { LOCAL_TRASH_NAME } from "../../../src/constants"
import pathModule from "path"
import fs from "fs-extra"
import crypto from "crypto"
import { v4 as uuidv4 } from "uuid"

// The exact param shape the SDK's downloadFileToLocal expects, derived from its public surface so the
// file-encryption-version type stays in lock-step.
type DownloadParams = Parameters<ReturnType<FilenSDK["cloud"]>["downloadFileToLocal"]>[0]

export type E2ESnapshotEntry = { type: "file" | "directory"; size: number; contentHash?: string }

/**
 * `relativePath -> { type, size, contentHash? }`. Local and remote snapshots are directly comparable:
 * identical content yields the same sha512 on both sides. `contentHash` is only populated when
 * `withContent` is requested (it costs a download per remote file), so size-only convergence stays cheap.
 */
export type E2ESnapshot = Record<string, E2ESnapshotEntry>

// Control files that live locally but never sync to the remote root — excluded so the two sides match.
const LOCAL_ONLY_ENTRIES = new Set<string>([LOCAL_TRASH_NAME, ".filenignore"])

function sha512Hex(data: Buffer): string {
	return crypto.createHash("sha512").update(Uint8Array.from(data)).digest("hex")
}

/**
 * Snapshot the real local sync directory (relative POSIX paths), skipping the local trash and the
 * `.filenignore` control file.
 */
export async function snapshotLocalReal(world: E2EWorld, options: { withContent?: boolean } = {}): Promise<E2ESnapshot> {
	const result: E2ESnapshot = {}
	const root = world.localRoot

	const walk = async (directory: string): Promise<void> => {
		const entries = await fs.readdir(directory)

		for (const entry of entries) {
			const full = pathModule.join(directory, entry)
			const relativePath = full.slice(root.length).split(pathModule.sep).join("/")

			if (relativePath.split("/").length === 2 && LOCAL_ONLY_ENTRIES.has(entry)) {
				continue
			}

			const stats = await fs.lstat(full)

			if (stats.isDirectory()) {
				result[relativePath] = { type: "directory", size: 0 }

				await walk(full)
			} else if (stats.isFile()) {
				const entryResult: E2ESnapshotEntry = { type: "file", size: stats.size }

				if (options.withContent) {
					entryResult.contentHash = sha512Hex(await fs.readFile(full))
				}

				result[relativePath] = entryResult
			}
		}
	}

	await walk(root)

	return result
}

/**
 * Snapshot the real remote `/<runId>` tree (relative POSIX paths) by recursively listing it. With
 * `withContent`, each file is downloaded to a temp path, hashed, and removed.
 */
export async function snapshotRemoteReal(world: E2EWorld, options: { withContent?: boolean } = {}): Promise<E2ESnapshot> {
	const result: E2ESnapshot = {}

	const walk = async (uuid: string, prefix: string): Promise<void> => {
		const items = await world.sdk.cloud().listDirectory({ uuid })

		for (const item of items) {
			const relativePath = `${prefix}/${item.name}`

			// Skip the root `.filenignore` on BOTH sides (it now syncs, but it is a config file that must not
			// affect tree-convergence comparisons — symmetric with the local snapshot). Tests that specifically
			// assert it use resolveRemote / existsLocal directly.
			if (relativePath.split("/").length === 2 && LOCAL_ONLY_ENTRIES.has(item.name)) {
				continue
			}

			if (item.type === "directory") {
				result[relativePath] = { type: "directory", size: 0 }

				await walk(item.uuid, relativePath)
			} else {
				const entryResult: E2ESnapshotEntry = { type: "file", size: item.size }

				if (options.withContent) {
					entryResult.contentHash = await downloadAndHash(world, item)
				}

				result[relativePath] = entryResult
			}
		}
	}

	await walk(world.remoteParentUUID, "")

	return result
}

async function downloadAndHash(
	world: E2EWorld,
	item: Pick<DownloadParams, "uuid" | "bucket" | "region" | "chunks" | "version" | "key" | "size">
): Promise<string> {
	const to = pathModule.join(world.workRoot, `dl-${uuidv4()}.tmp`)

	try {
		await world.sdk.cloud().downloadFileToLocal({
			uuid: item.uuid,
			bucket: item.bucket,
			region: item.region,
			chunks: item.chunks,
			version: item.version,
			key: item.key,
			size: item.size,
			to
		})

		return sha512Hex(await fs.readFile(to))
	} finally {
		await fs.rm(to, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
	}
}
