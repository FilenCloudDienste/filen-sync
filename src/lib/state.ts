import type Sync from "./sync"
import pathModule from "path"
import fs from "fs-extra"
import { serialize, deserialize } from "v8"
import { type RemoteTree, type RemoteItem } from "./filesystems/remote"
import { type LocalTree, type LocalItem } from "./filesystems/local"
import { type DoneTask } from "./tasks"

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
				case "renameRemoteDirectory":
				case "renameRemoteFile": {
					for (const oldPath in currentRemoteTree.tree) {
						if (oldPath.startsWith(task.from + "/") || oldPath === task.from) {
							const newPath = oldPath.split(task.from).join(task.to)
							const oldItem = currentRemoteTree.tree[oldPath]

							if (oldItem) {
								const item: RemoteItem = {
									...oldItem,
									path: newPath,
									name: pathModule.posix.basename(newPath)
								}

								currentRemoteTree.tree[newPath] = item

								delete currentRemoteTree.tree[oldPath]
							}
						}
					}

					for (const uuid in currentRemoteTree.uuids) {
						const currentItem = currentRemoteTree.uuids[uuid]

						if (!currentItem) {
							continue
						}

						const oldPath = currentItem.path

						if (oldPath.startsWith(task.from + "/") || oldPath === task.from) {
							const newPath = oldPath.split(task.from).join(task.to)

							const item: RemoteItem = {
								...currentItem,
								path: newPath,
								name: pathModule.posix.basename(newPath)
							}

							currentRemoteTree.uuids[uuid] = item
						}
					}

					break
				}

				case "renameLocalDirectory":
				case "renameLocalFile": {
					for (const oldPath in currentLocalTree.tree) {
						if (oldPath.startsWith(task.from + "/") || oldPath === task.from) {
							const newPath = oldPath.split(task.from).join(task.to)
							const oldItem = currentLocalTree.tree[oldPath]

							if (oldItem) {
								const item: LocalItem = {
									...oldItem,
									path: newPath
								}

								currentLocalTree.tree[newPath] = item

								delete currentLocalTree.tree[oldPath]
							}
						}
					}

					for (const inode in currentLocalTree.inodes) {
						const currentItem = currentLocalTree.inodes[inode]

						if (!currentItem) {
							continue
						}

						const oldPath = currentItem.path

						if (oldPath.startsWith(task.from + "/") || oldPath === task.from) {
							const newPath = oldPath.split(task.from).join(task.to)

							const item: LocalItem = {
								...currentItem,
								path: newPath
							}

							currentLocalTree.inodes[inode] = item
						}
					}

					break
				}

				case "deleteLocalDirectory":
				case "deleteLocalFile":
				case "deleteRemoteDirectory":
				case "deleteRemoteFile": {
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

					delete this.sync.localFileHashes[task.path]

					break
				}

				case "createRemoteDirectory": {
					const item: RemoteItem = {
						name: pathModule.posix.basename(task.path),
						type: "directory",
						uuid: task.uuid,
						size: 0,
						path: task.path
					}

					currentRemoteTree.tree[task.path] = item
					currentRemoteTree.uuids[item.uuid] = item

					break
				}

				case "uploadFile": {
					const item: RemoteItem = {
						...task.item,
						path: task.path
					}

					currentRemoteTree.tree[task.path] = item
					currentRemoteTree.uuids[item.uuid] = item

					break
				}

				case "createLocalDirectory": {
					const item: LocalItem = {
						lastModified: parseInt(task.stats.mtimeMs as unknown as string), // Sometimes comes as a float, but we need an int
						type: "directory",
						path: task.path,
						creation: parseInt(task.stats.birthtimeMs as unknown as string), // Sometimes comes as a float, but we need an int
						size: task.stats.size,
						inode: task.stats.ino
					}

					currentLocalTree.tree[task.path] = item
					currentLocalTree.inodes[item.inode] = item

					break
				}

				case "downloadFile": {
					const item: LocalItem = {
						lastModified: parseInt(task.stats.mtimeMs as unknown as string), // Sometimes comes as a float, but we need an int
						type: "file",
						path: task.path,
						creation: parseInt(task.stats.birthtimeMs as unknown as string), // Sometimes comes as a float, but we need an int
						size: task.stats.size,
						inode: task.stats.ino
					}

					currentLocalTree.tree[task.path] = item
					currentLocalTree.inodes[item.inode] = item

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
