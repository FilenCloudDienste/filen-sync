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
			}, 5000)
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

		try {
			if (this.acquiredCount === 0 || !this.lockUUID) {
				return
			}

			this.acquiredCount--

			if (this.acquiredCount > 0) {
				return
			}

			// The last holder has released. Stop refreshing and drop to the unheld state UNCONDITIONALLY,
			// before awaiting the server release — keeping the invariant "refresh timer alive iff
			// acquiredCount > 0". The earlier revision restored acquiredCount to >= 1 on a release failure
			// (so the holder could "retry"), but the holder is already gone: the count never returned to 0
			// again, so the 5s interval renewed a lock NOBODY held, forever — the server lock could never
			// lapse and no other device could ever acquire it (cross-device starvation). Resetting the count
			// instead also forecloses the opposite hazard the restore was meant to avoid (count >= 1 with a
			// dead timer → the engine believing it holds a lock the server has let expire → split-brain),
			// because the count and the timer are now always torn down together.
			clearInterval(this.lockRefreshInterval)

			this.lockRefreshInterval = undefined

			// If the server release call fails the lock is NOT explicitly freed, but with refreshing stopped
			// its server-side TTL lapses it — the same self-healing path a crashed client relies on. The UUID
			// is retained on failure (cleared only on a confirmed release) so the next acquire reuses it to
			// re-acquire our own not-yet-expired lock, mirroring the acquire-failure recovery path.
			await this.sync.sdk.user().releaseResourceLock({
				resource: this.resource,
				lockUUID: this.lockUUID
			})

			this.lockUUID = null
		} finally {
			this.mutex.release()
		}
	}
}

export default Lock
