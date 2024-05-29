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
