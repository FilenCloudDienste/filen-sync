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
					// Only propagate the rename if the REMOTE source is unchanged since the base — the same
					// node (uuid) still sits at the old path. If the other side deleted, modified, or renamed
					// that file/directory in the same window, renaming the stale remote node is invalid: skip
					// it, leave the paths unmarked, and let the renamed item be re-added under its new name
					// while the other side's change is applied by its own pass. The worlds still converge,
					// keeping both edits rather than silently dropping one. (F2–F4)
					const remoteSource = currentRemoteTree.tree[previousItem.path]
					const baseRemoteSource = previousRemoteTree.tree[previousItem.path]
					const remoteSourceUnchanged = !!remoteSource && !!baseRemoteSource && remoteSource.uuid === baseRemoteSource.uuid

					if (!remoteSourceUnchanged) {
						continue
					}

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

					// Rename + in-place content modify of the SAME file in ONE cycle: the rename marks the new
					// path "added", so the modification pass below would skip it and the new bytes would never
					// upload (the remote would keep the OLD content under the new name, forever). Detect the
					// content change here against the base and emit the upload too; phase order runs the rename
					// (phase 4) before the upload (phase 11), so it lands on the renamed remote node. (F1)
					if (currentItem.type === "file") {
						const contentChanged =
							currentItem.size !== previousItem.size ||
							normalizeLastModifiedMsForComparison(currentItem.lastModified) !==
								normalizeLastModifiedMsForComparison(previousItem.lastModified)

						if (contentChanged) {
							deltas.push({
								type: "uploadFile",
								path: currentItem.path,
								size: currentItem.size
							})
						}
					}
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
					// Symmetric to the local rename pass: only propagate the remote rename if the LOCAL source
					// is unchanged since the base — same inode AND (for files) same content. A remote modify
					// mints a new uuid, but a LOCAL modify keeps the inode, so checking the inode alone would
					// let a remote rename fire over a file the user edited in the same window and silently drop
					// that edit. If the local side deleted, modified, or renamed it, skip the rename and let
					// the file be handled by the deletion/addition passes → convergence, keeping both. (F2–F4)
					const localSource = currentLocalTree.tree[previousItem.path]
					const baseLocalSource = previousLocalTree.tree[previousItem.path]
					const localSourceUnchanged =
						!!localSource &&
						!!baseLocalSource &&
						localSource.inode === baseLocalSource.inode &&
						(currentItem.type === "directory" ||
							(localSource.size === baseLocalSource.size &&
								normalizeLastModifiedMsForComparison(localSource.lastModified) ===
									normalizeLastModifiedMsForComparison(baseLocalSource.lastModified)))

					if (!localSourceUnchanged) {
						continue
					}

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
						// Symmetric to the remote-deletions resurrect (OBS-001): the local copy was deleted, but
						// if the REMOTE file was modified since the base — a new uuid, i.e. a real re-upload — the
						// newer modification wins over the delete. Skip the delete and leave the path unmarked so
						// the remote-additions pass downloads (resurrects) it locally. A newer modify always beats
						// a delete, in either direction. (F7)
						if (previousLocalItem.type === "file") {
							const previousRemoteItem = previousRemoteTree.tree[path]
							const currentRemoteItem = currentRemoteTree.tree[path]

							if (
								currentRemoteItem &&
								currentRemoteItem.type === "file" &&
								previousRemoteItem &&
								currentRemoteItem.uuid !== previousRemoteItem.uuid
							) {
								continue
							}
						}

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
						// E2E-OBS-001 (newer-modify-wins): the remote deleted this path, but if the local FILE
						// was modified since the last sync the modification wins — skip the delete and leave the
						// path unmarked so the local-additions pass re-uploads (resurrects) it remotely. "Modified"
						// requires a real CONTENT change: a size difference, or (same size, mtime moved) a cached
						// upload hash that no longer matches. A bare mtime touch — or a same-size change we cannot
						// confirm because no hash was stored — is NOT a modification, so the delete proceeds. The
						// hash is an optional signal (older files carry none).
						if (previousRemoteItem.type === "file") {
							const previousLocalItem = previousLocalTree.tree[path]
							const currentLocalItem = currentLocalTree.tree[path]

							if (currentLocalItem && currentLocalItem.type === "file" && previousLocalItem) {
								let localContentChanged = currentLocalItem.size !== previousLocalItem.size

								if (
									!localContentChanged &&
									normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) !==
										normalizeLastModifiedMsForComparison(previousLocalItem.lastModified)
								) {
									const cachedHash = this.sync.localFileHashes[currentLocalItem.path]

									if (cachedHash) {
										const currentHash = await this.sync.localFileSystem.createFileHash({
											relativePath: path,
											algorithm: "md5"
										})

										localContentChanged = currentHash !== cachedHash
									}
								}

								if (localContentChanged) {
									continue
								}
							}
						}

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
					// Directional push modes (localToCloud / localBackup): the LOCAL side is authoritative, so a
					// local change ALWAYS wins. The newer-mtime tiebreak is twoWay conflict resolution and must
					// not let a foreign remote edit (with a newer mtime) suppress the push. (F5)
					const directionalPush = this.sync.mode === "localToCloud" || this.sync.mode === "localBackup"
					const localWins =
						directionalPush ||
						!remoteChanged ||
						normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) >=
							normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified)

					// Strict mirror (localToCloud only): the remote MUST equal local. If the remote was edited
					// away from what we last pushed (a new uuid) — even when the local file itself is unchanged —
					// re-assert the local copy to revert that foreign edit, bypassing the md5 dedup below (local
					// bytes still equal the last upload, so the dedup would otherwise skip). localBackup is
					// additive and deliberately tolerates foreign edits, so it is excluded. (F6)
					const mirrorRevert = this.sync.mode === "localToCloud" && remoteChanged
					// Directional push with NO remote base: a stray remote file occupies a path local also has.
					// It cannot be the synced copy if the SIZES differ, so the authoritative local wins — push it
					// up over the stray. (F9, symmetric to the pull side.)
					const noBaseSizeDiverged = directionalPush && !previousRemoteItem && currentLocalItem.size !== currentRemoteItem.size

					if ((localChanged || mirrorRevert || noBaseSizeDiverged) && localWins) {
						const md5Hash = await this.sync.localFileSystem.createFileHash({
							relativePath: path,
							algorithm: "md5"
						})

						if (mirrorRevert || noBaseSizeDiverged || md5Hash !== this.sync.localFileHashes[currentLocalItem.path]) {
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

				// If the item exists in both trees and the remote copy changed since the base, download it.
				// This MIRRORS the local-additions modify branch. With a base the remote changed iff its uuid
				// changed (every re-upload mints one); with NO base — a fresh add-vs-add, or lost/corrupt state
				// — fall back to side-vs-side and treat it as changed only when the remote is strictly newer
				// (otherwise identical content on both sides would be needlessly downloaded). The local pass ran
				// first and claimed the path (pathsAdded) when local won; reaching here means the remote wins.
				// Without this no-base fallback an add-vs-add where the REMOTE is newer never converged. (F8)
				if (currentRemoteItem && currentRemoteItem.type === "file" && currentLocalItem && currentLocalItem.type === "file") {
					const previousLocalItem = previousLocalTree.tree[path]
					const remoteChanged = previousRemoteItem
						? currentRemoteItem.uuid !== previousRemoteItem.uuid
						: normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified) >
							normalizeLastModifiedMsForComparison(currentLocalItem.lastModified)
					// Directional pull modes (cloudToLocal / cloudBackup): the REMOTE side is authoritative, so a
					// remote change ALWAYS wins; the newer-mtime tiebreak is twoWay-only and must not let a
					// foreign local edit (with a newer mtime) suppress the pull. (F5)
					const directionalPull = this.sync.mode === "cloudToLocal" || this.sync.mode === "cloudBackup"
					const remoteWins =
						directionalPull ||
						!previousLocalItem ||
						normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified) >
							normalizeLastModifiedMsForComparison(currentLocalItem.lastModified)

					// Strict mirror (cloudToLocal only): local MUST equal remote. If the local copy was edited
					// away from what we last pulled (size or whole-second mtime differs from the base) — even when
					// the remote is unchanged — re-download to revert that foreign local edit. cloudBackup is
					// additive and deliberately tolerates local edits, so it is excluded. (F6)
					const localDiverged =
						!!previousLocalItem &&
						(previousLocalItem.size !== currentLocalItem.size ||
							normalizeLastModifiedMsForComparison(previousLocalItem.lastModified) !==
								normalizeLastModifiedMsForComparison(currentLocalItem.lastModified))
					const mirrorRevert = this.sync.mode === "cloudToLocal" && localDiverged
					// Directional pull with NO local base: a stray local file occupies a path the remote also has
					// (e.g. the local copy was deleted then re-created with different content). It cannot be the
					// synced copy if the SIZES differ, so the authoritative remote wins — pull it down. (F9)
					const noBaseSizeDiverged = directionalPull && !previousLocalItem && currentLocalItem.size !== currentRemoteItem.size

					if ((remoteChanged || mirrorRevert || noBaseSizeDiverged) && remoteWins) {
						deltas.push({
							type: "downloadFile",
							path,
							size: currentRemoteItem.size
						})

						pathsAdded[path] = true
					}
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
