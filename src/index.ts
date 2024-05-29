import type { SyncPair } from "./types"
import Sync from "./lib/sync"
import { type FilenSDKConfig } from "@filen/sdk"

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
	private readonly sdkConfig: FilenSDKConfig

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
		this.sdkConfig = sdkConfig
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
		const promises: Promise<void>[] = []

		for (const pair of this.syncPairs) {
			if (!this.syncs[pair.uuid]) {
				this.syncs[pair.uuid] = new Sync({
					syncPair: pair,
					dbPath: this.dbPath,
					sdkConfig: this.sdkConfig
				})

				promises.push(this.syncs[pair.uuid]!.initialize())
			}
		}

		await Promise.all(promises)
	}
}

export default SyncWorker
