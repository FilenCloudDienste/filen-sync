import type Sync from "./sync"
import { type Delta } from "./deltas"
import { promiseAllChunked, serializeError } from "../utils"
import { type RemoteItem } from "./filesystems/remote"
import fs from "fs-extra"
import { postMessageToMain } from "./ipc"
import pathModule from "path"
import { Semaphore } from "../semaphore"

export type TaskError = {
	path: string
	error: Error
	type:
		| "uploadFile"
		| "createRemoteDirectory"
		| "createLocalDirectory"
		| "deleteLocalFile"
		| "deleteRemoteFile"
		| "deleteLocalDirectory"
		| "deleteRemoteDirectory"
		| "downloadFile"
		| "renameLocalFile"
		| "renameRemoteFile"
		| "renameRemoteDirectory"
		| "renameLocalDirectory"
}

export type DoneTask = { path: string } & (
	| {
			type: "uploadFile"
			item: RemoteItem
			stats: fs.Stats
	  }
	| {
			type: "createRemoteDirectory"
			item: RemoteItem
			stats: fs.Stats
	  }
	| {
			type: "createLocalDirectory"
			stats: fs.Stats
			item: RemoteItem
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
			stats: fs.Stats
			item: RemoteItem
	  }
	| {
			type: "renameLocalFile"
			from: string
			to: string
			stats: fs.Stats
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
			stats: fs.Stats
	  }
)

/**
 * Tasks
 * @date 3/1/2024 - 11:11:32 PM
 *
 * @export
 * @class Tasks
 * @typedef {Tasks}
 */
export class Tasks {
	private readonly sync: Sync
	private readonly transfersSemaphore = new Semaphore(32)

	/**
	 * Creates an instance of Tasks.
	 *
	 * @constructor
	 * @public
	 * @param {Sync} sync
	 */
	public constructor(sync: Sync) {
		this.sync = sync
	}

	/**
	 * Process a delta task.
	 *
	 * @private
	 * @async
	 * @param {Delta} delta
	 * @returns {Promise<DoneTask | null>}
	 */
	private async processTask(delta: Delta): Promise<DoneTask | null> {
		switch (delta.type) {
			case "createLocalDirectory": {
				try {
					const stats = await this.sync.localFileSystem.mkdir({ relativePath: delta.path })
					const item = this.sync.remoteFileSystem.getDirectoryTreeCache.tree[delta.path]

					if (!item) {
						throw new Error("createLocalDirectory: remoteItem not found in getDirectoryTreeCache.")
					}

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return {
						...delta,
						stats,
						item
					}
				} catch (e) {
					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}

			case "createRemoteDirectory": {
				try {
					const [, stats] = await Promise.all([
						this.sync.remoteFileSystem.mkdir({ relativePath: delta.path }),
						fs.stat(pathModule.join(this.sync.syncPair.localPath, delta.path))
					])
					const item = this.sync.remoteFileSystem.getDirectoryTreeCache.tree[delta.path]

					if (!item) {
						throw new Error("createLocalDirectory: remoteItem not found in getDirectoryTreeCache.")
					}

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return {
						...delta,
						item,
						stats
					}
				} catch (e) {
					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}

			case "deleteLocalDirectory":
			case "deleteLocalFile": {
				try {
					await this.sync.localFileSystem.unlink({ relativePath: delta.path })

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return delta
				} catch (e) {
					// Don't throw if the file/directory does not exist anymore.
					if (!(await this.sync.localFileSystem.pathExists(delta.path))) {
						return delta
					}

					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}

			case "deleteRemoteDirectory":
			case "deleteRemoteFile": {
				try {
					await this.sync.remoteFileSystem.unlink({ relativePath: delta.path })

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return delta
				} catch (e) {
					if (delta.type === "deleteRemoteFile") {
						// Don't throw if the file/directory does not exist anymore.
						if (!(await this.sync.remoteFileSystem.fileExists(delta.path))) {
							return delta
						}
					}

					if (delta.type === "deleteRemoteDirectory") {
						// Don't throw if the file/directory does not exist anymore.
						if (!(await this.sync.remoteFileSystem.directoryExists(delta.path))) {
							return delta
						}
					}

					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}

			case "renameLocalDirectory":
			case "renameLocalFile": {
				try {
					const stats = await this.sync.localFileSystem.rename({
						fromRelativePath: delta.from,
						toRelativePath: delta.to
					})

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return {
						...delta,
						stats
					}
				} catch (e) {
					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}

			case "renameRemoteDirectory":
			case "renameRemoteFile": {
				try {
					await this.sync.remoteFileSystem.rename({
						fromRelativePath: delta.from,
						toRelativePath: delta.to
					})

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return delta
				} catch (e) {
					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}

			case "downloadFile": {
				try {
					const stats = await this.sync.remoteFileSystem.download({ relativePath: delta.path })
					const item = this.sync.remoteFileSystem.getDirectoryTreeCache.tree[delta.path]

					if (!item) {
						throw new Error("downloadFile: remoteItem not found in getDirectoryTreeCache.")
					}

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return {
						...delta,
						stats,
						item
					}
				} catch (e) {
					// Don't throw if the file does not exist anymore, simply skip it.
					if (!(await this.sync.remoteFileSystem.fileExists(delta.path))) {
						return null
					}

					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}

			case "uploadFile": {
				try {
					const [, stats] = await Promise.all([
						this.sync.localFileSystem.upload({ relativePath: delta.path }),
						fs.stat(pathModule.join(this.sync.syncPair.localPath, delta.path))
					])
					const item = this.sync.remoteFileSystem.getDirectoryTreeCache.tree[delta.path]

					if (!item) {
						throw new Error("uploadFile: remoteItem not found in getDirectoryTreeCache.")
					}

					postMessageToMain({
						type: "transfer",
						syncPair: this.sync.syncPair,
						data: {
							of: delta.type,
							type: "success",
							relativePath: delta.path,
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path)
						}
					})

					return {
						...delta,
						item,
						stats
					}
				} catch (e) {
					// Don't throw if the file does not exist anymore, simply skip it.
					if (!(await this.sync.localFileSystem.pathExists(pathModule.join(this.sync.syncPair.localPath, delta.path)))) {
						return null
					}

					if (e instanceof Error) {
						postMessageToMain({
							type: "transfer",
							syncPair: this.sync.syncPair,
							data: {
								of: delta.type,
								type: "error",
								relativePath: delta.path,
								localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
								error: serializeError(e)
							}
						})
					}

					throw e
				}
			}
		}
	}

	/**
	 * Process all deltas.
	 *
	 * @public
	 * @async
	 * @param {{ deltas: Delta[] }} param0
	 * @param {{}} param0.deltas
	 * @returns {Promise<{
	 * 		doneTasks: DoneTask[]
	 * 		errors: TaskError[]
	 * 	}>}
	 */
	public async process({ deltas }: { deltas: Delta[] }): Promise<{
		doneTasks: DoneTask[]
		errors: TaskError[]
	}> {
		const executed: DoneTask[] = []
		const errors: TaskError[] = []
		// Work on deltas from "left to right" (ascending order, path length).
		const deltasSorted = deltas.sort((a, b) => a.path.split("/").length - b.path.split("/").length)
		const renameRemoteDirectoryDeltas: Delta[] = []
		const renameRemoteFileDeltas: Delta[] = []
		const renameLocalDirectoryDeltas: Delta[] = []
		const renameLocalFileDeltas: Delta[] = []
		const deleteRemoteDirectoryDeltas: Delta[] = []
		const deleteRemoteFileDeltas: Delta[] = []
		const deleteLocalDirectoryDeltas: Delta[] = []
		const deleteLocalFileDeltas: Delta[] = []
		const createRemoteDirectoryDeltas: Delta[] = []
		const createLocalDirectoryDeltas: Delta[] = []
		const uploadFileDeltas: Delta[] = []
		const downloadFileDeltas: Delta[] = []

		for (const delta of deltasSorted) {
			if (delta.type === "renameRemoteDirectory") {
				renameRemoteDirectoryDeltas.push(delta)
			} else if (delta.type === "renameRemoteFile") {
				renameRemoteFileDeltas.push(delta)
			} else if (delta.type === "renameLocalDirectory") {
				renameLocalDirectoryDeltas.push(delta)
			} else if (delta.type === "renameLocalFile") {
				renameLocalFileDeltas.push(delta)
			} else if (delta.type === "deleteRemoteDirectory") {
				deleteRemoteDirectoryDeltas.push(delta)
			} else if (delta.type === "deleteRemoteFile") {
				deleteRemoteFileDeltas.push(delta)
			} else if (delta.type === "deleteLocalDirectory") {
				deleteLocalDirectoryDeltas.push(delta)
			} else if (delta.type === "deleteLocalFile") {
				deleteLocalFileDeltas.push(delta)
			} else if (delta.type === "createRemoteDirectory") {
				createRemoteDirectoryDeltas.push(delta)
			} else if (delta.type === "createLocalDirectory") {
				createLocalDirectoryDeltas.push(delta)
			} else if (delta.type === "uploadFile") {
				uploadFileDeltas.push(delta)
			} else if (delta.type === "downloadFile") {
				downloadFileDeltas.push(delta)
			}
		}

		const process = async (delta: Delta): Promise<void> => {
			const semaphore = delta.type === "uploadFile" || delta.type === "downloadFile" ? this.transfersSemaphore : null

			await semaphore?.acquire()

			try {
				const doneTask = await this.processTask(delta)

				if (!doneTask) {
					return
				}

				executed.push(doneTask)
			} catch (e) {
				this.sync.worker.logger.log("error", e, "tasks.process")

				if (e instanceof Error) {
					errors.push({
						path: delta.path,
						type: delta.type,
						error: e
					})
				}
			} finally {
				semaphore?.release()
			}
		}

		// Rename/move/delete/createDir tasks need to run synchronously, e.g. one after another, due to applying executed tasks to the delta state.
		// Upload/download tasks can run in parallel.
		// The order of running tasks is also set:
		// 1. Local directory renaming/moving
		// 2. Local file renaming/moving
		// 3. Remote directory renaming/moving
		// 4. Remote file renaming/moving
		// 5. Local directory deletions
		// 6. Local file deletions
		// 7. Remote directory deletions
		// 8. Remote file deletions
		// 9. Local directory creations
		// 10. Remote directory creations
		// 11. File uploads
		// 12. File downloads

		for (const delta of renameLocalDirectoryDeltas) {
			await process(delta)
		}

		for (const delta of renameLocalFileDeltas) {
			await process(delta)
		}

		for (const delta of renameRemoteDirectoryDeltas) {
			await process(delta)
		}

		for (const delta of renameRemoteFileDeltas) {
			await process(delta)
		}

		for (const delta of deleteLocalDirectoryDeltas) {
			await process(delta)
		}

		for (const delta of deleteLocalFileDeltas) {
			await process(delta)
		}

		for (const delta of deleteRemoteDirectoryDeltas) {
			await process(delta)
		}

		for (const delta of deleteRemoteFileDeltas) {
			await process(delta)
		}

		for (const delta of createLocalDirectoryDeltas) {
			await process(delta)
		}

		for (const delta of createRemoteDirectoryDeltas) {
			await process(delta)
		}

		await promiseAllChunked(uploadFileDeltas.map(process))
		await promiseAllChunked(downloadFileDeltas.map(process))

		return {
			doneTasks: executed,
			errors
		}
	}
}

export default Tasks
