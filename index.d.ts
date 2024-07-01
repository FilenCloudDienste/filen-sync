import { type SyncMessage } from "./src/types"

declare global {
	declare namespace NodeJS {
		interface Process {
			onMessage?: (message: SyncMessage) => void
		}
	}
}
