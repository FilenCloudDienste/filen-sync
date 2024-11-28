import { type LocalTreeError, type LocalTreeIgnored } from "./lib/filesystems/local"
import { type DoneTask, type TaskError } from "./lib/tasks"
import { type RemoteTreeIgnored } from "./lib/filesystems/remote"
import { type SerializedError } from "./utils"

export type SyncMode = "twoWay" | "localToCloud" | "localBackup" | "cloudToLocal" | "cloudBackup"

export type SyncPair = {
	name: string
	uuid: string
	localPath: string
	remotePath: string
	remoteParentUUID: string
	mode: SyncMode
	excludeDotFiles: boolean
	paused: boolean
	localTrashDisabled: boolean
	requireConfirmationOnLargeDeletion?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never

export type Prettify<T> = {
	[K in keyof T]: T[K]
	// eslint-disable-next-line @typescript-eslint/ban-types
} & {}

export type IPCDoneTask = Prettify<Omit<DoneTask, "stats">>
export type IPCTaskError = Prettify<Omit<TaskError, "error"> & { error: SerializedError }>
export type IPCLocalTreeError = Prettify<Omit<LocalTreeError, "error"> & { error: SerializedError }>

export type CycleState =
	| "cycleStarted"
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
	| "cycleLocalSmokeTestFailed"
	| "cycleNoChanges"
	| "cycleRemoteSmokeTestFailed"
	| "cycleExited"
	| "cycleAcquiringLockStarted"
	| "cycleAcquiringLockDone"
	| "cycleReleasingLockStarted"
	| "cycleReleasingLockDone"
	| "cycleLocalSmokeTestFailed"
	| "cycleRemoteSmokeTestFailed"

export type TransferData =
	| {
			of: "upload" | "download"
			type: "progress"
			relativePath: string
			localPath: string
			bytes: number
			size: number
	  }
	| {
			of: "upload" | "download"
			type: "queued"
			relativePath: string
			localPath: string
			size: number
	  }
	| {
			of: "upload" | "download"
			type: "started"
			relativePath: string
			localPath: string
			size: number
	  }
	| {
			of: "upload" | "download"
			type: "finished"
			relativePath: string
			localPath: string
			size: number
	  }
	| {
			of: "upload" | "download"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			size: number
			uuid: string
	  }
	| {
			of: "createLocalDirectory"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "createLocalDirectory"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "createRemoteDirectory"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "createRemoteDirectory"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "deleteLocalFile"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "deleteLocalFile"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "deleteLocalDirectory"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "deleteLocalDirectory"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "deleteRemoteFile"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "deleteRemoteFile"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "deleteRemoteDirectory"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "deleteRemoteDirectory"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "renameLocalFile"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "renameLocalFile"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "renameLocalDirectory"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "renameLocalDirectory"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "renameRemoteDirectory"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "renameRemoteDirectory"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "renameRemoteFile"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "renameRemoteFile"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "downloadFile"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "downloadFile"
			type: "success"
			relativePath: string
			localPath: string
	  }
	| {
			of: "uploadFile"
			type: "error"
			relativePath: string
			localPath: string
			error: SerializedError
			uuid: string
	  }
	| {
			of: "uploadFile"
			type: "success"
			relativePath: string
			localPath: string
	  }

export type SyncMessage =
	| ({ syncPair: SyncPair } & (
			| {
					type: "transfer"
					data: TransferData
			  }
			| {
					type: "localTreeErrors"
					data: {
						errors: IPCLocalTreeError[]
					}
			  }
			| {
					type: "deltasCount"
					data: {
						count: number
					}
			  }
			| {
					type: "deltasSize"
					data: {
						size: number
					}
			  }
			| {
					type: "confirmDeletion"
					data: {
						where: "local" | "remote" | "both"
						previous: number
						current: number
					}
			  }
			| {
					type: "localTreeIgnored"
					data: {
						ignored: LocalTreeIgnored[]
					}
			  }
			| {
					type: "remoteTreeIgnored"
					data: {
						ignored: RemoteTreeIgnored[]
					}
			  }
			| {
					type: "taskErrors"
					data: {
						errors: IPCTaskError[]
					}
			  }
			| {
					type: "localDirectoryWatcherError"
					data: {
						error: SerializedError
						uuid: string
					}
			  }
			| {
					type: "cycleStarted"
			  }
			| {
					type: "cycleError"
					data: {
						error: SerializedError
						uuid: string
					}
			  }
			| {
					type: "cycleSuccess"
			  }
			| {
					type: "cycleLocalSmokeTestFailed"
			  }
			| {
					type: "cycleRemoteSmokeTestFailed"
			  }
			| {
					type: "cycleExited"
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
					type: "cycleLocalSmokeTestFailed"
					data: {
						error: SerializedError
					}
			  }
			| {
					type: "cycleRemoteSmokeTestFailed"
					data: {
						error: SerializedError
					}
			  }
			| {
					type: "cycleNoChanges"
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
					type: "cycleAcquiringLockStarted"
			  }
			| {
					type: "cycleAcquiringLockDone"
			  }
			| {
					type: "cycleReleasingLockStarted"
			  }
			| {
					type: "cycleReleasingLockDone"
			  }
			| {
					type: "cyclePaused"
			  }
	  ))
	| {
			type: "error"
			data: {
				error: SerializedError
				uuid: string
			}
	  }
