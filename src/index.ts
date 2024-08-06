import { type SyncPair, type SyncMessage, type SyncMode } from "./types"
import Sync from "./lib/sync"
import FilenSDK, { type FilenSDKConfig } from "@filen/sdk"
import { Semaphore } from "./semaphore"
import { SYNC_INTERVAL } from "./constants"
import Logger from "./lib/logger"

/**
 * SyncWorker
 * @date 2/23/2024 - 5:50:56 AM
 *
 * @export
 * @class SyncWorker
 * @typedef {SyncWorker}
 */
export class SyncWorker {
	public readonly syncPairs: SyncPair[]
	public readonly syncs: Record<string, Sync> = {}
	public readonly dbPath: string
	public readonly updateSyncPairsMutex = new Semaphore(1)
	public readonly sdk: FilenSDK
	public readonly logger: Logger
	public readonly runOnce: boolean

	public constructor({
		syncPairs,
		dbPath,
		sdkConfig,
		onMessage,
		runOnce = false,
		sdk
	}: {
		syncPairs: SyncPair[]
		dbPath: string
		sdkConfig?: FilenSDKConfig
		onMessage?: (message: SyncMessage) => void
		runOnce?: boolean
		sdk?: FilenSDK
	}) {
		if (!sdk && !sdkConfig) {
			throw new Error("Either pass a configured SDK instance OR a SDKConfig object.")
		}

		if (onMessage) {
			process.onMessage = onMessage
		}

		this.runOnce = runOnce
		this.syncPairs = syncPairs
		this.dbPath = dbPath
		this.logger = new Logger(dbPath)
		this.sdk = sdk
			? sdk
			: new FilenSDK({
					...sdkConfig,
					connectToSocket: true,
					metadataCache: true
			  })
	}

	public resetCache(uuid: string): void {
		for (const pair of this.syncPairs) {
			const sync = this.syncs[pair.uuid]

			if (!sync || pair.uuid !== uuid) {
				continue
			}

			sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL * 2
			sync.localFileSystem.getDirectoryTreeCache = {
				timestamp: 0,
				tree: {},
				inodes: {},
				ignored: [],
				errors: []
			}

			sync.remoteFileSystem.previousTreeRawResponse = ""
			sync.remoteFileSystem.getDirectoryTreeCache = {
				timestamp: 0,
				tree: {},
				uuids: {},
				ignored: []
			}

			sync.ignorer.cache = {}
		}
	}

	public resetTaskErrors(uuid: string): void {
		for (const pair of this.syncPairs) {
			const sync = this.syncs[pair.uuid]

			if (!sync || pair.uuid !== uuid) {
				continue
			}

			sync.taskErrors = []
		}
	}

	public resetLocalTreeErrors(uuid: string): void {
		for (const pair of this.syncPairs) {
			const sync = this.syncs[pair.uuid]

			if (!sync || pair.uuid !== uuid) {
				continue
			}

			sync.localTreeErrors = []
		}
	}

	public toggleLocalTrash(uuid: string, enabled: boolean): void {
		for (const pair of this.syncPairs) {
			const sync = this.syncs[pair.uuid]

			if (!sync || pair.uuid !== uuid) {
				continue
			}

			sync.localTrashDisabled = enabled
		}
	}

	/**
	 * Update sync pairs.
	 *
	 * @public
	 * @async
	 * @param {SyncPair[]} pairs
	 * @returns {Promise<void>}
	 */
	public async updateSyncPairs(pairs: SyncPair[]): Promise<void> {
		await this.updateSyncPairsMutex.acquire()

		try {
			const promises: Promise<void>[] = []

			for (const pair of pairs) {
				if (!this.syncs[pair.uuid]) {
					this.syncs[pair.uuid] = new Sync({
						syncPair: pair,
						worker: this
					})

					promises.push(this.syncs[pair.uuid]!.initialize())
				}
			}

			await Promise.all(promises)
		} catch (e) {
			this.logger.log("error", e, "index.updateSyncPairs")

			throw e
		} finally {
			this.updateSyncPairsMutex.release()
		}
	}

	public updatePaused(uuid: string, paused: boolean): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				this.syncs[syncUUID]!.paused = paused

				const pauseSignals = this.syncs[syncUUID]!.pauseSignals

				for (const signal in pauseSignals) {
					const pauseSignal = pauseSignals[signal]!

					if (paused) {
						if (!pauseSignal.isPaused()) {
							pauseSignal.pause()
						}
					} else {
						if (pauseSignal.isPaused()) {
							pauseSignal.resume()
						}
					}
				}

				break
			}
		}
	}

	public updateRemoved(uuid: string, removed: boolean): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				this.syncs[syncUUID]!.removed = removed

				const abortControllers = this.syncs[syncUUID]!.abortControllers

				for (const controller in abortControllers) {
					const abortController = abortControllers[controller]!

					if (removed) {
						if (!abortController.signal.aborted) {
							abortController.abort()
						}
					}
				}

				break
			}
		}
	}

	public updateExcludeDotFiles(uuid: string, excludeDotFiles: boolean): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				this.syncs[syncUUID]!.excludeDotFiles = excludeDotFiles

				break
			}
		}
	}

	public updateMode(uuid: string, mode: SyncMode): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				this.syncs[syncUUID]!.mode = mode

				break
			}
		}
	}

	public updateIgnorerContent(uuid: string, content?: string): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				this.syncs[syncUUID]!.ignorer.update(content)

				break
			}
		}
	}

	public async fetchIgnorerContent(uuid: string): Promise<string> {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				return await this.syncs[syncUUID]!.ignorer.fetch()
			}
		}

		return ""
	}

	public stopTransfer(uuid: string, type: "download" | "upload", relativePath: string): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				const abortControllers = this.syncs[syncUUID]!.abortControllers
				const signalKey = `${type}:${relativePath}`
				const abortController = abortControllers[signalKey]

				if (abortController && !abortController.signal.aborted) {
					abortController.abort()
				}

				break
			}
		}
	}

	public pauseTransfer(uuid: string, type: "download" | "upload", relativePath: string): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				const pauseSignals = this.syncs[syncUUID]!.pauseSignals
				const signalKey = `${type}:${relativePath}`
				const pauseSignal = pauseSignals[signalKey]

				if (pauseSignal && !pauseSignal.isPaused()) {
					pauseSignal.pause()
				}

				break
			}
		}
	}

	public resumeTransfer(uuid: string, type: "download" | "upload", relativePath: string): void {
		for (const syncUUID in this.syncs) {
			if (syncUUID === uuid) {
				const pauseSignals = this.syncs[syncUUID]!.pauseSignals
				const signalKey = `${type}:${relativePath}`
				const pauseSignal = pauseSignals[signalKey]

				if (pauseSignal && pauseSignal.isPaused()) {
					pauseSignal.resume()
				}

				break
			}
		}
	}

	/**
	 * Initialize the Sync worker.
	 * @date 2/23/2024 - 5:51:12 AM
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async initialize(): Promise<void> {
		await this.updateSyncPairs(this.syncPairs)
	}
}

export * from "./utils"
export default SyncWorker
