import FilenSDK, { type PauseSignal } from "@filen/sdk"
import { type SyncPair, type SyncMode } from "../types"
import { SYNC_INTERVAL, LOCAL_TRASH_NAME } from "../constants"
import { LocalFileSystem, LocalTree, type LocalTreeError } from "./filesystems/local"
import { RemoteFileSystem, RemoteTree } from "./filesystems/remote"
import Deltas from "./deltas"
import Tasks, { type TaskError } from "./tasks"
import State from "./state"
import { postMessageToMain } from "./ipc"
import Ignorer from "../ignorer"
import { serializeError } from "../utils"
import type SyncWorker from ".."
import Lock from "./lock"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"
import FastGlob from "fast-glob"

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
		inodes: {},
		size: 0
	}
	public previousRemoteTree: RemoteTree = {
		tree: {},
		uuids: {},
		size: 0
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
	public readonly lock: Lock
	public taskErrors: TaskError[] = []
	public localTrashDisabled: boolean
	public localTreeErrors: LocalTreeError[] = []
	public cleaningLocalTrash: boolean = false
	public isPreviousSavedTreeStateEmpty: boolean = true
	public requireConfirmationOnLargeDeletion: boolean
	public deletionConfirmationResult: "delete" | "restart" | "waiting" = "waiting"

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
		this.localTrashDisabled = syncPair.localTrashDisabled
		this.requireConfirmationOnLargeDeletion =
			typeof syncPair.requireConfirmationOnLargeDeletion === "boolean" ? syncPair.requireConfirmationOnLargeDeletion : false
		this.localFileSystem = new LocalFileSystem(this)
		this.remoteFileSystem = new RemoteFileSystem(this)
		this.deltas = new Deltas(this)
		this.tasks = new Tasks(this)
		this.state = new State(this)
		this.ignorer = new Ignorer(this, "ignorer")
		this.lock = new Lock({
			sync: this,
			resource: `sync-remoteParentUUID-${this.syncPair.remoteParentUUID}`
		})

		this.cleanupLocalTrash()
	}

	public async smokeTest(): Promise<void> {
		if (this.removed) {
			throw new Error("Aborted")
		}

		const localSmokeTest =
			this.mode === "cloudBackup" || this.mode === "cloudToLocal" || this.mode === "twoWay"
				? await this.localFileSystem.isPathWritable(this.syncPair.localPath)
				: await this.localFileSystem.isPathReadable(this.syncPair.localPath)

		if (!localSmokeTest) {
			await this.localFileSystem.stopDirectoryWatcher()

			this.worker.logger.log(
				"error",
				"Local smoke test failed, path not existing or not readable or writable",
				this.syncPair.localPath
			)

			postMessageToMain({
				type: "cycleLocalSmokeTestFailed",
				syncPair: this.syncPair
			})

			await new Promise<void>(resolve => setTimeout(resolve, SYNC_INTERVAL))

			return await this.smokeTest()
		}

		const remoteSmokeTest = await this.remoteFileSystem.remoteDirPathExisting()

		if (!remoteSmokeTest) {
			this.worker.logger.log("error", "Remote smoke test failed, path does not exist or is in the trash", this.syncPair.remotePath)

			postMessageToMain({
				type: "cycleRemoteSmokeTestFailed",
				syncPair: this.syncPair
			})

			await new Promise<void>(resolve => setTimeout(resolve, SYNC_INTERVAL))

			return await this.smokeTest()
		}
	}

	public cleanupLocalTrash(): void {
		setInterval(async () => {
			if (this.cleaningLocalTrash) {
				return
			}

			this.cleaningLocalTrash = true

			try {
				const localTrashPath = pathModule.join(this.syncPair.localPath, LOCAL_TRASH_NAME)

				if (await fs.exists(localTrashPath)) {
					const now = Date.now()
					const dir = await FastGlob.async("**/*", {
						dot: true,
						onlyDirectories: false,
						onlyFiles: true,
						throwErrorOnBrokenSymbolicLink: false,
						cwd: localTrashPath,
						followSymbolicLinks: false,
						deep: 0,
						fs,
						suppressErrors: true,
						stats: true,
						unique: true,
						objectMode: true
					})

					for (const entry of dir) {
						if (!entry) {
							return
						}

						if (entry.stats && entry.stats.atimeMs + 86400000 * 30 < now) {
							await fs.rm(pathModule.join(localTrashPath, entry.path), {
								force: true,
								maxRetries: 60 * 10,
								recursive: true,
								retryDelay: 100
							})
						}
					}
				}
			} catch (e) {
				this.worker.logger.log("error", e, "sync.cleanupLocalTrash")
				this.worker.logger.log("error", e)
			} finally {
				this.cleaningLocalTrash = false
			}
		}, 300000)
	}

	public async initialize(): Promise<void> {
		if (this.isInitialized) {
			return
		}

		this.isInitialized = true

		try {
			await this.smokeTest()

			await Promise.all([this.state.initialize(), this.ignorer.initialize()])

			this.worker.logger.log("info", "Initialized", this.syncPair.localPath)

			this.run()
		} catch (e) {
			this.worker.logger.log("error", e, "sync.initialize")
			this.worker.logger.log("error", e)

			this.isInitialized = false

			throw e
		}
	}

	public async cleanup({ deleteLocalDbFiles = false }: { deleteLocalDbFiles?: boolean }): Promise<void> {
		try {
			await Promise.all([
				this.localFileSystem.stopDirectoryWatcher(),
				deleteLocalDbFiles ? this.deleteLocalSyncDbFiles() : Promise.resolve()
			])

			this.worker.logger.log("info", "Cleanup done", this.syncPair.localPath)
		} catch (e) {
			this.worker.logger.log("error", e, "sync.cleanup")
			this.worker.logger.log("error", e)
		}

		this.isInitialized = false
		this.removed = true

		postMessageToMain({
			type: "cycleExited",
			syncPair: this.syncPair
		})
	}

	public async deleteLocalSyncDbFiles(): Promise<void> {
		await Promise.all([this.remoteFileSystem.clearDeviceId(), this.state.clear(), this.ignorer.clearFile()])
	}

	private async run(): Promise<void> {
		if (this.removed) {
			await this.cleanup({
				deleteLocalDbFiles: true
			})

			return
		}

		try {
			if (this.taskErrors.length > 0 || this.localTreeErrors.length > 0) {
				if (this.worker.runOnce) {
					await this.cleanup({
						deleteLocalDbFiles: false
					})

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
					type: "localTreeErrors",
					syncPair: this.syncPair,
					data: {
						errors: this.localTreeErrors.map(e => ({
							...e,
							error: serializeError(e.error)
						}))
					}
				})

				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				this.worker.logger.log("error", "Not continueing sync cycle, got taskErrors or localTreeErrors", this.syncPair.localPath)
				this.worker.logger.log(
					"error",
					{
						taskErrors: this.taskErrors,
						localTreeErrors: this.localTreeErrors
					},
					this.syncPair.localPath
				)

				return
			}

			if (this.paused) {
				if (this.worker.runOnce) {
					await this.cleanup({
						deleteLocalDbFiles: false
					})

					return
				}

				postMessageToMain({
					type: "cyclePaused",
					syncPair: this.syncPair
				})

				postMessageToMain({
					type: "cycleSuccess",
					syncPair: this.syncPair
				})

				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				return
			}

			// It will only start it once. We call it here every run in case it hasn't been started yet for some reason.
			// This is useful for example after a failed local smoke test.
			await this.localFileSystem.startDirectoryWatcher()

			postMessageToMain({
				type: "cycleStarted",
				syncPair: this.syncPair
			})

			const acquireLockMessageTimeout = setTimeout(() => {
				postMessageToMain({
					type: "cycleAcquiringLockStarted",
					syncPair: this.syncPair
				})
			}, 3000)

			await this.lock.acquire()

			clearTimeout(acquireLockMessageTimeout)

			postMessageToMain({
				type: "cycleAcquiringLockDone",
				syncPair: this.syncPair
			})

			try {
				await this.smokeTest()
				await this.localFileSystem.waitForLocalDirectoryChanges()

				postMessageToMain({
					type: "cycleWaitingForLocalDirectoryChangesDone",
					syncPair: this.syncPair
				})

				const gettingTreesMessageTimeout = setTimeout(() => {
					postMessageToMain({
						type: "cycleGettingTreesStarted",
						syncPair: this.syncPair
					})
				}, 1000)

				// Init the ignorer on every run. We might have changes in the physical .filenignore file
				await this.ignorer.initialize()

				// eslint-disable-next-line prefer-const
				let [currentLocalTree, currentRemoteTree] = await Promise.all([
					this.localFileSystem.getDirectoryTree(),
					this.remoteFileSystem.getDirectoryTree()
				])

				clearTimeout(gettingTreesMessageTimeout)

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

				this.localTreeErrors = currentLocalTree.errors

				// Only continue if we did not encounter any local tree related errors
				if (this.localTreeErrors.length === 0) {
					postMessageToMain({
						type: "localTreeIgnored",
						syncPair: this.syncPair,
						data: {
							ignored: currentLocalTree.ignored
						}
					})

					if (!currentLocalTree.changed && !currentRemoteTree.changed) {
						postMessageToMain({
							type: "cycleSuccess",
							syncPair: this.syncPair
						})

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

					const {
						deltas,
						deleteLocalDirectoryCountRaw,
						deleteLocalFileCountRaw,
						deleteRemoteDirectoryCountRaw,
						deleteRemoteFileCountRaw
					} = await this.deltas.process({
						currentLocalTree: currentLocalTree.result,
						currentRemoteTree: currentRemoteTree.result,
						previousLocalTree: this.previousLocalTree,
						previousRemoteTree: this.previousRemoteTree,
						currentLocalTreeErrors: currentLocalTree.errors
					})

					postMessageToMain({
						type: "deltasCount",
						syncPair: this.syncPair,
						data: {
							count: deltas.length
						}
					})

					postMessageToMain({
						type: "deltasSize",
						syncPair: this.syncPair,
						data: {
							size: deltas.reduce(
								(prev, delta) => prev + (delta.type === "uploadFile" || delta.type === "downloadFile" ? delta.size : 0),
								0
							)
						}
					})

					postMessageToMain({
						type: "cycleProcessingDeltasDone",
						syncPair: this.syncPair
					})

					const confirmLocalDeletion =
						this.previousLocalTree.size > 0 &&
						currentLocalTree.result.size === 0 &&
						deleteRemoteDirectoryCountRaw + deleteRemoteFileCountRaw > 0 &&
						this.previousLocalTree.size <= deleteRemoteDirectoryCountRaw + deleteRemoteFileCountRaw &&
						(this.mode === "twoWay" || this.mode === "localToCloud")

					const confirmRemoteDeletion =
						this.previousRemoteTree.size > 0 &&
						currentRemoteTree.result.size === 0 &&
						deleteLocalDirectoryCountRaw + deleteLocalFileCountRaw > 0
					this.previousRemoteTree.size <= deleteLocalDirectoryCountRaw + deleteLocalFileCountRaw &&
						(this.mode === "twoWay" || this.mode === "cloudToLocal")

					let skipSyncDueToConfirmDeletionRestart = false

					// If the previous tree has nodes and the current one is empty, we should prompt the user to confirm deletion
					if (this.requireConfirmationOnLargeDeletion && (confirmLocalDeletion || confirmRemoteDeletion)) {
						this.deletionConfirmationResult = "waiting"

						const sendConfirmationMessage = () => {
							postMessageToMain({
								type: "confirmDeletion",
								syncPair: this.syncPair,
								data: {
									where:
										confirmLocalDeletion && confirmRemoteDeletion ? "both" : confirmLocalDeletion ? "local" : "remote",
									previous:
										confirmLocalDeletion && confirmRemoteDeletion
											? this.previousLocalTree.size + this.previousRemoteTree.size
											: confirmLocalDeletion
											? this.previousLocalTree.size
											: this.previousRemoteTree.size,
									current:
										confirmLocalDeletion && confirmRemoteDeletion
											? currentLocalTree.result.size + currentRemoteTree.result.size
											: confirmLocalDeletion
											? currentLocalTree.result.size
											: currentRemoteTree.result.size
								}
							})
						}

						sendConfirmationMessage()

						await new Promise<void>(resolve => {
							const interval = setInterval(() => {
								if (this.deletionConfirmationResult !== "waiting") {
									clearInterval(interval)

									resolve()
								} else {
									sendConfirmationMessage()
								}
							}, 1000)
						})

						if (this.deletionConfirmationResult === "waiting" || this.deletionConfirmationResult === "restart") {
							skipSyncDueToConfirmDeletionRestart = true
						}
					}

					if (!skipSyncDueToConfirmDeletionRestart) {
						postMessageToMain({
							type: "cycleProcessingTasksStarted",
							syncPair: this.syncPair
						})

						const { doneTasks, errors } = await this.tasks.process({ deltasSorted: deltas })

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

						this.taskErrors = errors

						if (this.taskErrors.length === 0) {
							if (doneTasks.length > 0) {
								postMessageToMain({
									type: "cycleApplyingStateStarted",
									syncPair: this.syncPair
								})

								const didLocalChanges = doneTasks.some(
									task =>
										task.type === "createLocalDirectory" ||
										task.type === "deleteLocalDirectory" ||
										task.type === "deleteLocalFile" ||
										task.type === "renameLocalDirectory" ||
										task.type === "renameLocalFile"
								)
								const didRemoteChanges = doneTasks.some(
									task =>
										task.type === "renameRemoteDirectory" ||
										task.type === "renameRemoteFile" ||
										task.type === "createRemoteDirectory" ||
										task.type === "deleteRemoteDirectory" ||
										task.type === "deleteRemoteFile"
								)

								// Here we reset the internal local/remote tree changed times so we rescan after we did changes for consistency
								if (didLocalChanges) {
									this.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL * 2
									this.localFileSystem.getDirectoryTreeCache = {
										timestamp: 0,
										tree: {},
										inodes: {},
										ignored: [],
										errors: [],
										size: 0
									}
								}

								if (didRemoteChanges) {
									this.remoteFileSystem.getDirectoryTreeCache = {
										timestamp: 0,
										tree: {},
										uuids: {},
										ignored: [],
										size: 0
									}
								}

								/* 

								Removed due to redundancy. We do not need to apply the state again since we hold a reference to the FS (remote/local) "getDirectoryTreeCache" objects.
								
								const applied = this.state.applyDoneTasksToState({
									doneTasks,
									currentLocalTree: currentLocalTree.result,
									currentRemoteTree: currentRemoteTree.result
								})

								currentLocalTree.result = applied.currentLocalTree
								currentRemoteTree.result = applied.currentRemoteTree
								*/

								postMessageToMain({
									type: "cycleApplyingStateDone",
									syncPair: this.syncPair
								})
							}

							postMessageToMain({
								type: "cycleSavingStateStarted",
								syncPair: this.syncPair
							})

							// Deep cloning is needed, otherwise we just pass the reference
							this.previousLocalTree = structuredClone(currentLocalTree.result)
							this.previousRemoteTree = structuredClone(currentRemoteTree.result)

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
					}
				}
			} finally {
				postMessageToMain({
					type: "cycleReleasingLockStarted",
					syncPair: this.syncPair
				})

				await this.lock.release()

				postMessageToMain({
					type: "cycleReleasingLockDone",
					syncPair: this.syncPair
				})
			}
		} catch (e) {
			this.worker.logger.log("error", e, "sync.run")
			this.worker.logger.log("error", e)

			if (e instanceof Error) {
				postMessageToMain({
					type: "cycleError",
					syncPair: this.syncPair,
					data: {
						error: serializeError(e),
						uuid: uuidv4()
					}
				})
			}
		} finally {
			if (this.worker.runOnce || this.removed) {
				await this.cleanup({
					deleteLocalDbFiles: this.removed
				})
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
