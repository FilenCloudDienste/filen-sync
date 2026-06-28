import { describe, it, expect } from "vitest"
import { Semaphore } from "../../src/semaphore"

/**
 * Added regression tests pinning the behavioral contract of {@link Semaphore} under LARGE fan-out, so the
 * O(1)-dequeue optimization (finding 001: replacing the O(n) `Array.shift()` with a head-index queue)
 * cannot silently change semantics. These assert the invariants the optimization must preserve — FIFO
 * wake order, the concurrency cap, and purge accounting — at queue depths where a regression would show.
 *
 * NEW FILE — does not touch the existing Semaphore tests in tests/unit/n-unit.test.ts.
 */

const tick = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 0))

describe("Semaphore — large fan-out invariants (perf optimization guard)", () => {
	it("preserves strict FIFO wake order across thousands of queued waiters", async () => {
		const sem = new Semaphore(1)

		await sem.acquire() // hold the only slot so everything queues

		const order: number[] = []
		const count = 3_000
		const waiters: Promise<void>[] = []

		for (let i = 0; i < count; i++) {
			waiters.push(
				(async () => {
					await sem.acquire()

					order.push(i)

					sem.release()
				})()
			)
		}

		await tick() // let all `count` waiters enqueue
		sem.release() // release the holder → FIFO cascade drains the queue

		await Promise.all(waiters)

		expect(order.length).toBe(count)

		for (let i = 0; i < count; i++) {
			expect(order[i]).toBe(i)
		}

		expect(sem.count()).toBe(0)
	})

	it("never exceeds the concurrency cap and fully reaches it under heavy contention", async () => {
		const width = 10
		const sem = new Semaphore(width)
		let running = 0
		let maxRunning = 0

		await Promise.all(
			Array.from({ length: 5_000 }, async () => {
				await sem.acquire()

				running++
				maxRunning = Math.max(maxRunning, running)

				await tick()

				running--

				sem.release()
			})
		)

		expect(maxRunning).toBe(width)
		expect(sem.count()).toBe(0)
	})

	it("drains thousands of sequential width-1 contenders (head-index compaction path)", async () => {
		const sem = new Semaphore(1)

		await sem.acquire()

		let done = 0
		const count = 8_000
		const waiters = Array.from({ length: count }, async () => {
			await sem.acquire()

			done++

			sem.release()
		})

		await tick()
		sem.release()

		await Promise.all(waiters)

		expect(done).toBe(count)
		expect(sem.count()).toBe(0)
	})

	it("purge() after a large fan-out rejects every waiter, returns the count, and resets", async () => {
		const sem = new Semaphore(1)

		await sem.acquire()

		const count = 1_500
		const rejected: Promise<unknown>[] = []

		for (let i = 0; i < count; i++) {
			rejected.push(sem.acquire().then(() => "resolved", () => "rejected"))
		}

		await tick()

		expect(sem.purge()).toBe(count)
		expect(sem.count()).toBe(0)

		const outcomes = await Promise.all(rejected)

		expect(outcomes.every(o => o === "rejected")).toBe(true)
	})

	it("reuses a width-1 mutex correctly across many serial acquire/release cycles", async () => {
		const sem = new Semaphore(1)
		let concurrent = 0
		let maxConcurrent = 0

		for (let i = 0; i < 2_000; i++) {
			await sem.acquire()

			concurrent++
			maxConcurrent = Math.max(maxConcurrent, concurrent)
			concurrent--

			sem.release()
		}

		expect(maxConcurrent).toBe(1)
		expect(sem.count()).toBe(0)
	})
})
