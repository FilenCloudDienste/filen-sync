import type Sync from "./sync"
import pathModule from "path"
import fs from "fs-extra"
import { serialize, deserialize } from "v8"
import { type RemoteTree, type RemoteItem } from "./filesystems/remote"
import { type LocalTree, type LocalItem } from "./filesystems/local"
import { type DoneTask } from "./tasks"
import { replacePathStartWithFromAndTo } from "../utils"

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
	private readonly statePath: string

	public constructor(sync: Sync) {
		this.sync = sync
		this.statePath = pathModule.join(this.sync.dbPath, "state", `v${STATE_VERSION}`, sync.syncPair.uuid)
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
						lastModified: Math.round(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "directory",
						path: task.path,
						size: 0,
						creation: Math.round(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						inode: parseInt(task.stats.ino as unknown as string) // Sometimes comes as a float, but we need an int
					}

					currentRemoteTree.tree[task.item.path] = task.item
					currentRemoteTree.uuids[task.item.uuid] = task.item
					currentLocalTree.tree[task.path] = localItem
					currentLocalTree.inodes[localItem.inode] = localItem

					break
				}

				case "uploadFile": {
					const localItem: LocalItem = {
						lastModified: Math.round(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "file",
						path: task.path,
						size: parseInt(task.stats.size as unknown as string), // Sometimes comes as a float, but we need an int
						creation: Math.round(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						inode: parseInt(task.stats.ino as unknown as string) // Sometimes comes as a float, but we need an int
					}

					currentRemoteTree.tree[task.item.path] = task.item
					currentRemoteTree.uuids[task.item.uuid] = task.item
					currentLocalTree.tree[task.path] = localItem
					currentLocalTree.inodes[localItem.inode] = localItem

					break
				}

				case "createLocalDirectory": {
					const localItem: LocalItem = {
						lastModified: Math.round(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "directory",
						path: task.path,
						creation: Math.round(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						size: parseInt(task.stats.size as unknown as string), // Sometimes comes as a float, but we need an int
						inode: parseInt(task.stats.ino as unknown as string) // Sometimes comes as a float, but we need an int
					}

					currentLocalTree.tree[task.path] = localItem
					currentLocalTree.inodes[localItem.inode] = localItem
					currentRemoteTree.tree[task.item.path] = task.item
					currentRemoteTree.uuids[task.item.uuid] = task.item

					break
				}

				case "downloadFile": {
					const item: LocalItem = {
						lastModified: Math.round(task.stats.mtimeMs), // Sometimes comes as a float, but we need an int
						type: "file",
						path: task.path,
						creation: Math.round(task.stats.birthtimeMs), // Sometimes comes as a float, but we need an int
						size: parseInt(task.stats.size as unknown as string), // Sometimes comes as a float, but we need an int
						inode: parseInt(task.stats.ino as unknown as string) // Sometimes comes as a float, but we need an int
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

		const path = pathModule.join(this.statePath, "localFileHashes")
		const serialized = serialize(this.sync.localFileHashes)

		await fs.writeFile(path, serialized)
	}

	public async loadLocalFileHashes(): Promise<void> {
		await fs.ensureDir(this.statePath)

		const path = pathModule.join(this.statePath, "localFileHashes")

		if (!(await fs.exists(path))) {
			return
		}

		const buffer = await fs.readFile(path)

		this.sync.localFileHashes = deserialize(buffer)
	}

	public async initialize(): Promise<void> {
		await Promise.all([this.loadLocalFileHashes(), this.loadPreviousTrees()])
	}

	public async save(): Promise<void> {
		await Promise.all([this.saveLocalFileHashes(), this.savePreviousTrees()])
	}

	public async loadPreviousTrees(): Promise<void> {
		await fs.ensureDir(this.statePath)

		const localPath = pathModule.join(this.statePath, "previousLocalTree")
		const remotePath = pathModule.join(this.statePath, "previousRemoteTree")

		if (!(await fs.exists(localPath)) || !(await fs.exists(remotePath))) {
			return
		}

		const localBuffer = await fs.readFile(localPath)

		this.sync.previousLocalTree = deserialize(localBuffer)

		const remoteBuffer = await fs.readFile(remotePath)

		this.sync.previousRemoteTree = deserialize(remoteBuffer)
	}

	public async savePreviousTrees(): Promise<void> {
		await fs.ensureDir(this.statePath)

		const localPath = pathModule.join(this.statePath, "previousLocalTree")
		const remotePath = pathModule.join(this.statePath, "previousRemoteTree")

		await fs.writeFile(localPath, serialize(this.sync.previousLocalTree))
		await fs.writeFile(remotePath, serialize(this.sync.previousRemoteTree))
	}
}

export default State
