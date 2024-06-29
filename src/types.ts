import { type LocalTreeError, type LocalTreeIgnored } from "./lib/filesystems/local"
import { type Delta } from "./lib/deltas"
import { type DoneTask, type TaskError } from "./lib/tasks"
import { type RemoteTreeIgnored } from "./lib/filesystems/remote"

export type SyncMode = "twoWay" | "localToCloud" | "localBackup" | "cloudToLocal" | "cloudBackup"

export type SyncPair = {
	uuid: string
	localPath: string
	remotePath: string
	remoteParentUUID: string
	mode: SyncMode
	excludeDotFiles: boolean
	paused: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never

export type Prettify<T> = {
	[K in keyof T]: T[K]
	// eslint-disable-next-line @typescript-eslint/ban-types
} & {}

export type CycleState =
	| "cycleStarted"
	| "cycleFinished"
	| "cycleError"
	| "cycleSuccess"
	| "cycleWaitingForLocalDirectoryChangesStarted"
	| "cycleWaitingForLocalDirectoryChangesDone"
	| "cycleGettingTreesStarted"
	| "cycleGettingTreesDone"
	| "cycleProcessingDeltasStarted"
	| "cycleProcessingDeltasDone"
	| "cycleProcessingTasksStarted"
	| "cycleProcessingTasksDone"
	| "cycleApplyingStateStarted"
	| "cycleApplyingStateDone"
	| "cycleSavingStateStarted"
	| "cycleSavingStateDone"
	| "cycleRestarting"
	| "cyclePaused"

export type SyncMessage =
	| ({ syncPair: SyncPair } & (
			| {
					type: "transfer"
					data:
						| {
								of: "upload" | "download"
								type: "progress"
								relativePath: string
								localPath: string
								bytes: number
						  }
						| {
								of: "upload" | "download"
								type: "queued"
								relativePath: string
								localPath: string
						  }
						| {
								of: "upload" | "download"
								type: "started"
								relativePath: string
								localPath: string
						  }
						| {
								of: "upload" | "download"
								type: "finished"
								relativePath: string
								localPath: string
						  }
						| {
								of: "upload" | "download"
								type: "error"
								relativePath: string
								localPath: string
								error: Error
						  }
			  }
			| {
					type: "localTreeErrors"
					data: LocalTreeError[]
			  }
			| {
					type: "localTreeIgnored"
					data: LocalTreeIgnored[]
			  }
			| {
					type: "remoteTreeIgnored"
					data: RemoteTreeIgnored[]
			  }
			| {
					type: "deltas"
					data: Delta[]
			  }
			| {
					type: "doneTasks"
					data: {
						tasks: DoneTask[]
						errors: TaskError[]
					}
			  }
			| {
					type: "cycleStarted"
			  }
			| {
					type: "cycleFinished"
			  }
			| {
					type: "cycleError"
					data: Error
			  }
			| {
					type: "cycleSuccess"
			  }
			| {
					type: "cycleWaitingForLocalDirectoryChangesStarted"
			  }
			| {
					type: "cycleWaitingForLocalDirectoryChangesDone"
			  }
			| {
					type: "cycleGettingTreesStarted"
			  }
			| {
					type: "cycleGettingTreesDone"
			  }
			| {
					type: "cycleProcessingDeltasStarted"
			  }
			| {
					type: "cycleProcessingDeltasDone"
			  }
			| {
					type: "cycleProcessingTasksStarted"
			  }
			| {
					type: "cycleProcessingTasksDone"
			  }
			| {
					type: "cycleApplyingStateStarted"
			  }
			| {
					type: "cycleApplyingStateDone"
			  }
			| {
					type: "cycleSavingStateStarted"
			  }
			| {
					type: "cycleSavingStateDone"
			  }
			| {
					type: "cycleRestarting"
			  }
			| {
					type: "cyclePaused"
			  }
			| {
					type: "stopTransfer"
					data: {
						of: "upload" | "download"
						relativePath: string
					}
			  }
			| {
					type: "pauseTransfer"
					data: {
						of: "upload" | "download"
						relativePath: string
					}
			  }
			| {
					type: "resumeTransfer"
					data: {
						of: "upload" | "download"
						relativePath: string
					}
			  }
	  ))
	| {
			type: "updateSyncPairs"
			data: {
				pairs: SyncPair[]
				resetCache: boolean
			}
	  }
	| {
			type: "error"
			data: Error
	  }
	| {
			type: "syncPairsUpdated"
	  }
	| {
			type: "updateLocalIgnorer"
			syncPair: SyncPair
			data?: string
	  }
	| {
			type: "updateRemoteIgnorer"
			syncPair: SyncPair
			data?: string
	  }
	| {
			type: "resetSyncPairCache"
	  }
	| {
			type: "pauseSyncPair"
			syncPair: SyncPair
	  }
	| {
			type: "resumeSyncPair"
			syncPair: SyncPair
	  }
	| {
			type: "changeSyncPairMode"
			syncPair: SyncPair
			data: {
				mode: SyncMode
			}
	  }
	| {
			type: "syncPairExcludeDotFiles"
			syncPair: SyncPair
	  }
	| {
			type: "syncPairIncludeDotFiles"
			syncPair: SyncPair
	  }
