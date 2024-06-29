import FilenSDK, { type PauseSignal } from "@filen/sdk"
import { type SyncPair, type SyncMessage, type SyncMode } from "../types"
import { SYNC_INTERVAL } from "../constants"
import { LocalFileSystem, LocalTree } from "./filesystems/local"
import { RemoteFileSystem, RemoteTree } from "./filesystems/remote"
import Deltas from "./deltas"
import Tasks from "./tasks"
import State from "./state"
import { postMessageToMain } from "./ipc"
import { isMainThread, parentPort } from "worker_threads"
import Ignorer from "../ignorer"
import { serializeError } from "../utils"
import type SyncWorker from ".."

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
	public readonly localIgnorer: Ignorer
	public readonly remoteIgnorer: Ignorer
	public paused: boolean
	public mode: SyncMode
	public excludeDotFiles: boolean
	public readonly worker: SyncWorker

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
		this.localIgnorer = new Ignorer(this, "localIgnorer")
		this.remoteIgnorer = new Ignorer(this, "remoteIgnorer")

		this.setupMainThreadListeners()
	}

	/**
	 * Sets up receiving message from the main thread.
	 *
	 * @private
	 */
	private setupMainThreadListeners(): void {
		const receiver = !isMainThread && parentPort ? parentPort : process

		receiver.on("message", (message: SyncMessage) => {
			if (message.type === "stopTransfer" && message.syncPair.uuid === this.syncPair.uuid) {
				const abortController = this.abortControllers[`${message.data.of}:${message.data.relativePath}`]

				if (!abortController || abortController.signal.aborted) {
					return
				}

				abortController.abort()
			} else if (message.type === "pauseTransfer" && message.syncPair.uuid === this.syncPair.uuid) {
				const pauseSignal = this.pauseSignals[`${message.data.of}:${message.data.relativePath}`]

				if (!pauseSignal || pauseSignal.isPaused()) {
					return
				}

				pauseSignal.pause()
			} else if (message.type === "resumeTransfer" && message.syncPair.uuid === this.syncPair.uuid) {
				const pauseSignal = this.pauseSignals[`${message.data.of}:${message.data.relativePath}`]

				if (!pauseSignal || !pauseSignal.isPaused()) {
					return
				}

				pauseSignal.resume()
			} else if (message.type === "updateLocalIgnorer" && message.syncPair.uuid === this.syncPair.uuid) {
				this.localIgnorer.update(message.data?.content).catch(console.error)
			} else if (message.type === "updateRemoteIgnorer" && message.syncPair.uuid === this.syncPair.uuid) {
				this.remoteIgnorer.update(message.data?.content).catch(console.error)
			} else if (message.type === "pauseSyncPair" && message.syncPair.uuid === this.syncPair.uuid) {
				this.paused = true
			} else if (message.type === "resumeSyncPair" && message.syncPair.uuid === this.syncPair.uuid) {
				this.paused = false
			} else if (message.type === "changeSyncPairMode" && message.syncPair.uuid === this.syncPair.uuid) {
				this.mode = message.data.mode
			} else if (message.type === "syncPairExcludeDotFiles" && message.syncPair.uuid === this.syncPair.uuid) {
				this.excludeDotFiles = true
			} else if (message.type === "syncPairIncludeDotFiles" && message.syncPair.uuid === this.syncPair.uuid) {
				this.excludeDotFiles = false
			}
		})
	}

	public async initialize(): Promise<void> {
		if (this.isInitialized) {
			return
		}

		this.isInitialized = true

		try {
			//local/remote smoke test

			await Promise.all([
				this.localFileSystem.startDirectoryWatcher(),
				this.state.initialize(),
				this.localIgnorer.initialize(),
				this.remoteIgnorer.initialize()
			])

			this.run()
		} catch (e) {
			this.worker.logger.log("error", e, "sync.initialize")

			this.isInitialized = false

			throw e
		}
	}

	private async run(): Promise<void> {
		if (this.paused) {
			postMessageToMain({
				type: "cyclePaused",
				syncPair: this.syncPair
			})

			setTimeout(() => {
				this.run()
			}, SYNC_INTERVAL)

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

		try {
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

			postMessageToMain({
				type: "deltas",
				syncPair: this.syncPair,
				data: {
					deltas
				}
			})

			console.log({ deltas, localErrors: currentLocalTree.errors })

			this.worker.logger.log("info", { deltas, localErrors: currentLocalTree.errors })

			postMessageToMain({
				type: "cycleProcessingTasksStarted",
				syncPair: this.syncPair
			})

			const { doneTasks, errors } = await this.tasks.process({ deltas })

			console.log({ doneTasks, errors })

			postMessageToMain({
				type: "cycleProcessingTasksDone",
				syncPair: this.syncPair
			})

			postMessageToMain({
				type: "doneTasks",
				syncPair: this.syncPair,
				data: {
					tasks: doneTasks.map(task => ({
						path: task.path,
						type: task.type,
						...(task.type === "uploadFile" ? { item: task.item } : {})
					})),
					errors: errors.map(e => ({
						...e,
						error: serializeError(e.error)
					}))
				}
			})

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

			await this.state.save()

			postMessageToMain({
				type: "cycleSavingStateDone",
				syncPair: this.syncPair
			})

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
			postMessageToMain({
				type: "cycleFinished",
				syncPair: this.syncPair
			})

			setTimeout(() => {
				this.run()
			}, SYNC_INTERVAL)

			postMessageToMain({
				type: "cycleRestarting",
				syncPair: this.syncPair
			})
		}
	}
}

export default Sync
