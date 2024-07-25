import { isMainThread, parentPort } from "worker_threads"
import { type SyncMessage } from "../types"

/**
 * Send a message to the main thread if we are running inside a worker thread, otherwise send it to the process interface.
 *
 * @export
 * @param {SyncMessage} message
 */
export function postMessageToMain(message: SyncMessage): void {
	if (process.onMessage) {
		process.onMessage(message)

		return
	}

	if (isMainThread || !parentPort) {
		if (process.send) {
			process.send(message)
		}

		return
	}

	parentPort.postMessage(message)
}
