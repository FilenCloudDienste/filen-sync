import type Sync from "./sync"
import { type LocalTree, type LocalTreeError } from "./filesystems/local"
import { type RemoteTree } from "./filesystems/remote"
import { replacePathStartWithFromAndTo, pathIncludesDotFile, normalizeLastModifiedMsForComparison } from "../utils"

export type Delta = { path: string } & (
	| {
			type: "uploadFile"
			size: number
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
	 * 		previousRemoteTree: RemoteTree,
	 * 		currentLocalTreeErrors: LocalTreeError[]
	 * 	}} param0
	 * @param {LocalTree} param0.currentLocalTree
	 * @param {RemoteTree} param0.currentRemoteTree
	 * @param {LocalTree} param0.previousLocalTree
	 * @param {RemoteTree} param0.previousRemoteTree
	 * @param {{}} param0.currentLocalTreeErrors
	 * @returns {Promise<Delta[]>}
	 */
	public async process({
		currentLocalTree,
		currentRemoteTree,
		previousLocalTree,
		previousRemoteTree,
		currentLocalTreeErrors
	}: {
		currentLocalTree: LocalTree
		currentRemoteTree: RemoteTree
		previousLocalTree: LocalTree
		previousRemoteTree: RemoteTree
		currentLocalTreeErrors: LocalTreeError[]
	}): Promise<Delta[]> {
		if (this.sync.removed) {
			return []
		}

		let deltas: Delta[] = []
		const pathsAdded: Record<string, boolean> = {}
		const erroredLocalPaths: Record<string, boolean> = {}
		const renamedRemoteDirectories: Delta[] = []
		const renamedLocalDirectories: Delta[] = []
		const deletedRemoteDirectories: Delta[] = []
		const deletedLocalDirectories: Delta[] = []

		for (const error of currentLocalTreeErrors) {
			erroredLocalPaths[error.relativePath] = true
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
			for (const path in previousLocalTree.tree) {
				if (pathsAdded[path] || erroredLocalPaths[path]) {
					continue
				}

				const previousLocalItem = previousLocalTree.tree[path]
				const currentLocalItem = currentLocalTree.tree[path]

				// If the item does not exist in the current tree but does in the previous one, it has been deleted.
				// We also check if the previous inode does not exist in the current tree, and if so, we skip it (only in cloud -> local modes. It should always be deleted in local -> cloud modes if it exists remotely).
				if (
					!currentLocalItem &&
					previousLocalItem &&
					(this.sync.mode !== "localToCloud" ? !currentLocalTree.inodes[previousLocalItem.inode] : true)
				) {
					const delta: Delta = {
						type: previousLocalItem.type === "directory" ? "deleteRemoteDirectory" : "deleteRemoteFile",
						path
					}

					deltas.push(delta)

					if (previousLocalItem.type === "directory") {
						deletedRemoteDirectories.push(delta)
					}

					pathsAdded[path] = true
					pathsAdded[previousLocalItem.path] = true
				}
			}
		}

		// Remote deletions

		if (this.sync.mode === "twoWay" || this.sync.mode === "cloudToLocal") {
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
					previousRemoteItem &&
					(this.sync.mode !== "cloudToLocal" ? !currentRemoteTree.uuids[previousRemoteItem.uuid] : true)
				) {
					const delta: Delta = {
						type: previousRemoteItem.type === "directory" ? "deleteLocalDirectory" : "deleteLocalFile",
						path
					}

					deltas.push(delta)

					if (previousRemoteItem.type === "directory") {
						deletedLocalDirectories.push(delta)
					}

					pathsAdded[path] = true
					pathsAdded[previousRemoteItem.path] = true
				}
			}
		}

		// Local additions/filemodifications

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
					(this.sync.mode !== "localBackup" && this.sync.mode !== "localToCloud"
						? !previousLocalTree.inodes[currentLocalItem.inode]
						: true) &&
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

				// If the item exists in both trees and has a different mod time + hash, we upload it again.
				if (
					currentRemoteItem &&
					currentRemoteItem.type === "file" &&
					currentLocalItem &&
					currentLocalItem.type === "file" &&
					normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) >
						normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified) &&
					(await this.sync.localFileSystem.createFileHash({
						relativePath: path,
						algorithm: "md5"
					})) !== this.sync.localFileHashes[currentLocalItem.path]
				) {
					deltas.push({
						type: "uploadFile",
						path,
						size: currentLocalItem.size
					})

					pathsAdded[path] = true
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
					(this.sync.mode !== "cloudBackup" && this.sync.mode !== "cloudToLocal"
						? !previousRemoteTree.uuids[currentRemoteItem.uuid]
						: true) &&
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
				if (
					delta.type === "renameLocalDirectory" ||
					delta.type === "renameLocalFile" ||
					delta.type === "renameRemoteDirectory" ||
					delta.type === "renameRemoteFile"
				) {
					if (this.sync.excludeDotFiles && (pathIncludesDotFile(delta.from) || pathIncludesDotFile(delta.to))) {
						return false
					}

					if (this.sync.ignorer.ignores(delta.from) || this.sync.ignorer.ignores(delta.to)) {
						return false
					}
				} else {
					if (this.sync.excludeDotFiles && pathIncludesDotFile(delta.path)) {
						return false
					}

					if (this.sync.ignorer.ignores(delta.path)) {
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
		// since we need to loop through less doneTasks.
		for (let i = 0; i < deltas.length; i++) {
			const delta = deltas[i]!
			let moveUp = false

			if (delta.type === "renameLocalDirectory" || delta.type === "renameLocalFile") {
				for (const directoryDelta of renamedLocalDirectories) {
					if (directoryDelta.type === "renameLocalDirectory" && delta.from.startsWith(directoryDelta.from + "/")) {
						const newFromPath = replacePathStartWithFromAndTo(delta.from, directoryDelta.from, directoryDelta.to)

						if (newFromPath === delta.to) {
							deltas.splice(i, 1)

							moveUp = true
						} else {
							deltas.splice(i, 1, {
								...delta,
								from: newFromPath
							})
						}
					}
				}
			} else if (delta.type === "renameRemoteDirectory" || delta.type === "renameRemoteFile") {
				for (const directoryDelta of renamedRemoteDirectories) {
					if (directoryDelta.type === "renameRemoteDirectory" && delta.from.startsWith(directoryDelta.from + "/")) {
						const newFromPath = replacePathStartWithFromAndTo(delta.from, directoryDelta.from, directoryDelta.to)

						if (newFromPath === delta.to) {
							deltas.splice(i, 1)

							moveUp = true
						} else {
							deltas.splice(i, 1, {
								...delta,
								from: newFromPath
							})
						}
					}
				}
			} else if (delta.type === "deleteLocalDirectory" || delta.type === "deleteLocalFile") {
				for (const directoryDelta of deletedLocalDirectories) {
					if (directoryDelta.type === "deleteLocalDirectory" && delta.path.startsWith(directoryDelta.path + "/")) {
						deltas.splice(i, 1)

						moveUp = true
					}
				}
			} else if (delta.type === "deleteRemoteDirectory" || delta.type === "deleteRemoteFile") {
				for (const directoryDelta of deletedRemoteDirectories) {
					if (directoryDelta.type === "deleteRemoteDirectory" && delta.path.startsWith(directoryDelta.path + "/")) {
						deltas.splice(i, 1)

						moveUp = true
					}
				}
			}

			if (moveUp) {
				i--
			}
		}

		return deltas
	}
}

export default Deltas
