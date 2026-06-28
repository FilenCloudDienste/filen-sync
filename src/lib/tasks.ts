import type Sync from "./sync"
import { type Delta } from "./deltas"
import { promiseAllChunked, serializeError } from "../utils"
import { type RemoteItem } from "./filesystems/remote"
import { type Stats } from "fs-extra"
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
			stats: Stats
	  }
	| {
			type: "createRemoteDirectory"
			item: RemoteItem
			stats: Stats
	  }
	| {
			type: "createLocalDirectory"
			stats: Stats
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
			stats: Stats
			item: RemoteItem
	  }
	| {
			type: "renameLocalFile"
			from: string
			to: string
			stats: Stats
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
			stats: Stats
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
						this.sync.environment.fs.stat(pathModule.join(this.sync.syncPair.localPath, delta.path))
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
					if (!(await this.sync.localFileSystem.pathExists(pathModule.join(this.sync.syncPair.localPath, delta.path)))) {
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
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
							// Both endpoints so the consumer can tell a same-directory rename from a move
							// (different parent) for the sync log — the engine treats both as a path change.
							from: delta.from,
							to: delta.to
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
							localPath: pathModule.join(this.sync.syncPair.localPath, delta.path),
							// Both endpoints so the consumer can tell a same-directory rename from a move
							// (different parent) for the sync log — the engine treats both as a path change.
							from: delta.from,
							to: delta.to
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
						this.sync.localFileSystem.upload({
							relativePath: delta.path,
							passedMD5Hash: delta.md5Hash
						}),
						this.sync.environment.fs.stat(pathModule.join(this.sync.syncPair.localPath, delta.path))
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

		// Partition the deltas into per-type buckets in ONE pass, then drain the buckets in the fixed order
		// above — instead of scanning the whole deltasSorted array 12 times (10 sequential `if type !== X
		// continue` passes + 2 filters), which is 12·O(deltas) just to order the work and costs real time on a
		// bulk cycle (e.g. an initial sync of a huge tree). Each bucket keeps deltasSorted order (we push in
		// iteration order), so the executed order — and therefore behavior — is identical. (perf)
		const byType: Record<Delta["type"], Delta[]> = {
			renameLocalDirectory: [],
			renameLocalFile: [],
			renameRemoteDirectory: [],
			renameRemoteFile: [],
			deleteLocalDirectory: [],
			deleteLocalFile: [],
			deleteRemoteDirectory: [],
			deleteRemoteFile: [],
			createLocalDirectory: [],
			createRemoteDirectory: [],
			uploadFile: [],
			downloadFile: []
		}

		for (const delta of deltasSorted) {
			byType[delta.type].push(delta)
		}

		// Sequential, in the documented type order (state-mutating ops one after another).
		for (const delta of byType.renameLocalDirectory) {
			await process(delta)
		}

		for (const delta of byType.renameLocalFile) {
			await process(delta)
		}

		for (const delta of byType.renameRemoteDirectory) {
			await process(delta)
		}

		for (const delta of byType.renameRemoteFile) {
			await process(delta)
		}

		for (const delta of byType.deleteLocalDirectory) {
			await process(delta)
		}

		for (const delta of byType.deleteLocalFile) {
			await process(delta)
		}

		for (const delta of byType.deleteRemoteDirectory) {
			await process(delta)
		}

		for (const delta of byType.deleteRemoteFile) {
			await process(delta)
		}

		for (const delta of byType.createLocalDirectory) {
			await process(delta)
		}

		for (const delta of byType.createRemoteDirectory) {
			await process(delta)
		}

		// Uploads then downloads, in parallel (bounded by the transfers semaphore inside `process`).
		await promiseAllChunked(byType.uploadFile.map(process), 10000, false)
		await promiseAllChunked(byType.downloadFile.map(process), 10000, false)

		return {
			doneTasks: executed,
			errors
		}
	}
}

export default Tasks
