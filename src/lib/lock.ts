import type Sync from "./sync"
import { v4 as uuidv4 } from "uuid"
import { Semaphore } from "../semaphore"

export class Lock {
	private readonly sync: Sync
	private readonly resource = "filen-sync"
	private readonly lockUUID = uuidv4()
	private lockAcquired = false
	private readonly mutex = new Semaphore(1)
	private lockRefreshInterval: ReturnType<typeof setInterval> | undefined = undefined

	public constructor(sync: Sync) {
		this.sync = sync
	}

	public async acquire(): Promise<void> {
		await this.mutex.acquire()

		clearInterval(this.lockRefreshInterval)

		try {
			await this.sync.sdk.user().acquireResourceLock({
				resource: this.resource,
				lockUUID: this.lockUUID,
				maxTries: Infinity,
				tryTimeout: 1000
			})

			this.lockRefreshInterval = setInterval(async () => {
				await this.mutex.acquire()

				try {
					if (!this.lockAcquired) {
						return
					}

					await this.sync.sdk.user().refreshResourceLock({
						resource: this.resource,
						lockUUID: this.lockUUID
					})

					this.lockAcquired = true
				} catch {
					await this.release().catch(() => {})
				} finally {
					this.mutex.release()
				}
			}, 5000)

			this.lockAcquired = true
		} finally {
			this.mutex.release()
		}
	}

	public async release(): Promise<void> {
		await this.mutex.acquire()

		clearInterval(this.lockRefreshInterval)

		try {
			if (!this.lockAcquired) {
				return
			}

			await this.sync.sdk.user().releaseResourceLock({
				resource: this.resource,
				lockUUID: this.lockUUID
			})

			this.lockAcquired = false
		} catch {
			this.lockAcquired = false
		} finally {
			this.mutex.release()
		}
	}
}

export default Lock
