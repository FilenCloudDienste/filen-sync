import type Sync from "./sync"
import { type Delta } from "./deltas"
import { promiseAllChunked, serializeError } from "../utils"
import { type RemoteItem } from "./filesystems/remote"
import fs from "fs-extra"
import { postMessageToMain } from "./ipc"
import pathModule from "path"
import { Semaphore } from "../semaphore"
import { Prettify } from "../types"
import { v4 as uuidv4 } from "uuid"

export type TaskError = Prettify<
	{ path: string; error: Error; uuid: string } & (
		| {
				type:
					| "uploadFile"
					| "createRemoteDirectory"
					| "createLocalDirectory"
					| "deleteLocalFile"
					| "deleteRemoteFile"
					| "deleteLocalDirectory"
					| "deleteRemoteDirectory"
					| "downloadFile"
		  }
		| {
				type: "renameLocalFile" | "renameRemoteFile" | "renameRemoteDirectory" | "renameLocalDirectory"
				from: string
				to: string
		  }
	)
>

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
	private readonly transfersSemaphore = new Semaphore(10)
	private readonly normalSemaphore = new Semaphore(20)

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

	public async waitForPause(): Promise<void> {
		if (!this.sync.paused || this.sync.removed) {
			return
		}

		await new Promise<void>(resolve => {
			const wait = setInterval(() => {
				if (!this.sync.paused || this.sync.removed) {
					clearInterval(wait)

					resolve()
				}
			}, 100)
		})
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
		await this.waitForPause()

		if (this.sync.removed) {
			return null
		}

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
								error: serializeError(e),
								uuid: uuidv4()
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
								error: serializeError(e),
								uuid: uuidv4()
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
					// Don't throw if the file/directory does not exist anymore (it has been changed while we were inside the sync cycle, after deltas have been calculated).
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
								error: serializeError(e),
								uuid: uuidv4()
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
						// Don't throw if the file/directory does not exist anymore (it has been changed while we were inside the sync cycle, after deltas have been calculated).
						if (!(await this.sync.remoteFileSystem.fileExists(delta.path))) {
							return delta
						}
					}

					if (delta.type === "deleteRemoteDirectory") {
						// Don't throw if the file/directory does not exist anymore (it has been changed while we were inside the sync cycle, after deltas have been calculated).
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
								error: serializeError(e),
								uuid: uuidv4()
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
					// Don't throw if the file does not exist anymore, simply skip it (it has been changed while we were inside the sync cycle, after deltas have been calculated).
					if (!(await this.sync.localFileSystem.pathExists(pathModule.join(this.sync.syncPair.localPath, delta.from)))) {
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
								error: serializeError(e),
								uuid: uuidv4()
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
					if (delta.type === "renameRemoteFile") {
						// Don't throw if the file/directory does not exist anymore (it has been changed while we were inside the sync cycle, after deltas have been calculated).
						if (!(await this.sync.remoteFileSystem.fileExists(delta.from))) {
							return null
						}
					}

					if (delta.type === "renameRemoteDirectory") {
						// Don't throw if the file/directory does not exist anymore (it has been changed while we were inside the sync cycle, after deltas have been calculated).
						if (!(await this.sync.remoteFileSystem.directoryExists(delta.from))) {
							return null
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
								error: serializeError(e),
								uuid: uuidv4()
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
					// Don't throw if the file does not exist anymore, simply skip it (it has been changed while we were inside the sync cycle, after deltas have been calculated).
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
								error: serializeError(e),
								uuid: uuidv4()
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
					// Don't throw if the file does not exist anymore, simply skip it (it has been changed while we were inside the sync cycle, after deltas have been calculated).
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
								error: serializeError(e),
								uuid: uuidv4()
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
	 * @param {{ deltasSorted: Delta[] }} param0
	 * @param {{}} param0.deltasSorted
	 * @returns {Promise<{
	 * 		doneTasks: DoneTask[]
	 * 		errors: TaskError[]
	 * 	}>}
	 */
	public async process({ deltasSorted }: { deltasSorted: Delta[] }): Promise<{
		doneTasks: DoneTask[]
		errors: TaskError[]
	}> {
		if (this.sync.removed) {
			return {
				doneTasks: [],
				errors: []
			}
		}

		const executed: DoneTask[] = []
		const errors: TaskError[] = []

		const process = async (delta: Delta): Promise<void> => {
			if (this.sync.removed) {
				return
			}

			const semaphore = delta.type === "uploadFile" || delta.type === "downloadFile" ? this.transfersSemaphore : this.normalSemaphore

			await semaphore?.acquire()

			try {
				const doneTask = await this.processTask(delta)

				if (!doneTask) {
					return
				}

				executed.push(doneTask)
			} catch (e) {
				this.sync.worker.logger.log("error", e, "tasks.process")
				this.sync.worker.logger.log("error", e)

				if (e instanceof Error) {
					if (
						delta.type === "renameLocalDirectory" ||
						delta.type === "renameLocalFile" ||
						delta.type === "renameRemoteDirectory" ||
						delta.type === "renameRemoteFile"
					) {
						errors.push({
							path: delta.path,
							type: delta.type,
							error: e,
							from: delta.from,
							to: delta.to,
							uuid: uuidv4()
						})
					} else {
						errors.push({
							path: delta.path,
							type: delta.type,
							error: e,
							uuid: uuidv4()
						})
					}
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

		for (const delta of deltasSorted) {
			if (delta.type !== "renameLocalDirectory") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "renameLocalFile") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "renameRemoteDirectory") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "renameRemoteFile") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "deleteLocalDirectory") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "deleteLocalFile") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "deleteRemoteDirectory") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "deleteRemoteFile") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "createLocalDirectory") {
				continue
			}

			await process(delta)
		}

		for (const delta of deltasSorted) {
			if (delta.type !== "createRemoteDirectory") {
				continue
			}

			await process(delta)
		}

		await promiseAllChunked(deltasSorted.filter(delta => delta.type === "uploadFile").map(process))
		await promiseAllChunked(deltasSorted.filter(delta => delta.type === "downloadFile").map(process))

		return {
			doneTasks: executed,
			errors
		}
	}
}

export default Tasks
