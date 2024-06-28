import { type LocalTreeError } from "./lib/filesystems/local"
import { type Delta } from "./lib/deltas"
import { type DoneTask, type TaskError } from "./lib/tasks"

export type SyncMode = "twoWay" | "localToCloud" | "localBackup" | "cloudToLocal" | "cloudBackup"

export type SyncPair = {
	uuid: string
	localPath: string
	remotePath: string
	remoteParentUUID: string
	mode: SyncMode
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

export type SyncMessage = { syncPair: SyncPair } & (
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
)
