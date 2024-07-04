import type Sync from "./sync"
import { type LocalTree, type LocalTreeError } from "./filesystems/local"
import { type RemoteTree } from "./filesystems/remote"
import { replacePathStartWithFromAndTo } from "../utils"

export type Delta = { path: string } & (
	| {
			type: "uploadFile"
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
			if (currentItem.path !== previousItem.path && currentItem.type === previousItem.type) {
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

		// Remote file/directory move/rename

		for (const uuid in currentRemoteTree.uuids) {
			const currentItem = currentRemoteTree.uuids[uuid]
			const previousItem = previousRemoteTree.uuids[uuid]

			if (!currentItem || !previousItem || pathsAdded[currentItem.path] || pathsAdded[previousItem.path]) {
				continue
			}

			// Path from current item changed, it was either renamed or moved (same type)
			if (currentItem.path !== previousItem.path && currentItem.type === previousItem.type) {
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

		// Local deletions

		for (const path in previousLocalTree.tree) {
			if (pathsAdded[path] || erroredLocalPaths[path]) {
				continue
			}

			const previousLocalItem = previousLocalTree.tree[path]
			const currentLocalItem = currentLocalTree.tree[path]

			// If the item does not exist in the current tree but does in the previous one, it has been deleted.
			// We also check if the previous inode does not exist in the current tree.
			if (!currentLocalItem && previousLocalItem && !currentLocalTree.inodes[previousLocalItem.inode]) {
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

		// Remote deletions

		for (const path in previousRemoteTree.tree) {
			if (pathsAdded[path]) {
				continue
			}

			const previousRemoteItem = previousRemoteTree.tree[path]
			const currentRemoteItem = currentRemoteTree.tree[path]

			// If the item does not exist in the current tree but does in the previous one, it has been deleted.
			// We also check if the previous UUID does not exist in the current tree.
			if (!currentRemoteItem && previousRemoteItem && !currentRemoteTree.uuids[previousRemoteItem.uuid]) {
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

		// Local additions/filemodifications

		for (const path in currentLocalTree.tree) {
			if (pathsAdded[path] || erroredLocalPaths[path]) {
				continue
			}

			const currentLocalItem = currentLocalTree.tree[path]
			const currentRemoteItem = currentRemoteTree.tree[path]

			// If the item does not exist in the current remote tree, but does in the local one, it should be uploaded.
			// We also check if it in fact has existed before (the inode), if so, we skip it.
			if (!currentRemoteItem && currentLocalItem && !previousLocalTree.inodes[currentLocalItem.inode]) {
				deltas.push({
					type: currentLocalItem.type === "directory" ? "createRemoteDirectory" : "uploadFile",
					path
				})

				pathsAdded[path] = true

				continue
			}

			// If the item exists in both trees and has a different mod time + hash, we upload it again.
			if (
				currentRemoteItem &&
				currentRemoteItem.type === "file" &&
				currentLocalItem &&
				currentLocalItem.lastModified > currentRemoteItem.lastModified &&
				(await this.sync.localFileSystem.createFileHash({
					relativePath: path,
					algorithm: "md5"
				})) !== this.sync.localFileHashes[currentLocalItem.path]
			) {
				deltas.push({
					type: "uploadFile",
					path
				})

				pathsAdded[path] = true
			}
		}

		// Remote additions/changes

		for (const path in currentRemoteTree.tree) {
			if (pathsAdded[path]) {
				continue
			}

			const currentLocalItem = currentLocalTree.tree[path]
			const currentRemoteItem = currentRemoteTree.tree[path]

			// If the item does not exist in the current local tree, but does in the remote one, it should be download.
			// We also check if it in fact has existed before (the UUID), if so, we skip it.
			if (!currentLocalItem && currentRemoteItem && !previousRemoteTree.uuids[currentRemoteItem.uuid]) {
				deltas.push({
					type: currentRemoteItem.type === "directory" ? "createLocalDirectory" : "downloadFile",
					path
				})

				pathsAdded[path] = true

				continue
			}

			// If the item exists in both trees and the mod time changed, we download it.
			if (
				currentRemoteItem &&
				currentRemoteItem.type === "file" &&
				currentLocalItem &&
				currentRemoteItem.lastModified > currentLocalItem.lastModified
			) {
				deltas.push({
					type: "downloadFile",
					path
				})

				pathsAdded[path] = true
			}
		}

		// Filter deltas by sync mode
		if (this.sync.mode === "localToCloud") {
			deltas = deltas.filter(
				delta =>
					delta.type === "createRemoteDirectory" ||
					delta.type === "deleteRemoteDirectory" ||
					delta.type === "deleteRemoteFile" ||
					delta.type === "renameRemoteDirectory" ||
					delta.type === "renameRemoteFile" ||
					delta.type === "uploadFile"
			)
		}

		if (this.sync.mode === "localBackup") {
			deltas = deltas.filter(
				delta =>
					delta.type === "createRemoteDirectory" ||
					delta.type === "renameRemoteDirectory" ||
					delta.type === "renameRemoteFile" ||
					delta.type === "uploadFile"
			)
		}

		if (this.sync.mode === "cloudToLocal") {
			deltas = deltas.filter(
				delta =>
					delta.type === "createLocalDirectory" ||
					delta.type === "deleteLocalDirectory" ||
					delta.type === "deleteLocalFile" ||
					delta.type === "renameLocalDirectory" ||
					delta.type === "renameLocalFile" ||
					delta.type === "downloadFile"
			)
		}

		if (this.sync.mode === "cloudBackup") {
			deltas = deltas.filter(
				delta =>
					delta.type === "createLocalDirectory" ||
					delta.type === "renameLocalDirectory" ||
					delta.type === "renameLocalFile" ||
					delta.type === "downloadFile"
			)
		}

		// Work on deltas from "left to right" (ascending order, path length).
		const deltasSorted = deltas.sort((a, b) => a.path.split("/").length - b.path.split("/").length)

		// Here we apply the done task to the delta state.
		// E.g. when the user renames/moves a directory from "/sync/dir" to "/sync/dir2"
		// we'll get all the rename/move deltas for the directory children aswell.
		// This is pretty unecessary, hence we filter them here.
		// Same for deletions. We only ever need to rename/move/delete the parent directory if the children did not change.
		// This saves a lot of disk usage and API requests. This also saves time applying all done tasks to the overall state,
		// since we need to loop through less doneTasks.

		for (let i = 0; i < deltasSorted.length; i++) {
			const delta = deltasSorted[i]!
			let moveUp = false

			if (delta.type === "renameLocalDirectory" || delta.type === "renameLocalFile") {
				for (const directoryDelta of renamedLocalDirectories) {
					if (directoryDelta.type === "renameLocalDirectory" && delta.from.startsWith(directoryDelta.from + "/")) {
						const newFromPath = replacePathStartWithFromAndTo(delta.from, directoryDelta.from, directoryDelta.to)

						if (newFromPath === delta.to) {
							deltasSorted.splice(i, 1)

							moveUp = true
						} else {
							deltasSorted.splice(i, 1, {
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
							deltasSorted.splice(i, 1)

							moveUp = true
						} else {
							deltasSorted.splice(i, 1, {
								...delta,
								from: newFromPath
							})
						}
					}
				}
			} else if (delta.type === "deleteLocalDirectory" || delta.type === "deleteLocalFile") {
				for (const directoryDelta of deletedLocalDirectories) {
					if (directoryDelta.type === "deleteLocalDirectory" && delta.path.startsWith(directoryDelta.path + "/")) {
						deltasSorted.splice(i, 1)

						moveUp = true
					}
				}
			} else if (delta.type === "deleteRemoteDirectory" || delta.type === "deleteRemoteFile") {
				for (const directoryDelta of deletedRemoteDirectories) {
					if (directoryDelta.type === "deleteRemoteDirectory" && delta.path.startsWith(directoryDelta.path + "/")) {
						deltasSorted.splice(i, 1)

						moveUp = true
					}
				}
			}

			if (moveUp) {
				i--
			}
		}

		return deltasSorted
	}
}

export default Deltas
