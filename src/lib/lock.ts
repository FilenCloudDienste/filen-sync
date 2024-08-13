import type Sync from "./sync"
import { v4 as uuidv4 } from "uuid"
import { Semaphore } from "../semaphore"

export class Lock {
	private readonly sync: Sync
	private readonly resource = "filen-sync"
	private lockUUID: string | null = null
	private lockRefreshInterval: ReturnType<typeof setInterval> | undefined = undefined
	private lockAcquired: boolean = false
	private mutex = new Semaphore(1)

	public constructor(sync: Sync) {
		this.sync = sync
	}

	public async acquire(): Promise<void> {
		await this.mutex.acquire()

		try {
			clearInterval(this.lockRefreshInterval)

			if (!this.lockUUID) {
				this.lockUUID = uuidv4()
			}

			await this.sync.sdk.user().acquireResourceLock({
				resource: this.resource,
				lockUUID: this.lockUUID,
				maxTries: Infinity,
				tryTimeout: 1000
			})

			this.lockAcquired = true

			this.lockRefreshInterval = setInterval(async () => {
				if (!this.lockAcquired || !this.lockUUID) {
					return
				}

				await this.mutex.acquire()

				try {
					await this.sync.sdk.user().refreshResourceLock({
						resource: this.resource,
						lockUUID: this.lockUUID
					})
				} catch (e) {
					this.sync.worker.logger.log("error", e, "lock.refresh")
					this.sync.worker.logger.log("error", e)
				} finally {
					this.mutex.release()
				}
			}, 5000)
		} finally {
			this.mutex.release()
		}
	}

	public async release(): Promise<void> {
		await this.mutex.acquire()

		try {
			if (!this.lockAcquired || !this.lockUUID) {
				return
			}

			clearInterval(this.lockRefreshInterval)

			await this.sync.sdk
				.user()
				.releaseResourceLock({
					resource: this.resource,
					lockUUID: this.lockUUID
				})
				.catch(() => {})

			this.lockAcquired = false
			this.lockUUID = null
		} finally {
			this.mutex.release()
		}
	}
}

export default Lock
