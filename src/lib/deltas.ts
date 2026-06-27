import type Sync from "./sync"
import { type LocalTree, type LocalTreeError, type LocalTreeIgnored } from "./filesystems/local"
import { type RemoteTree } from "./filesystems/remote"
import { replacePathStartWithFromAndTo, pathIncludesDotFile, normalizeLastModifiedMsForComparison } from "../utils"

export type Delta = { path: string } & (
	| {
			type: "uploadFile"
			size: number
			md5Hash?: string
	  }
	| {
			type: "createRemoteDirectory"
	  }
	| {
			type: "createLocalDirectory"
	  }
	| {
			type: "deleteLocalFile"
	  }
	| {
			type: "deleteRemoteFile"
	  }
	| {
			type: "deleteLocalDirectory"
	  }
	| {
			type: "deleteRemoteDirectory"
	  }
	| {
			type: "downloadFile"
			size: number
	  }
	| {
			type: "renameLocalFile"
			from: string
			to: string
	  }
	| {
			type: "renameRemoteFile"
			from: string
			to: string
	  }
	| {
			type: "renameRemoteDirectory"
			from: string
			to: string
	  }
	| {
			type: "renameLocalDirectory"
			from: string
			to: string
	  }
)

/**
 * Collapses child rename/move/delete deltas into the parent-directory delta that already covers them.
 *
 * When a directory is renamed or deleted, the tree diff also emits a delta for every descendant (each
 * child's path changed too). Executing all of them is wasteful — the parent op already moves or removes
 * the whole subtree — so each child is folded into its parent here, saving disk usage and API calls.
 *
 * Pure and side-effect free so it can be unit-tested directly against adversarial delta arrays. Two
 * correctness properties that the previous in-place version did NOT guarantee:
 *
 *   1. Most-specific parent wins. A child can sit under more than one renamed ancestor (e.g. both
 *      "/a" -> "/x" and "/a/b" -> "/x/y" cover "/a/b/c.txt"). The longest-`from` ancestor is the
 *      immediate enclosing renamed directory, and its `to` already reflects every outer rename — so
 *      applying ONLY that one yields the correct post-rename source. Composing every match in array
 *      order (the old loop) was order-dependent and could mis-compose.
 *   2. No neighbour corruption. We build a fresh array instead of splicing the input while iterating.
 *      The old loop spliced `deltas[i]` in place, so a removal shifted an unrelated delta into slot `i`
 *      that a later iteration could overwrite — silently dropping a real op and leaving a bogus one.
 */
export function collapseDeltas({
	deltas,
	renamedLocalDirectories,
	renamedRemoteDirectories,
	deletedLocalDirectories,
	deletedRemoteDirectories
}: {
	deltas: Delta[]
	renamedLocalDirectories: Delta[]
	renamedRemoteDirectories: Delta[]
	deletedLocalDirectories: Delta[]
	deletedRemoteDirectories: Delta[]
}): Delta[] {
	const collapsed: Delta[] = []

	for (const delta of deltas) {
		if (delta.type === "renameLocalDirectory" || delta.type === "renameLocalFile") {
			let parent: Extract<Delta, { type: "renameLocalDirectory" }> | undefined

			for (const directoryDelta of renamedLocalDirectories) {
				if (
					directoryDelta.type === "renameLocalDirectory" &&
					delta.from.startsWith(directoryDelta.from + "/") &&
					(!parent || directoryDelta.from.length > parent.from.length)
				) {
					parent = directoryDelta
				}
			}

			if (parent) {
				const newFromPath = replacePathStartWithFromAndTo(delta.from, parent.from, parent.to)

				// Equal to the target => the parent rename already lands the child here, so it is redundant.
				if (newFromPath !== delta.to) {
					collapsed.push({ ...delta, from: newFromPath })
				}

				continue
			}
		} else if (delta.type === "renameRemoteDirectory" || delta.type === "renameRemoteFile") {
			let parent: Extract<Delta, { type: "renameRemoteDirectory" }> | undefined

			for (const directoryDelta of renamedRemoteDirectories) {
				if (
					directoryDelta.type === "renameRemoteDirectory" &&
					delta.from.startsWith(directoryDelta.from + "/") &&
					(!parent || directoryDelta.from.length > parent.from.length)
				) {
					parent = directoryDelta
				}
			}

			if (parent) {
				const newFromPath = replacePathStartWithFromAndTo(delta.from, parent.from, parent.to)

				if (newFromPath !== delta.to) {
					collapsed.push({ ...delta, from: newFromPath })
				}

				continue
			}
		} else if (delta.type === "deleteLocalDirectory" || delta.type === "deleteLocalFile") {
			if (
				deletedLocalDirectories.some(
					directoryDelta => directoryDelta.type === "deleteLocalDirectory" && delta.path.startsWith(directoryDelta.path + "/")
				)
			) {
				continue
			}
		} else if (delta.type === "deleteRemoteDirectory" || delta.type === "deleteRemoteFile") {
			if (
				deletedRemoteDirectories.some(
					directoryDelta => directoryDelta.type === "deleteRemoteDirectory" && delta.path.startsWith(directoryDelta.path + "/")
				)
			) {
				continue
			}
		}

		collapsed.push(delta)
	}

	return collapsed
}

/**
 * Deltas
 * @date 3/1/2024 - 11:11:32 PM
 *
 * @export
 * @class Deltas
 * @typedef {Deltas}
 */
export class Deltas {
	private readonly sync: Sync

	/**
	 * Creates an instance of Deltas.
	 *
	 * @constructor
	 * @public
	 * @param {Sync} sync
	 */
	public constructor(sync: Sync) {
		this.sync = sync
	}

	/**
	 * Process the directory trees and return all sync deltas.
	 *
	 * @public
	 * @async
	 * @param {{
	 * 		currentLocalTree: LocalTree
	 * 		currentRemoteTree: RemoteTree
	 * 		previousLocalTree: LocalTree
	 * 		previousRemoteTree: RemoteTree
	 * 		currentLocalTreeErrors: LocalTreeError[]
	 * 	}} param0
	 * @param {LocalTree} param0.currentLocalTree
	 * @param {RemoteTree} param0.currentRemoteTree
	 * @param {LocalTree} param0.previousLocalTree
	 * @param {RemoteTree} param0.previousRemoteTree
	 * @param {{}} param0.currentLocalTreeErrors
	 * @returns {Promise<{
	 * 		deltas: Delta[],
	 * 		deleteLocalDirectoryCountRaw: number
	 * 		deleteLocalFileCountRaw: number
	 * 		deleteRemoteDirectoryCountRaw: number
	 * 		deleteRemoteFileCountRaw: number
	 * 	}>}
	 */
	public async process({
		currentLocalTree,
		currentRemoteTree,
		previousLocalTree,
		previousRemoteTree,
		currentLocalTreeErrors,
		currentLocalTreeIgnored
	}: {
		currentLocalTree: LocalTree
		currentRemoteTree: RemoteTree
		previousLocalTree: LocalTree
		previousRemoteTree: RemoteTree
		currentLocalTreeErrors: LocalTreeError[]
		currentLocalTreeIgnored: LocalTreeIgnored[]
	}): Promise<{
		deltas: Delta[]
		deleteLocalDirectoryCountRaw: number
		deleteLocalFileCountRaw: number
		deleteRemoteDirectoryCountRaw: number
		deleteRemoteFileCountRaw: number
	}> {
		if (this.sync.removed) {
			return {
				deltas: [],
				deleteLocalDirectoryCountRaw: 0,
				deleteLocalFileCountRaw: 0,
				deleteRemoteDirectoryCountRaw: 0,
				deleteRemoteFileCountRaw: 0
			}
		}

		let deltas: Delta[] = []
		const pathsAdded: Record<string, boolean> = {}
		const erroredLocalPaths: Record<string, boolean> = {}
		const ignoredLocalPaths: Record<string, boolean> = {}
		const renamedRemoteDirectories: Delta[] = []
		const renamedLocalDirectories: Delta[] = []
		const deletedRemoteDirectories: Delta[] = []
		const deletedLocalDirectories: Delta[] = []
		let deleteLocalDirectoryCountRaw = 0
		let deleteLocalFileCountRaw = 0
		let deleteRemoteDirectoryCountRaw = 0
		let deleteRemoteFileCountRaw = 0

		for (const error of currentLocalTreeErrors) {
			erroredLocalPaths[error.relativePath] = true
		}

		// A path that physically exists locally but is currently NOT syncable — a symlink, an
		// unreadable/permission-denied entry, a case-insensitive duplicate, a special device, an
		// over-long name — is recorded as "ignored", never as a deletion. Suppressing remote-deletes for
		// these preserves the cloud copy of a path that was synced before it became ignored (e.g. a file
		// now skipped because it is a symlink after upgrading to lstat), mirroring how the .filenignore
		// filter below already protects ignored paths. (BUG-006)
		for (const ignored of currentLocalTreeIgnored) {
			ignoredLocalPaths[ignored.relativePath] = true
		}

		// The order of delta processing:
		// 1. Local directory/file move/rename
		// 2. Remote directory/file move/rename
		// 3. Local deletions
		// 4. Remote deletions
		// 5. Local additions/filemodifications
		// 6. Remote additions/filemodifications

		// Local file/directory move/rename
		if (this.sync.mode === "twoWay" || this.sync.mode === "localBackup" || this.sync.mode === "localToCloud") {
			for (const inode in currentLocalTree.inodes) {
				const currentItem = currentLocalTree.inodes[inode]
				const previousItem = previousLocalTree.inodes[inode]

				if (
					!currentItem ||
					!previousItem ||
					pathsAdded[currentItem.path] ||
					pathsAdded[previousItem.path] ||
					erroredLocalPaths[currentItem.path] ||
					erroredLocalPaths[previousItem.path]
				) {
					continue
				}

				// Path from current item changed, it was either renamed or moved (same type)
				if (
					currentItem.path !== previousItem.path &&
					currentItem.type === previousItem.type &&
					// Does an item with the same path and type already exist in the current remote tree (probably moved by something else prior)?
					!(currentRemoteTree.tree[currentItem.path] && currentRemoteTree.tree[currentItem.path]!.type === currentItem.type) &&
					// Because only comparing strings can be weird sometimes
					Buffer.from(currentItem.path, "utf-8").toString("hex") !== Buffer.from(previousItem.path, "utf-8").toString("hex")
				) {
					const delta: Delta = {
						type: currentItem.type === "directory" ? "renameRemoteDirectory" : "renameRemoteFile",
						path: currentItem.path,
						from: previousItem.path,
						to: currentItem.path
					}

					deltas.push(delta)

					if (currentItem.type === "directory") {
						renamedRemoteDirectories.push(delta)
					}

					pathsAdded[currentItem.path] = true
					pathsAdded[previousItem.path] = true
				}
			}
		}

		// Remote file/directory move/rename
		if (this.sync.mode === "twoWay" || this.sync.mode === "cloudBackup" || this.sync.mode === "cloudToLocal") {
			for (const uuid in currentRemoteTree.uuids) {
				const currentItem = currentRemoteTree.uuids[uuid]
				const previousItem = previousRemoteTree.uuids[uuid]

				if (!currentItem || !previousItem || pathsAdded[currentItem.path] || pathsAdded[previousItem.path]) {
					continue
				}

				// Path from current item changed, it was either renamed or moved (same type)
				if (
					currentItem.path !== previousItem.path &&
					currentItem.type === previousItem.type &&
					// Does an item with the same path and type already exist in the current local tree (probably moved by something else prior)?
					!(currentLocalTree.tree[currentItem.path] && currentLocalTree.tree[currentItem.path]!.type === currentItem.type) &&
					// Because only comparing strings can be weird sometimes
					Buffer.from(currentItem.path, "utf-8").toString("hex") !== Buffer.from(previousItem.path, "utf-8").toString("hex")
				) {
					const delta: Delta = {
						type: currentItem.type === "directory" ? "renameLocalDirectory" : "renameLocalFile",
						path: currentItem.path,
						from: previousItem.path,
						to: currentItem.path
					}

					deltas.push(delta)

					if (currentItem.type === "directory") {
						renamedLocalDirectories.push(delta)
					}

					pathsAdded[currentItem.path] = true
					pathsAdded[previousItem.path] = true
				}
			}
		}

		// Local deletions
		if (this.sync.mode === "twoWay" || this.sync.mode === "localToCloud") {
			if (this.sync.mode === "twoWay") {
				for (const path in previousLocalTree.tree) {
					if (pathsAdded[path] || erroredLocalPaths[path] || ignoredLocalPaths[path]) {
						continue
					}

					const previousLocalItem = previousLocalTree.tree[path]
					const currentLocalItem = currentLocalTree.tree[path]

					// If the item does not exist in the current tree but does in the previous one, it has been deleted.
					// We also check if the previous inode does not exist in the current tree, and if so, we skip it (only in cloud -> local modes. It should always be deleted in local -> cloud modes if it exists remotely).
					if (
						!currentLocalItem &&
						previousLocalItem //&&
						//(this.sync.mode !== "localToCloud" ? !currentLocalTree.inodes[previousLocalItem.inode] : true)
					) {
						const delta: Delta = {
							type: previousLocalItem.type === "directory" ? "deleteRemoteDirectory" : "deleteRemoteFile",
							path
						}

						deltas.push(delta)

						if (previousLocalItem.type === "directory") {
							deletedRemoteDirectories.push(delta)

							deleteRemoteDirectoryCountRaw += 1
						} else {
							deleteRemoteFileCountRaw += 1
						}

						pathsAdded[path] = true
						pathsAdded[previousLocalItem.path] = true
					}
				}
			} else {
				for (const path in currentRemoteTree.tree) {
					if (pathsAdded[path] || erroredLocalPaths[path] || ignoredLocalPaths[path]) {
						continue
					}

					const currentLocalItem = currentLocalTree.tree[path]
					const currentRemoteItem = currentRemoteTree.tree[path]

					// If the item does not exist in the current local tree but does in the remote one, it needs to be deleted remotely in localToCloud mode.
					if (!currentLocalItem && currentRemoteItem) {
						const delta: Delta = {
							type: currentRemoteItem.type === "directory" ? "deleteRemoteDirectory" : "deleteRemoteFile",
							path
						}

						deltas.push(delta)

						if (currentRemoteItem.type === "directory") {
							deletedRemoteDirectories.push(delta)

							deleteRemoteDirectoryCountRaw += 1
						} else {
							deleteRemoteFileCountRaw += 1
						}

						pathsAdded[path] = true
					}
				}
			}
		}

		// Remote deletions
		if (this.sync.mode === "twoWay" || this.sync.mode === "cloudToLocal") {
			if (this.sync.mode === "twoWay") {
				for (const path in previousRemoteTree.tree) {
					if (pathsAdded[path]) {
						continue
					}

					const previousRemoteItem = previousRemoteTree.tree[path]
					const currentRemoteItem = currentRemoteTree.tree[path]

					// If the item does not exist in the current tree but does in the previous one, it has been deleted.
					// We also check if the previous UUID does not exist in the current tree, and if so, we skip it (only in local -> cloud modes. It should always be deleted in cloud -> local modes if it exists locally).
					if (
						!currentRemoteItem &&
						previousRemoteItem //&&
						//(this.sync.mode !== "cloudToLocal" ? !currentRemoteTree.uuids[previousRemoteItem.uuid] : true)
					) {
						const delta: Delta = {
							type: previousRemoteItem.type === "directory" ? "deleteLocalDirectory" : "deleteLocalFile",
							path
						}

						deltas.push(delta)

						if (previousRemoteItem.type === "directory") {
							deletedLocalDirectories.push(delta)

							deleteLocalDirectoryCountRaw += 1
						} else {
							deleteLocalFileCountRaw += 1
						}

						pathsAdded[path] = true
						pathsAdded[previousRemoteItem.path] = true
					}
				}
			} else {
				for (const path in currentLocalTree.tree) {
					if (pathsAdded[path]) {
						continue
					}

					const currentLocalItem = currentLocalTree.tree[path]
					const currentRemoteItem = currentRemoteTree.tree[path]

					// If the item does not exist in the current remote tree but does in the local one, it needs to be deleted locally in cloudToLocal mode.
					if (!currentRemoteItem && currentLocalItem) {
						const delta: Delta = {
							type: currentLocalItem.type === "directory" ? "deleteLocalDirectory" : "deleteLocalFile",
							path
						}

						deltas.push(delta)

						if (currentLocalItem.type === "directory") {
							deletedLocalDirectories.push(delta)

							deleteLocalDirectoryCountRaw += 1
						} else {
							deleteLocalFileCountRaw += 1
						}

						pathsAdded[path] = true
					}
				}
			}
		}

		// Type change at a path (file <-> directory). The path exists in BOTH current trees but as
		// different types, so it slips through every other pass: the rename passes need a matching
		// inode/uuid (a type change has neither), the deletion passes need the path ABSENT on the other
		// side (here it is present, only a different type), and the addition passes skip a path whose
		// other-side item already exists. Left unhandled, the stale-type item lingers and its replacement
		// cannot be created over it (E2E-BUG-001).
		//
		// We attribute the change against the last-synced base: whichever side's type differs from the
		// base is the one that changed. In twoWay, if both changed (or neither is in the base) local wins,
		// matching the tie policy used elsewhere; directional modes force the authoritative side. The
		// authoritative side's new item is created and the other side's stale item is deleted — the
		// phase-ordered task runner always runs deletes before creates, so the delete lands first. When
		// the deleted (stale) side is a directory, its descendants are marked "added" so the addition
		// passes don't try to sync now-obsolete children; the recursive delete removes them (and any
		// child-delete deltas already emitted collapse into the parent). The surviving side's descendants
		// stay unmarked and sync normally.
		{
			const canWriteRemote =
				this.sync.mode === "twoWay" || this.sync.mode === "localBackup" || this.sync.mode === "localToCloud"
			const canWriteLocal =
				this.sync.mode === "twoWay" || this.sync.mode === "cloudBackup" || this.sync.mode === "cloudToLocal"
			const markSubtreeAdded = (treePaths: Record<string, unknown>, parentPath: string): void => {
				const prefix = `${parentPath}/`

				for (const descendantPath in treePaths) {
					if (descendantPath.startsWith(prefix)) {
						pathsAdded[descendantPath] = true
					}
				}
			}

			for (const path in currentLocalTree.tree) {
				if (pathsAdded[path] || erroredLocalPaths[path] || ignoredLocalPaths[path]) {
					continue
				}

				const currentLocalItem = currentLocalTree.tree[path]
				const currentRemoteItem = currentRemoteTree.tree[path]

				if (!currentLocalItem || !currentRemoteItem || currentLocalItem.type === currentRemoteItem.type) {
					continue
				}

				// Both sides have this path, with different types. Attribute the change against the base.
				const previousLocalItem = previousLocalTree.tree[path]
				const previousRemoteItem = previousRemoteTree.tree[path]
				const localChangedType = !previousLocalItem || previousLocalItem.type !== currentLocalItem.type
				const remoteChangedType = !previousRemoteItem || previousRemoteItem.type !== currentRemoteItem.type

				let localWins: boolean

				if (this.sync.mode === "localBackup" || this.sync.mode === "localToCloud") {
					localWins = true
				} else if (this.sync.mode === "cloudBackup" || this.sync.mode === "cloudToLocal") {
					localWins = false
				} else {
					// twoWay: whoever's type diverged from base wins; local wins a tie / a both-changed conflict.
					localWins = localChangedType || !remoteChangedType
				}

				if (localWins && canWriteRemote) {
					const deleteDelta: Delta = {
						type: currentRemoteItem.type === "directory" ? "deleteRemoteDirectory" : "deleteRemoteFile",
						path
					}

					deltas.push(deleteDelta)

					if (currentRemoteItem.type === "directory") {
						deletedRemoteDirectories.push(deleteDelta)

						deleteRemoteDirectoryCountRaw += 1

						markSubtreeAdded(currentRemoteTree.tree, path)
					} else {
						deleteRemoteFileCountRaw += 1
					}

					deltas.push(
						currentLocalItem.type === "directory"
							? { type: "createRemoteDirectory", path }
							: { type: "uploadFile", path, size: currentLocalItem.size }
					)

					pathsAdded[path] = true
				} else if (!localWins && canWriteLocal) {
					const deleteDelta: Delta = {
						type: currentLocalItem.type === "directory" ? "deleteLocalDirectory" : "deleteLocalFile",
						path
					}

					deltas.push(deleteDelta)

					if (currentLocalItem.type === "directory") {
						deletedLocalDirectories.push(deleteDelta)

						deleteLocalDirectoryCountRaw += 1

						markSubtreeAdded(currentLocalTree.tree, path)
					} else {
						deleteLocalFileCountRaw += 1
					}

					deltas.push(
						currentRemoteItem.type === "directory"
							? { type: "createLocalDirectory", path }
							: { type: "downloadFile", path, size: currentRemoteItem.size }
					)

					pathsAdded[path] = true
				}
			}
		}

		// Local additions/fileModifications
		if (this.sync.mode === "twoWay" || this.sync.mode === "localBackup" || this.sync.mode === "localToCloud") {
			for (const path in currentLocalTree.tree) {
				if (pathsAdded[path] || erroredLocalPaths[path]) {
					continue
				}

				const currentLocalItem = currentLocalTree.tree[path]
				const currentRemoteItem = currentRemoteTree.tree[path]

				// If the item does not exist in the current remote tree, but does in the local one, it should be uploaded.
				// We also check if it in fact has existed before (the inode), if so, we skip it (only in cloud -> local modes. It should always be uploaded in local -> cloud modes if it does not exist remotely).
				if (
					!currentRemoteItem &&
					currentLocalItem &&
					//(this.sync.mode !== "localBackup" && this.sync.mode !== "localToCloud"
					//	? !previousLocalTree.inodes[currentLocalItem.inode]
					//	: true) &&
					// Does an item with the same path and type already exist in the current remote tree (probably uploaded by something else prior)?
					!(currentRemoteTree.tree[path] && currentRemoteTree.tree[path]!.type === currentLocalItem.type)
				) {
					deltas.push({
						type: currentLocalItem.type === "directory" ? "createRemoteDirectory" : "uploadFile",
						path,
						size: currentLocalItem.size
					})

					pathsAdded[path] = true

					continue
				}

				// If the item exists in both trees and the local copy changed since the last sync, upload it.
				// The change is attributed against the last-synced BASE (previousLocalTree) by size + whole-
				// second mtime — not by comparing the two current sides — so an edit that lands in the same
				// whole-second as the base mtime, or that only changes the size (e.g. 0 -> N bytes), is still
				// detected (E2E-OBS-002). The remote side's change is detected by a new uuid (every re-upload
				// mints one). On a both-changed conflict the newer mtime wins; an unorderable same-second tie
				// resolves to local because this pass runs before the download pass and marks the path added.
				// The md5 comparison stays as an OPTIONAL dedup (so a pure mtime touch with identical bytes is
				// not re-uploaded) — never a required signal, since older files carry no stored hash.
				if (currentRemoteItem && currentRemoteItem.type === "file" && currentLocalItem && currentLocalItem.type === "file") {
					const previousLocalItem = previousLocalTree.tree[path]
					const previousRemoteItem = previousRemoteTree.tree[path]
					// With a persisted base, attribute the change against it (size + whole-second mtime). With
					// NO base — a genuine first sync, or lost/corrupt state — there is no common ancestor, so
					// the remote copy is the only reference: fall back to the side-vs-side comparison and treat
					// the file as changed only when the local copy is strictly newer (otherwise identical
					// content on both sides would be needlessly re-uploaded). OBS-002's same-second case
					// requires a base, so this fallback cannot reintroduce it.
					const localChanged = previousLocalItem
						? previousLocalItem.size !== currentLocalItem.size ||
							normalizeLastModifiedMsForComparison(previousLocalItem.lastModified) !==
								normalizeLastModifiedMsForComparison(currentLocalItem.lastModified)
						: normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) >
							normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified)
					const remoteChanged = !previousRemoteItem || currentRemoteItem.uuid !== previousRemoteItem.uuid
					const localWins =
						!remoteChanged ||
						normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) >=
							normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified)

					if (localChanged && localWins) {
						const md5Hash = await this.sync.localFileSystem.createFileHash({
							relativePath: path,
							algorithm: "md5"
						})

						if (md5Hash !== this.sync.localFileHashes[currentLocalItem.path]) {
							deltas.push({
								type: "uploadFile",
								path,
								size: currentLocalItem.size,
								md5Hash
							})

							pathsAdded[path] = true
						}
					}
				}
			}
		}

		// Remote additions/changes
		if (this.sync.mode === "twoWay" || this.sync.mode === "cloudBackup" || this.sync.mode === "cloudToLocal") {
			for (const path in currentRemoteTree.tree) {
				if (pathsAdded[path]) {
					continue
				}

				const currentLocalItem = currentLocalTree.tree[path]
				const currentRemoteItem = currentRemoteTree.tree[path]

				// If the item does not exist in the current local tree, but does in the remote one, it should be downloaded.
				// We also check if it in fact has existed before (the UUID), if so, we skip it (only in local -> cloud modes. It should always be downloaded in cloud -> local modes if it does not exist locally).
				if (
					!currentLocalItem &&
					currentRemoteItem &&
					//(this.sync.mode !== "cloudBackup" && this.sync.mode !== "cloudToLocal"
					//	? !previousRemoteTree.uuids[currentRemoteItem.uuid]
					//	: true) &&
					// Does an item with the same path and type already exist in the current local tree (probably downloaded by something else prior)?
					!(currentLocalTree.tree[path] && currentLocalTree.tree[path]!.type === currentRemoteItem.type)
				) {
					deltas.push({
						type: currentRemoteItem.type === "directory" ? "createLocalDirectory" : "downloadFile",
						path,
						size: currentRemoteItem.size
					})

					pathsAdded[path] = true

					continue
				}

				const previousRemoteItem = previousRemoteTree.tree[path]

				// If the item exists in both trees and the mod time changed, we download it.
				if (
					currentRemoteItem &&
					currentRemoteItem.type === "file" &&
					currentLocalItem &&
					previousRemoteItem &&
					normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified) >
						normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) &&
					currentRemoteItem.uuid !== previousRemoteItem.uuid
				) {
					deltas.push({
						type: "downloadFile",
						path,
						size: currentRemoteItem.size
					})

					pathsAdded[path] = true
				}
			}
		}

		// Work on deltas from "left to right" (ascending order, path length).
		deltas = deltas
			.sort((a, b) => a.path.split("/").length - b.path.split("/").length)
			// Filter by ignored paths
			.filter(delta => {
				const trailingSlash =
					delta.type === "renameLocalDirectory" ||
					delta.type === "createLocalDirectory" ||
					delta.type === "createRemoteDirectory" ||
					delta.type === "deleteLocalDirectory" ||
					delta.type === "renameRemoteDirectory" ||
					delta.type === "deleteRemoteDirectory"
						? "/"
						: ""

				if (
					delta.type === "renameLocalDirectory" ||
					delta.type === "renameLocalFile" ||
					delta.type === "renameRemoteDirectory" ||
					delta.type === "renameRemoteFile"
				) {
					if (this.sync.excludeDotFiles && (pathIncludesDotFile(delta.from) || pathIncludesDotFile(delta.to))) {
						return false
					}

					if (this.sync.ignorer.ignores(delta.from + trailingSlash) || this.sync.ignorer.ignores(delta.to + trailingSlash)) {
						return false
					}
				} else {
					if (this.sync.excludeDotFiles && pathIncludesDotFile(delta.path)) {
						return false
					}

					if (this.sync.ignorer.ignores(delta.path + trailingSlash)) {
						return false
					}
				}

				return true
			})

		// Here we apply the "done" task to the delta state.
		// E.g. when the user renames/moves a directory from "/sync/dir" to "/sync/dir2"
		// we'll get all the rename/move deltas for the directory children aswell.
		// This is pretty unnecessary, hence we filter them here.
		// Same for deletions. We only ever need to rename/move/delete the parent directory if the children did not change.
		// This saves a lot of disk usage and API requests. This also saves time applying all done tasks to the overall state,
		// since we need to loop through less doneTasks. See collapseDeltas for the correctness properties.
		const collapsedDeltas = collapseDeltas({
			deltas,
			renamedLocalDirectories,
			renamedRemoteDirectories,
			deletedLocalDirectories,
			deletedRemoteDirectories
		})

		// Work on deltas from "left to right" (ascending order, path length).
		return {
			deltas: collapsedDeltas.sort((a, b) => a.path.split("/").length - b.path.split("/").length),
			deleteLocalDirectoryCountRaw,
			deleteLocalFileCountRaw,
			deleteRemoteDirectoryCountRaw,
			deleteRemoteFileCountRaw
		}
	}
}

export default Deltas
