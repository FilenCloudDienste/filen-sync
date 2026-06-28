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
import { type SyncEnvironment } from "./environment"
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
	public readonly environment: SyncEnvironment
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
	public cleanupLocalTrashInterval: ReturnType<typeof setInterval> | undefined = undefined
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
		this.environment = worker.environment
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
		// Loop rather than recurse: during a prolonged outage this retries once per SYNC_INTERVAL, and the
		// old `return await this.smokeTest()` tail-recursion accumulated one suspended async frame per retry
		// (unbounded memory growth over a long outage). `this.removed` is re-checked every iteration so a
		// pair removed mid-outage aborts promptly. The caller runs this BEFORE acquiring the lock, so an
		// outage stalls only this pair's cycle and never holds the account lock (cross-device starvation).
		while (true) {
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

				continue
			}

			const remoteSmokeTest = await this.remoteFileSystem.remoteDirPathExisting()

			if (!remoteSmokeTest) {
				this.worker.logger.log("error", "Remote smoke test failed, path does not exist or is in the trash", this.syncPair.remotePath)

				postMessageToMain({
					type: "cycleRemoteSmokeTestFailed",
					syncPair: this.syncPair
				})

				await new Promise<void>(resolve => setTimeout(resolve, SYNC_INTERVAL))

				continue
			}

			return
		}
	}

	public cleanupLocalTrash(): void {
		// Keep the timer handle so cleanup() can clear it. Previously the handle was discarded, so a removed
		// pair's interval kept firing every 5 minutes forever — pinning the whole Sync (and its trees) in
		// memory and burning a periodic glob/stat on a dead pair.
		this.cleanupLocalTrashInterval = setInterval(() => {
			void this.cleanupLocalTrashOnce()
		}, 300000)
	}

	public async cleanupLocalTrashOnce(): Promise<void> {
		if (this.cleaningLocalTrash) {
			return
		}

		this.cleaningLocalTrash = true

		try {
			const localTrashPath = pathModule.join(this.syncPair.localPath, LOCAL_TRASH_NAME)

			if (await this.environment.fs.exists(localTrashPath)) {
				const now = Date.now()
				const dir = await FastGlob.async("**/*", {
					dot: true,
					onlyDirectories: false,
					// Deletes move whole DIRECTORIES into the trash (by basename), so the eviction sweep must
					// age out directories too. With onlyFiles:true the glob skipped every trashed directory and
					// (because deep:0 also stops it descending) their contents — so trashed directories leaked
					// and accumulated forever. The rm below already recurses, so an old top-level dir is removed
					// wholesale.
					onlyFiles: false,
					throwErrorOnBrokenSymbolicLink: false,
					cwd: localTrashPath,
					followSymbolicLinks: false,
					deep: 0,
					fs: this.environment.globFs,
					suppressErrors: true,
					stats: true,
					unique: true,
					objectMode: true
				})

				for (const entry of dir) {
					if (!entry) {
						continue
					}

					if (entry.stats && entry.stats.atimeMs + 86400000 * 30 < now) {
						await this.environment.fs.rm(pathModule.join(localTrashPath, entry.path), {
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
		if (this.cleanupLocalTrashInterval) {
			clearInterval(this.cleanupLocalTrashInterval)

			this.cleanupLocalTrashInterval = undefined
		}

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
			await this.runCycle()
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

	/**
	 * Run exactly one synchronization cycle without scheduling the next one.
	 *
	 * This is the body of a single pass: error/pause gating, lock acquisition,
	 * tree diffing, delta processing, task execution and state persistence. It
	 * never throws (failures are caught and reported as a "cycleError" message)
	 * and never reschedules — {@link run} owns the self-scheduling loop. Exposed
	 * so a single cycle can be driven deterministically.
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async runCycle(): Promise<void> {
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

			// Smoke-test BEFORE acquiring the lock. The local smoke test retries every SYNC_INTERVAL for as
			// long as the local path is unavailable (an unmounted drive, a disconnected network FS). Under the
			// lock that would hold the account lock for the WHOLE outage and starve every other device; run
			// outside it, an outage stalls only this pair's cycle.
			await this.smokeTest()

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
						deleteRemoteFileCountRaw,
						// The mode the deltas were computed under (snapshotted once inside process()). Use it for the
						// deletion-confirmation gate below so the gate and the delta set never disagree when
						// updateMode() races the cycle. (M6)
						mode: cycleMode
					} = await this.deltas.process({
						currentLocalTree: currentLocalTree.result,
						currentRemoteTree: currentRemoteTree.result,
						previousLocalTree: this.previousLocalTree,
						previousRemoteTree: this.previousRemoteTree,
						currentLocalTreeErrors: currentLocalTree.errors,
						currentLocalTreeIgnored: currentLocalTree.ignored
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
						(cycleMode === "twoWay" || cycleMode === "localToCloud")

					const confirmRemoteDeletion =
						this.previousRemoteTree.size > 0 &&
						currentRemoteTree.result.size === 0 &&
						deleteLocalDirectoryCountRaw + deleteLocalFileCountRaw > 0 &&
						this.previousRemoteTree.size <= deleteLocalDirectoryCountRaw + deleteLocalFileCountRaw &&
						(cycleMode === "twoWay" || cycleMode === "cloudToLocal")

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
								// Also bail when the pair is paused or removed while we wait — otherwise the cycle
								// spins here indefinitely (the user may never answer) while HOLDING the lock, which
								// starves every other device on the account. A bail-out leaves the decision as
								// "waiting", so the skip-and-restart path below releases the lock and exits cleanly.
								if (this.deletionConfirmationResult !== "waiting" || this.paused || this.removed) {
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

							// Snapshot the trees as the next cycle's base. We need NEW tree/inode/uuid MAPS so the
							// directory-tree cache's in-place incremental updates (the watcher add/remove/rename path)
							// can never bleed into the base — but the item objects can be SHARED by reference: an item
							// is always created fresh and replaced in the map, never mutated field-by-field, so the
							// base's items are immutable once snapshotted. A full structuredClone instead deep-copied
							// every item on every change-cycle — O(tree) CPU plus a second full copy of the tree in
							// memory — for isolation a shallow map copy already provides. (P3)
							this.previousLocalTree = {
								tree: { ...currentLocalTree.result.tree },
								inodes: { ...currentLocalTree.result.inodes },
								size: currentLocalTree.result.size
							}
							this.previousRemoteTree = {
								tree: { ...currentRemoteTree.result.tree },
								uuids: { ...currentRemoteTree.result.uuids },
								size: currentRemoteTree.result.size
							}

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
		}
	}
}

export default Sync
