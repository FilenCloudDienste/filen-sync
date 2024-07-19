import FilenSDK, { type PauseSignal } from "@filen/sdk"
import { type SyncPair, type SyncMode } from "../types"
import { SYNC_INTERVAL } from "../constants"
import { LocalFileSystem, LocalTree } from "./filesystems/local"
import { RemoteFileSystem, RemoteTree } from "./filesystems/remote"
import Deltas from "./deltas"
import Tasks, { type TaskError } from "./tasks"
import State from "./state"
import { postMessageToMain } from "./ipc"
import Ignorer from "../ignorer"
import { serializeError } from "../utils"
import type SyncWorker from ".."
import Lock from "./lock"

/**
 * Sync
 *
 * @export
 * @class Sync
 * @typedef {Sync}
 */
export class Sync {
	public readonly sdk: FilenSDK
	public readonly syncPair: SyncPair
	private isInitialized = false
	public readonly localFileSystem: LocalFileSystem
	public readonly remoteFileSystem: RemoteFileSystem
	public readonly deltas: Deltas
	public previousLocalTree: LocalTree = {
		tree: {},
		inodes: {}
	}
	public previousRemoteTree: RemoteTree = {
		tree: {},
		uuids: {}
	}
	public localFileHashes: Record<string, string> = {}
	public readonly tasks: Tasks
	public readonly state: State
	public readonly dbPath: string
	public readonly abortControllers: Record<string, AbortController> = {}
	public readonly pauseSignals: Record<string, PauseSignal> = {}
	public readonly ignorer: Ignorer
	public paused: boolean
	public mode: SyncMode
	public excludeDotFiles: boolean
	public readonly worker: SyncWorker
	public removed: boolean = false
	public saveStateOnNoChanges = true
	public readonly lock: Lock
	public taskErrors: TaskError[] = []

	/**
	 * Creates an instance of Sync.
	 *
	 * @constructor
	 * @public
	 * @param {{ syncPair: SyncPair; worker: SyncWorker }} param0
	 * @param {SyncPair} param0.syncPair
	 * @param {SyncWorker} param0.worker
	 */
	public constructor({ syncPair, worker }: { syncPair: SyncPair; worker: SyncWorker }) {
		this.worker = worker
		this.syncPair = syncPair
		this.mode = syncPair.mode
		this.paused = syncPair.paused
		this.excludeDotFiles = syncPair.excludeDotFiles
		this.dbPath = worker.dbPath
		this.sdk = worker.sdk
		this.localFileSystem = new LocalFileSystem(this)
		this.remoteFileSystem = new RemoteFileSystem(this)
		this.deltas = new Deltas(this)
		this.tasks = new Tasks(this)
		this.state = new State(this)
		this.ignorer = new Ignorer(this, "ignorer")
		this.lock = new Lock(this)
	}

	public async smokeTest(): Promise<void> {
		if (this.removed) {
			throw new Error("Aborted")
		}

		const localSmokeTest = await this.localFileSystem.isPathWritable(this.syncPair.localPath)

		if (!localSmokeTest) {
			postMessageToMain({
				type: "cycleLocalSmokeTestFailed",
				syncPair: this.syncPair
			})

			await new Promise<void>(resolve => setTimeout(resolve, SYNC_INTERVAL))

			return await this.smokeTest()
		}

		const remoteSmokeTest = await this.remoteFileSystem.remoteDirPathExisting()

		if (!remoteSmokeTest) {
			postMessageToMain({
				type: "cycleRemoteSmokeTestFailed",
				syncPair: this.syncPair
			})

			await new Promise<void>(resolve => setTimeout(resolve, SYNC_INTERVAL))

			return await this.smokeTest()
		}
	}

	public async initialize(): Promise<void> {
		if (this.isInitialized) {
			return
		}

		this.isInitialized = true

		try {
			await this.smokeTest()

			await Promise.all([this.localFileSystem.startDirectoryWatcher(), this.state.initialize(), this.ignorer.initialize()])

			this.run()
		} catch (e) {
			this.worker.logger.log("error", e, "sync.initialize")

			this.isInitialized = false

			throw e
		}
	}

	public async cleanup(): Promise<void> {
		await this.localFileSystem.stopDirectoryWatcher()

		this.isInitialized = false

		postMessageToMain({
			type: "cycleExited",
			syncPair: this.syncPair
		})
	}

	private async run(): Promise<void> {
		if (this.removed) {
			postMessageToMain({
				type: "syncPairRemoved",
				syncPair: this.syncPair
			})

			return
		}

		try {
			if (this.taskErrors.length > 0) {
				if (this.worker.runOnce) {
					await this.cleanup()

					return
				}

				postMessageToMain({
					type: "taskErrors",
					syncPair: this.syncPair,
					data: {
						errors: this.taskErrors.map(e => ({
							...e,
							error: serializeError(e.error)
						}))
					}
				})

				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				return
			}

			if (this.paused) {
				if (this.worker.runOnce) {
					await this.cleanup()

					return
				}

				postMessageToMain({
					type: "cyclePaused",
					syncPair: this.syncPair
				})

				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				return
			}

			postMessageToMain({
				type: "cycleStarted",
				syncPair: this.syncPair
			})

			await this.smokeTest()

			postMessageToMain({
				type: "cycleWaitingForLocalDirectoryChangesStarted",
				syncPair: this.syncPair
			})

			await this.localFileSystem.waitForLocalDirectoryChanges()

			postMessageToMain({
				type: "cycleWaitingForLocalDirectoryChangesDone",
				syncPair: this.syncPair
			})

			postMessageToMain({
				type: "cycleGettingTreesStarted",
				syncPair: this.syncPair
			})

			// eslint-disable-next-line prefer-const
			let [currentLocalTree, currentRemoteTree] = await Promise.all([
				this.localFileSystem.getDirectoryTree(),
				this.remoteFileSystem.getDirectoryTree()
			])

			postMessageToMain({
				type: "cycleGettingTreesDone",
				syncPair: this.syncPair
			})

			postMessageToMain({
				type: "localTreeErrors",
				syncPair: this.syncPair,
				data: {
					errors: currentLocalTree.errors.map(e => ({
						...e,
						error: serializeError(e.error)
					}))
				}
			})

			postMessageToMain({
				type: "localTreeIgnored",
				syncPair: this.syncPair,
				data: {
					ignored: currentLocalTree.ignored
				}
			})

			if (!currentLocalTree.changed && !currentRemoteTree.changed) {
				if (this.taskErrors.length === 0) {
					postMessageToMain({
						type: "cycleSavingStateStarted",
						syncPair: this.syncPair
					})

					this.previousLocalTree = currentLocalTree.result
					this.previousRemoteTree = currentRemoteTree.result

					// We only save the state once if there are no changes.
					// This helps reducing the cpu and disk footprint when there are continuously no changes.
					if (this.saveStateOnNoChanges) {
						this.saveStateOnNoChanges = false

						await this.state.save()
					}

					postMessageToMain({
						type: "cycleSavingStateDone",
						syncPair: this.syncPair
					})
				}

				postMessageToMain({
					type: "cycleNoChanges",
					syncPair: this.syncPair
				})

				return
			}

			postMessageToMain({
				type: "remoteTreeIgnored",
				syncPair: this.syncPair,
				data: {
					ignored: currentRemoteTree.ignored
				}
			})

			postMessageToMain({
				type: "cycleProcessingDeltasStarted",
				syncPair: this.syncPair
			})

			const deltas = await this.deltas.process({
				currentLocalTree: currentLocalTree.result,
				currentRemoteTree: currentRemoteTree.result,
				previousLocalTree: this.previousLocalTree,
				previousRemoteTree: this.previousRemoteTree,
				currentLocalTreeErrors: currentLocalTree.errors
			})

			postMessageToMain({
				type: "cycleProcessingDeltasDone",
				syncPair: this.syncPair
			})

			this.worker.logger.log("info", { deltas, localErrors: currentLocalTree.errors })

			postMessageToMain({
				type: "cycleProcessingTasksStarted",
				syncPair: this.syncPair
			})

			const { doneTasks, errors } = await this.tasks.process({ deltas })

			this.taskErrors = errors

			postMessageToMain({
				type: "cycleProcessingTasksDone",
				syncPair: this.syncPair
			})

			postMessageToMain({
				type: "taskErrors",
				syncPair: this.syncPair,
				data: {
					errors: errors.map(e => ({
						...e,
						error: serializeError(e.error)
					}))
				}
			})

			if (this.taskErrors.length === 0) {
				if (doneTasks.length > 0) {
					postMessageToMain({
						type: "cycleApplyingStateStarted",
						syncPair: this.syncPair
					})

					const applied = this.state.applyDoneTasksToState({
						doneTasks,
						currentLocalTree: currentLocalTree.result,
						currentRemoteTree: currentRemoteTree.result
					})

					currentLocalTree.result = applied.currentLocalTree
					currentRemoteTree.result = applied.currentRemoteTree

					postMessageToMain({
						type: "cycleApplyingStateDone",
						syncPair: this.syncPair
					})
				}

				postMessageToMain({
					type: "cycleSavingStateStarted",
					syncPair: this.syncPair
				})

				this.previousLocalTree = currentLocalTree.result
				this.previousRemoteTree = currentRemoteTree.result
				this.saveStateOnNoChanges = true

				await this.state.save()

				postMessageToMain({
					type: "cycleSavingStateDone",
					syncPair: this.syncPair
				})
			}

			postMessageToMain({
				type: "cycleSuccess",
				syncPair: this.syncPair
			})
		} catch (e) {
			this.worker.logger.log("error", e, "sync.run")

			if (e instanceof Error) {
				postMessageToMain({
					type: "cycleError",
					syncPair: this.syncPair,
					data: {
						error: serializeError(e)
					}
				})
			}
		} finally {
			if (this.worker.runOnce || this.removed) {
				await this.cleanup()
			} else {
				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				setTimeout(() => {
					this.run()
				}, SYNC_INTERVAL)
			}
		}
	}
}

export default Sync
