import type Sync from "./sync"
import pathModule from "path"
import { type RemoteTree, type RemoteItem } from "./filesystems/remote"
import { type LocalTree, type LocalItem } from "./filesystems/local"
import { type DoneTask } from "./tasks"
import { replacePathStartWithFromAndTo, normalizeUTime } from "../utils"
import readline from "readline"
import { v4 as uuidv4 } from "uuid"
import FastGlob from "fast-glob"

const STATE_VERSION = 2

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
	public readonly previousLocalINodesPath: string
	public readonly previousRemoteTreePath: string
	public readonly previousRemoteUUIDsPath: string
	public readonly localFileHashesPath: string

	public constructor(sync: Sync) {
		this.sync = sync
		this.statePath = pathModule.join(this.sync.dbPath, "state", `v${STATE_VERSION}`, sync.syncPair.uuid)
		this.previousLocalTreePath = pathModule.join(this.statePath, "previousLocalTree")
		this.previousLocalINodesPath = pathModule.join(this.statePath, "previousLocalINodes")
		this.previousRemoteTreePath = pathModule.join(this.statePath, "previousRemoteTree")
		this.previousRemoteUUIDsPath = pathModule.join(this.statePath, "previousRemoteUUIDs")
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

					// Only a DIRECTORY carries descendants to relocate. A file rename has none, so scanning the
					// whole tree (and every cached hash) for children of a file was pure waste — O(tree) per file
					// rename, i.e. O(renames * tree) across a cycle that renames many scattered files. (P2)
					if (task.type === "renameLocalDirectory") {
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

					// As with the local side: only a directory has descendants to relocate; skip the whole-tree
					// scan for a file rename. (P2)
					if (task.type === "renameRemoteDirectory") {
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
					}

					break
				}

				case "deleteLocalFile": {
					// A file has no descendants: remove it directly instead of scanning the whole tree, every
					// cached hash, and every inode for children that cannot exist. (P2)
					const item = currentLocalTree.tree[task.path]

					delete this.sync.localFileHashes[task.path]
					delete currentLocalTree.tree[task.path]

					if (item) {
						delete currentLocalTree.inodes[item.inode]
					}

					break
				}

				case "deleteLocalDirectory": {
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

				case "deleteRemoteFile": {
					// A file has no descendants: remove it directly instead of scanning the whole tree and every
					// uuid for children that cannot exist. (P2)
					const item = currentRemoteTree.tree[task.path]

					delete currentRemoteTree.tree[task.path]

					if (item) {
						delete currentRemoteTree.uuids[item.uuid]
					}

					break
				}

				case "deleteRemoteDirectory": {
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

	public async writeLargeRecordSerializedAndAtomically(
		destination: string,
		record: Record<string | number, RemoteItem | LocalItem | string | number>
	): Promise<void> {
		await this.sync.environment.fs.ensureDir(pathModule.dirname(destination))

		const tmpDestination = pathModule.join(pathModule.dirname(destination), `${uuidv4()}.tmp`)

		try {
			// eslint-disable-next-line no-async-promise-executor
			await new Promise<void>(async (resolve, reject) => {
				try {
					let didError = false
					const stream = this.sync.environment.fs.createWriteStream(tmpDestination, {
						encoding: "utf-8"
					})

					stream.on("error", err => {
						didError = true

						reject(err)
					})

					for (const prop in record) {
						if (didError) {
							break
						}

						if (
							!stream.write(
								JSON.stringify({
									prop,
									data: record[prop]
								}) + "\n"
							)
						) {
							await new Promise<void>(resolve => stream.once("drain", resolve))
						}
					}

					await new Promise<void>(resolve => stream.end(resolve))

					if (didError) {
						return
					}

					await this.sync.environment.fs.move(tmpDestination, destination, {
						overwrite: true
					})

					resolve()
				} catch (e) {
					reject(e)
				}
			})
		} finally {
			if (await this.sync.environment.fs.pathExists(tmpDestination)) {
				await this.sync.environment.fs.rm(tmpDestination, {
					force: true,
					maxRetries: 60 * 10,
					recursive: true,
					retryDelay: 100
				})
			}
		}
	}

	public async readLargeRecordFromLineStream<T = unknown>(inputPath: string): Promise<Record<string, T>> {
		const record: Record<string, T> = {}

		const rl = readline.createInterface({
			input: this.sync.environment.fs.createReadStream(inputPath, {
				encoding: "utf-8"
			}),
			crlfDelay: Infinity,
			terminal: false
		})

		try {
			for await (const line of rl) {
				if (line.trim()) {
					try {
						const parsed: {
							prop: string
							data: T
						} = JSON.parse(line)

						if (parsed && typeof parsed === "object" && "prop" in parsed && "data" in parsed) {
							record[parsed.prop] = parsed.data
						}
					} catch {
						// Noop
					}
				}
			}
		} finally {
			rl.close()
		}

		return record
	}

	public async saveLocalFileHashes(): Promise<void> {
		await this.sync.environment.fs.ensureDir(this.statePath)

		await this.writeLargeRecordSerializedAndAtomically(this.localFileHashesPath, this.sync.localFileHashes)
	}

	public async loadLocalFileHashes(): Promise<void> {
		await this.sync.environment.fs.ensureDir(this.statePath)

		if (!(await this.sync.environment.fs.exists(this.localFileHashesPath))) {
			return
		}

		this.sync.localFileHashes = await this.readLargeRecordFromLineStream<string>(this.localFileHashesPath)
	}

	public async initialize(): Promise<void> {
		await this.loadLocalFileHashes()
		await this.loadPreviousTrees()
	}

	public async save(): Promise<void> {
		await this.saveLocalFileHashes()
		await this.savePreviousTrees()
	}

	public async loadPreviousTrees(): Promise<void> {
		await this.sync.environment.fs.ensureDir(this.statePath)

		const dir = await FastGlob.async("**/*", {
			dot: true,
			onlyDirectories: false,
			onlyFiles: true,
			throwErrorOnBrokenSymbolicLink: false,
			cwd: this.statePath,
			followSymbolicLinks: false,
			deep: 0,
			fs: this.sync.environment.globFs,
			suppressErrors: true,
			stats: false,
			unique: true,
			objectMode: false
		})

		for (const entry of dir) {
			if (!entry) {
				continue
			}

			if (entry.trim().endsWith(".tmp")) {
				await this.sync.environment.fs.rm(pathModule.join(this.statePath, entry), {
					force: true,
					maxRetries: 60 * 10,
					recursive: true,
					retryDelay: 100
				})
			}
		}

		if (
			!(await this.sync.environment.fs.exists(this.previousLocalTreePath)) ||
			!(await this.sync.environment.fs.exists(this.previousRemoteTreePath)) ||
			// Previously this duplicated the remote-tree check and never looked at the local INODES file,
			// even though it is read unconditionally below — a missing/partially-written inodes file then
			// passed the completeness gate and threw ENOENT mid-load, bricking the whole state load. All four
			// persisted files must exist for the base to be usable; otherwise treat the state as empty and
			// re-derive.
			!(await this.sync.environment.fs.exists(this.previousLocalINodesPath)) ||
			!(await this.sync.environment.fs.exists(this.previousRemoteUUIDsPath))
		) {
			this.sync.isPreviousSavedTreeStateEmpty = true

			return
		}

		const previousLocalTree = await this.readLargeRecordFromLineStream<LocalItem>(this.previousLocalTreePath)
		const previousRemoteTree = await this.readLargeRecordFromLineStream<RemoteItem>(this.previousRemoteTreePath)

		this.sync.isPreviousSavedTreeStateEmpty = false
		this.sync.previousLocalTree.tree = previousLocalTree
		this.sync.previousLocalTree.inodes = await this.readLargeRecordFromLineStream<LocalItem>(this.previousLocalINodesPath)
		this.sync.previousRemoteTree.tree = previousRemoteTree
		this.sync.previousRemoteTree.uuids = await this.readLargeRecordFromLineStream<RemoteItem>(this.previousRemoteUUIDsPath)
		this.sync.previousLocalTree.size = Object.keys(previousLocalTree).length
		this.sync.previousRemoteTree.size = Object.keys(previousRemoteTree).length
	}

	public async savePreviousTrees(): Promise<void> {
		await this.sync.environment.fs.ensureDir(this.statePath)

		await this.writeLargeRecordSerializedAndAtomically(this.previousLocalTreePath, this.sync.previousLocalTree.tree)
		await this.writeLargeRecordSerializedAndAtomically(this.previousLocalINodesPath, this.sync.previousLocalTree.inodes)
		await this.writeLargeRecordSerializedAndAtomically(this.previousRemoteTreePath, this.sync.previousRemoteTree.tree)
		await this.writeLargeRecordSerializedAndAtomically(this.previousRemoteUUIDsPath, this.sync.previousRemoteTree.uuids)

		this.sync.isPreviousSavedTreeStateEmpty = false
	}

	public async clear(): Promise<void> {
		await this.sync.environment.fs.ensureDir(this.statePath)

		await Promise.all([
			this.sync.environment.fs.rm(this.previousLocalTreePath, {
				force: true,
				maxRetries: 60 * 10,
				recursive: true,
				retryDelay: 100
			}),
			this.sync.environment.fs.rm(this.previousLocalINodesPath, {
				force: true,
				maxRetries: 60 * 10,
				recursive: true,
				retryDelay: 100
			}),
			this.sync.environment.fs.rm(this.previousRemoteTreePath, {
				force: true,
				maxRetries: 60 * 10,
				recursive: true,
				retryDelay: 100
			}),
			this.sync.environment.fs.rm(this.previousRemoteUUIDsPath, {
				force: true,
				maxRetries: 60 * 10,
				recursive: true,
				retryDelay: 100
			}),
			this.sync.environment.fs.rm(this.localFileHashesPath, {
				force: true,
				maxRetries: 60 * 10,
				recursive: true,
				retryDelay: 100
			})
		])
	}
}

export default State
