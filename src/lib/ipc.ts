import { isMainThread, parentPort } from "worker_threads"
import { type SyncMessage } from "../types"

const postMessageToMainProgressThrottle: Record<
	string,
	{
		next: number
		storedBytes: number
	}
> = {}

// We have to throttle the "progress" events of the "download"/"upload" message type. The SDK sends too many events for the IPC to handle properly.
// It freezes the main process if we don't throttle it.
export function throttlePostMessageToMain(message: SyncMessage, callback: (message: SyncMessage) => void) {
	const now = Date.now()
	let key = ""

	if (message.type === "transfer" && message.data.type === "progress") {
		key = `${message.type}:${message.data.relativePath}:${message.data.localPath}:${message.data.type}`

		if (!postMessageToMainProgressThrottle[key]) {
			postMessageToMainProgressThrottle[key] = {
				next: 0,
				storedBytes: 0
			}
		}

		postMessageToMainProgressThrottle[key]!.storedBytes += message.data.bytes

		if (postMessageToMainProgressThrottle[key]!.next > now) {
			return
		}

		message = {
			...message,
			data: {
				...message.data,
				bytes: postMessageToMainProgressThrottle[key]!.storedBytes
			}
		}
	}

	callback(message)

	if (key.length > 0 && postMessageToMainProgressThrottle[key] && message.type === "transfer") {
		postMessageToMainProgressThrottle[key]!.storedBytes = 0
		postMessageToMainProgressThrottle[key]!.next = now + 100

		if (
			message.data.type === "error" ||
			message.data.type === "queued" ||
			// TODO: Stopped event (message.data.type === "stopped")
			message.data.type === "finished"
		) {
			delete postMessageToMainProgressThrottle[key]
		}
	}
}

/**
 * Send a message to the main thread if we are running inside a worker thread, otherwise send it to the process interface.
 *
 * @export
 * @param {SyncMessage} message
 */
export function postMessageToMain(message: SyncMessage): void {
	throttlePostMessageToMain(message, throttledMessage => {
		if (isMainThread || !parentPort) {
			if (process.send) {
				process.send(throttledMessage)
			}

			return
		}

		parentPort.postMessage(throttledMessage)
	})
}
