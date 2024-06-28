import type Sync from "./sync"
import { type Delta } from "./deltas"
import { promiseAllChunked } from "../utils"
import { type CloudItem } from "@filen/sdk"
import fs from "fs-extra"

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
		| "moveLocalFile"
		| "renameLocalFile"
		| "moveRemoteFile"
		| "renameRemoteFile"
		| "renameRemoteDirectory"
		| "renameLocalDirectory"
		| "moveRemoteDirectory"
		| "moveLocalFile"
		| "moveLocalDirectory"
}

export type DoneTask = { path: string } & (
	| { type: "uploadFile"; item: CloudItem }
	| {
			type: "createRemoteDirectory"
			uuid: string
	  }
	| {
			type: "createLocalDirectory"
			stats: fs.Stats
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
	  }
	| {
			type: "moveLocalFile"
			from: string
			to: string
	  }
	| {
			type: "renameLocalFile"
			from: string
			to: string
			stats: fs.Stats
	  }
	| {
			type: "moveRemoteFile"
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
			stats: fs.Stats
	  }
	| {
			type: "moveRemoteDirectory"
			from: string
			to: string
	  }
	| {
			type: "moveLocalFile"
			from: string
			to: string
			stats: fs.Stats
	  }
	| {
			type: "moveLocalDirectory"
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

	/**
	 * Creates an instance of Tasks.
	 * @date 3/1/2024 - 11:11:36 PM
	 *
	 * @constructor
	 * @public
	 * @param {{ sync: Sync }} param0
	 * @param {Sync} param0.sync
	 */
	public constructor({ sync }: { sync: Sync }) {
		this.sync = sync
	}

	/**
	 * Process a task.
	 * @date 3/2/2024 - 12:14:48 PM
	 *
	 * @private
	 * @async
	 * @param {{delta: Delta}} param0
	 * @param {Delta} param0.delta
	 * @returns {Promise<DoneTask>}
	 */
	private async processTask({ delta }: { delta: Delta }): Promise<DoneTask> {
		switch (delta.type) {
			case "createLocalDirectory": {
				const stats = await this.sync.localFileSystem.mkdir({ relativePath: delta.path })

				return {
					...delta,
					stats
				}
			}

			case "createRemoteDirectory": {
				const uuid = await this.sync.remoteFileSystem.mkdir({ relativePath: delta.path })

				return {
					...delta,
					uuid
				}
			}

			case "deleteLocalDirectory":
			case "deleteLocalFile": {
				await this.sync.localFileSystem.unlink({ relativePath: delta.path })

				return delta
			}

			case "deleteRemoteDirectory":
			case "deleteRemoteFile": {
				await this.sync.remoteFileSystem.unlink({ relativePath: delta.path })

				return delta
			}

			case "moveLocalDirectory":
			case "renameLocalDirectory":
			case "renameLocalFile":
			case "moveLocalFile": {
				const stats = await this.sync.localFileSystem.rename({ fromRelativePath: delta.from, toRelativePath: delta.to })

				return {
					...delta,
					stats
				}
			}

			case "moveRemoteDirectory":
			case "renameRemoteDirectory":
			case "renameRemoteFile":
			case "moveRemoteFile": {
				await this.sync.remoteFileSystem.rename({ fromRelativePath: delta.from, toRelativePath: delta.to })

				return delta
			}

			case "downloadFile": {
				const stats = await this.sync.remoteFileSystem.download({ relativePath: delta.path })

				return {
					...delta,
					stats
				}
			}

			case "uploadFile": {
				const item = await this.sync.localFileSystem.upload({ relativePath: delta.path })

				return {
					...delta,
					item
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

		await promiseAllChunked(
			// Work on deltas from "left to right" (ascending order, path length).
			deltas
				.sort((a, b) => a.path.split("/").length - b.path.split("/").length)
				.map(async delta => {
					try {
						const doneTask = await this.processTask({ delta })

						executed.push(doneTask)
					} catch (e) {
						if (e instanceof Error) {
							errors.push({
								path: delta.path,
								type: delta.type,
								error: e
							})
						}
					}
				})
		)

		return {
			doneTasks: executed,
			errors
		}
	}
}

export default Tasks
