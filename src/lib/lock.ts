import type Sync from "./sync"
import { v4 as uuidv4 } from "uuid"
import Semaphore from "../semaphore"

/**
 * Lock
 *
 * @export
 * @class Lock
 * @typedef {Lock}
 */
export class Lock {
	private readonly sync: Sync
	private readonly resource: string
	private lockUUID: string | null = null
	private lockRefreshInterval: ReturnType<typeof setInterval> | undefined = undefined
	private mutex = new Semaphore(1)
	private acquiredCount: number = 0

	/**
	 * Creates an instance of Lock.
	 *
	 * @constructor
	 * @public
	 * @param {{ sync: Sync; resource: string }} param0
	 * @param {Sync} param0.sync
	 * @param {string} param0.resource
	 */
	public constructor({ sync, resource }: { sync: Sync; resource: string }) {
		this.sync = sync
		this.resource = resource
	}

	/**
	 * Acquire the lock on <resource>.
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async acquire(): Promise<void> {
		await this.mutex.acquire()

		let didIncrement = false

		try {
			this.acquiredCount++

			didIncrement = true

			if (this.acquiredCount > 1) {
				return
			}

			clearInterval(this.lockRefreshInterval)

			if (!this.lockUUID) {
				this.lockUUID = uuidv4()
			}

			try {
				await this.sync.sdk.user().acquireResourceLock({
					resource: this.resource,
					lockUUID: this.lockUUID,
					maxTries: Infinity,
					tryTimeout: 1000
				})
			} catch (err) {
				this.acquiredCount--

				didIncrement = false

				throw err
			}

			this.lockRefreshInterval = setInterval(async () => {
				if (this.acquiredCount === 0 || !this.lockUUID) {
					clearInterval(this.lockRefreshInterval)
					return
				}

				await this.mutex.acquire()

				try {
					await this.sync.sdk.user().refreshResourceLock({
						resource: this.resource,
						lockUUID: this.lockUUID
					})
				} catch {
					// Noop
				} finally {
					this.mutex.release()
				}
			}, 15000)
		} catch (err) {
			if (didIncrement) {
				this.acquiredCount--
			}

			throw err
		} finally {
			this.mutex.release()
		}
	}

	/**
	 * Release the acquired lock on <resource>.
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async release(): Promise<void> {
		await this.mutex.acquire()

		const previousCount = structuredClone(this.acquiredCount)

		try {
			if (this.acquiredCount === 0 || !this.lockUUID) {
				return
			}

			this.acquiredCount--

			if (this.acquiredCount > 0) {
				return
			}

			clearInterval(this.lockRefreshInterval)

			try {
				await this.sync.sdk.user().releaseResourceLock({
					resource: this.resource,
					lockUUID: this.lockUUID
				})

				this.lockUUID = null
			} catch (error) {
				this.acquiredCount = previousCount

				throw error
			}
		} finally {
			this.mutex.release()
		}
	}
}

export default Lock
