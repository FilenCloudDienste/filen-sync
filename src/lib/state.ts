import type Sync from "./sync"
import pathModule from "path"
import fs from "fs-extra"
import { serialize, deserialize } from "v8"
import { type RemoteTree, type RemoteItem } from "./filesystems/remote"
import { type LocalTree, type LocalItem } from "./filesystems/local"
import { type DoneTask } from "./tasks"
import { replacePathStartWithFromAndTo, normalizeUTime } from "../utils"
import writeFileAtomic from "write-file-atomic"
import { runGC } from "./gc"

const STATE_VERSION = 1

/**
 * State
 * @date 3/1/2024 - 11:11:32 PM
 *
 * @export
 * @class State
 * @typedef {State}
 */
export class State {
	private readonly sync: Sync
	public readonly statePath: string
	public readonly previousLocalTreePath: string
	public readonly previousRemoteTreePath: string
	public readonly localFileHashesPath: string

	public constructor(sync: Sync) {
		this.sync = sync
		this.statePath = pathModule.join(this.sync.dbPath, "state", `v${STATE_VERSION}`, sync.syncPair.uuid)
		this.previousLocalTreePath = pathModule.join(this.statePath, "previousLocalTree")
		this.previousRemoteTreePath = pathModule.join(this.statePath, "previousRemoteTree")
		this.localFileHashesPath = pathModule.join(this.statePath, "localFileHashes")
	}

	public applyDoneTasksToState({
		doneTasks,
		currentLocalTree,
		currentRemoteTree
	}: {
		doneTasks: DoneTask[]
		currentLocalTree: LocalTree
		currentRemoteTree: RemoteTree
	}): { currentLocalTree: LocalTree; currentRemoteTree: RemoteTree } {
		if (this.sync.removed) {
			return {
				currentLocalTree,
				currentRemoteTree
			}
		}

		// Work on the done tasks from "right to left" (descending order, path length).
		// This ensures we pick up all individual files/directory movements (e.g. parent moved to /a/b while children are moved /c/d)
		const tasks = doneTasks.sort((a, b) => b.path.split("/").length - a.path.split("/").length)

		for (const task of tasks) {
			switch (task.type) {
				case "renameLocalDirectory":
				case "renameLocalFile": {
					if (this.sync.localFileHashes[task.from]) {
						this.sync.localFileHashes[task.to] = this.sync.localFileHashes[task.from]!
					}

					delete this.sync.localFileHashes[task.from]

					const oldItem = currentLocalTree.tree[task.from]

					if (oldItem) {
						currentLocalTree.tree[task.to] = {
							...oldItem,
							path: task.to
						}

						currentLocalTree.inodes[oldItem.inode] = {
							...oldItem,
							path: task.to
						}
					}

					delete currentLocalTree.tree[task.from]

					for (const oldPath in currentLocalTree.tree) {
						if (oldPath.startsWith(task.from + "/") && oldPath !== task.from) {
							const newPath = replacePathStartWithFromAndTo(oldPath, task.from, task.to)
							const oldItem = currentLocalTree.tree[oldPath]

							if (oldItem) {
								const item: LocalItem = {
									...oldItem,
									path: newPath
								}

								currentLocalTree.tree[newPath] = item

								delete currentLocalTree.tree[oldPath]

								const oldItemINode = currentLocalTree.inodes[oldItem.inode]

								if (oldItemINode) {
									currentLocalTree.inodes[oldItem.inode] = {
										...oldItemINode,
										path: newPath
									}
								}
							}

							const oldItemHash = this.sync.localFileHashes[oldPath]

							if (oldItemHash) {
								this.sync.localFileHashes[newPath] = oldItemHash

								delete this.sync.localFileHashes[oldPath]
							}
						}
					}

					break
				}

				case "renameRemoteDirectory":
				case "renameRemoteFile": {
					const oldItem = currentRemoteTree.tree[task.from]

					if (oldItem) {
						const newItem: RemoteItem = {
							...oldItem,
							path: task.to,
							name: pathModule.posix.basename(task.to)
						}

						currentRemoteTree.tree[task.to] = newItem
						currentRemoteTree.uuids[oldItem.uuid] = newItem
					}

					delete currentRemoteTree.tree[task.from]

					for (const oldPath in currentRemoteTree.tree) {
						if (oldPath.startsWith(task.from + "/") && oldPath !== task.from) {
							const newPath = replacePathStartWithFromAndTo(oldPath, task.from, task.to)
							const oldItem = currentRemoteTree.tree[oldPath]

							if (oldItem) {
								const newItem: RemoteItem = {
									...oldItem,
									path: newPath,
									name: pathModule.posix.basename(newPath)
								}

								currentRemoteTree.tree[newPath] = newItem

								delete currentRemoteTree.tree[oldPath]

								const oldItemUUID = currentRemoteTree.uuids[oldItem.uuid]

								if (oldItemUUID) {
									currentRemoteTree.uuids[oldItemUUID.uuid] = {
										...oldItemUUID,
										path: newPath,
										name: pathModule.posix.basename(newPath)
									}
								}
							}
						}
					}

					break
				}

				case "deleteLocalDirectory":
				case "deleteLocalFile": {
					delete this.sync.localFileHashes[task.path]
					delete currentLocalTree.tree[task.path]

					for (const path in this.sync.localFileHashes) {
						if (path.startsWith(task.path + "/") || path === task.path) {
							delete this.sync.localFileHashes[path]
						}
					}

					for (const path in currentLocalTree.tree) {
						if (path.startsWith(task.path + "/") || path === task.path) {
							delete currentLocalTree.tree[path]
						}
					}

					for (const inode in currentLocalTree.inodes) {
						const currentItem = currentLocalTree.inodes[inode]

						if (!currentItem) {
							continue
						}

						const path = currentItem.path

						if (path.startsWith(task.path + "/") || path === task.path) {
							delete currentLocalTree.inodes[inode]
						}
					}

					break
				}

				case "deleteRemoteDirectory":
				case "deleteRemoteFile": {
					delete currentRemoteTree.tree[task.path]

					for (const path in currentRemoteTree.tree) {
						if (path.startsWith(task.path + "/") || path === task.path) {
							delete currentRemoteTree.tree[path]
						}
					}

					for (const uuid in currentRemoteTree.uuids) {
						const currentItem = currentRemoteTree.uuids[uuid]

						if (!currentItem) {
							continue
						}

						const path = currentItem.path

						if (path.startsWith(task.path + "/") || path === task.path) {
							delete currentRemoteTree.uuids[uuid]
						}
					}

					break
				}

				case "createRemoteDirectory": {
					const localItem: LocalItem = {
						lastModified: normalizeUTime(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "directory",
						path: task.path,
						size: 0,
						creation: normalizeUTime(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						inode: task.stats.ino
					}

					currentRemoteTree.tree[task.item.path] = task.item
					currentRemoteTree.uuids[task.item.uuid] = task.item
					currentLocalTree.tree[task.path] = localItem
					currentLocalTree.inodes[localItem.inode] = localItem

					break
				}

				case "uploadFile": {
					const localItem: LocalItem = {
						lastModified: normalizeUTime(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "file",
						path: task.path,
						size: task.stats.size,
						creation: normalizeUTime(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						inode: task.stats.ino
					}

					currentRemoteTree.tree[task.item.path] = task.item
					currentRemoteTree.uuids[task.item.uuid] = task.item
					currentLocalTree.tree[task.path] = localItem
					currentLocalTree.inodes[localItem.inode] = localItem

					break
				}

				case "createLocalDirectory": {
					const localItem: LocalItem = {
						lastModified: normalizeUTime(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "directory",
						path: task.path,
						creation: normalizeUTime(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						size: task.stats.size,
						inode: task.stats.ino
					}

					currentLocalTree.tree[task.path] = localItem
					currentLocalTree.inodes[localItem.inode] = localItem
					currentRemoteTree.tree[task.item.path] = task.item
					currentRemoteTree.uuids[task.item.uuid] = task.item

					break
				}

				case "downloadFile": {
					const item: LocalItem = {
						lastModified: normalizeUTime(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "file",
						path: task.path,
						creation: normalizeUTime(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						size: task.stats.size,
						inode: task.stats.ino
					}

					currentLocalTree.tree[task.path] = item
					currentLocalTree.inodes[item.inode] = item
					currentRemoteTree.tree[task.item.path] = task.item
					currentRemoteTree.uuids[task.item.uuid] = task.item

					break
				}
			}
		}

		return {
			currentLocalTree,
			currentRemoteTree
		}
	}

	public async saveLocalFileHashes(): Promise<void> {
		await fs.ensureDir(this.statePath)

		await writeFileAtomic(this.localFileHashesPath, serialize(this.sync.localFileHashes))
	}

	public async loadLocalFileHashes(): Promise<void> {
		await fs.ensureDir(this.statePath)

		if (!(await fs.exists(this.localFileHashesPath))) {
			return
		}

		this.sync.localFileHashes = deserialize(await fs.readFile(this.localFileHashesPath))
	}

	public async initialize(): Promise<void> {
		await this.loadLocalFileHashes()
		await this.loadPreviousTrees()

		runGC()
	}

	public async save(): Promise<void> {
		await this.saveLocalFileHashes()
		await this.savePreviousTrees()

		runGC()
	}

	public async loadPreviousTrees(): Promise<void> {
		await fs.ensureDir(this.statePath)

		if (!(await fs.exists(this.previousLocalTreePath)) || !(await fs.exists(this.previousRemoteTreePath))) {
			return
		}

		this.sync.previousLocalTree = deserialize(await fs.readFile(this.previousLocalTreePath))
		this.sync.previousRemoteTree = deserialize(await fs.readFile(this.previousRemoteTreePath))
	}

	public async savePreviousTrees(): Promise<void> {
		await fs.ensureDir(this.statePath)

		await writeFileAtomic(this.previousLocalTreePath, serialize(this.sync.previousLocalTree))
		await writeFileAtomic(this.previousRemoteTreePath, serialize(this.sync.previousRemoteTree))
	}

	public async clear(): Promise<void> {
		await fs.ensureDir(this.statePath)

		await Promise.all([
			fs.unlink(this.previousLocalTreePath),
			fs.unlink(this.previousRemoteTreePath),
			fs.unlink(this.localFileHashesPath)
		])
	}
}

export default State
