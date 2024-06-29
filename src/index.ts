import { type SyncPair, type SyncMessage } from "./types"
import Sync from "./lib/sync"
import FilenSDK, { type FilenSDKConfig } from "@filen/sdk"
import { isMainThread, parentPort } from "worker_threads"
import { postMessageToMain } from "./lib/ipc"
import { Semaphore } from "./semaphore"
import { SYNC_INTERVAL } from "./constants"
import { serializeError } from "./utils"

/**
 * SyncWorker
 * @date 2/23/2024 - 5:50:56 AM
 *
 * @export
 * @class SyncWorker
 * @typedef {SyncWorker}
 */
export class SyncWorker {
	private readonly syncPairs: SyncPair[]
	private readonly syncs: Record<string, Sync> = {}
	private readonly dbPath: string
	private readonly initSyncPairsMutex = new Semaphore(1)
	private readonly sdk: FilenSDK

	/**
	 * Creates an instance of SyncWorker.
	 *
	 * @constructor
	 * @public
	 * @param {{ syncPairs: SyncPair[]; dbPath: string; sdkConfig: FilenSDKConfig }} param0
	 * @param {{}} param0.syncPairs
	 * @param {string} param0.dbPath
	 * @param {FilenSDKConfig} param0.sdkConfig
	 */
	public constructor({ syncPairs, dbPath, sdkConfig }: { syncPairs: SyncPair[]; dbPath: string; sdkConfig: FilenSDKConfig }) {
		this.syncPairs = syncPairs
		this.dbPath = dbPath
		this.sdk = new FilenSDK({
			...sdkConfig,
			connectToSocket: true,
			metadataCache: true
		})

		this.setupMainThreadListeners()
	}

	/**
	 * Sets up receiving message from the main thread.
	 *
	 * @private
	 */
	private setupMainThreadListeners(): void {
		const receiver = !isMainThread && parentPort ? parentPort : process

		receiver.on("message", async (message: SyncMessage) => {
			if (message.type === "updateSyncPairs") {
				try {
					await this.initSyncPairs(message.data.pairs)

					if (message.data.resetCache) {
						this.resetSyncPairsCache()
					}

					postMessageToMain({
						type: "syncPairsUpdated"
					})
				} catch (e) {
					// TODO: Proper debugger

					console.error(e)

					if (e instanceof Error) {
						postMessageToMain({
							type: "error",
							data: {
								error: serializeError(e)
							}
						})
					}
				}
			} else if (message.type === "resetSyncPairCache") {
				this.resetSyncPairsCache()
			}
		})
	}

	private resetSyncPairsCache(): void {
		for (const pair of this.syncPairs) {
			const sync = this.syncs[pair.uuid]

			if (!sync) {
				continue
			}

			sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL * 2
			sync.localFileSystem.getDirectoryTreeCache = {
				timestamp: 0,
				tree: {},
				inodes: {}
			}

			sync.remoteFileSystem.previousTreeRawResponse = ""
			sync.remoteFileSystem.getDirectoryTreeCache = {
				timestamp: 0,
				tree: {},
				uuids: {}
			}
		}
	}

	/**
	 * Initialize sync pairs.
	 *
	 * @private
	 * @async
	 * @param {SyncPair[]} pairs
	 * @returns {Promise<void>}
	 */
	private async initSyncPairs(pairs: SyncPair[]): Promise<void> {
		await this.initSyncPairsMutex.acquire()

		try {
			const promises: Promise<void>[] = []

			for (const pair of pairs) {
				if (!this.syncs[pair.uuid]) {
					this.syncs[pair.uuid] = new Sync({
						syncPair: pair,
						dbPath: this.dbPath,
						sdk: this.sdk
					})

					promises.push(this.syncs[pair.uuid]!.initialize())
				}
			}

			await Promise.all(promises)
		} finally {
			this.initSyncPairsMutex.release()
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
		await this.initSyncPairs(this.syncPairs)
	}
}

export * from "./utils"
export default SyncWorker
