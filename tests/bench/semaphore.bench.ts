import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import { Semaphore } from "../../src/semaphore"

/**
 * Semaphore throughput benchmark (finding 001). When N tasks contend on a semaphore of width `maxCount`,
 * N−maxCount of them queue. The dequeue cost per release determines whether bulk fan-out (remote tree
 * build, bulk transfers) is O(N) or O(N²). This drives a realistic fan-out: N tasks each acquire, yield a
 * microtask, then release — exactly the shape of `dir.files.map(async () => { await sem.acquire(); … })`.
 */

async function drain(maxCount: number, tasks: number): Promise<void> {
	const sem = new Semaphore(maxCount)

	await Promise.all(
		Array.from({ length: tasks }, async () => {
			await sem.acquire()

			try {
				// Yield once so the semaphore actually queues waiters (mirrors an awaited decrypt / IO step).
				await Promise.resolve()
			} finally {
				sem.release()
			}
		})
	)
}

describe("Semaphore fan-out throughput", () => {
	it("width 1024 (remote listSemaphore shape)", async () => {
		// Moderate sizes for the baseline: the O(N²) shift makes 100k take many seconds. The quadratic
		// trend is obvious across these; after the fix this is bumped to 100k/500k/1M (now linear).
		for (const tasks of [5_000, 10_000, 20_000, 40_000]) {
			await bench({
				group: "Semaphore.drain / width 1024",
				name: `${tasks} tasks`,
				n: tasks,
				iterations: 4,
				setup: () => ({ maxCount: 1024, tasks }),
				run: ({ maxCount, tasks: t }) => drain(maxCount, t)
			})
		}
	})

	it("width 10 (transfers semaphore shape — bulk upload/download)", async () => {
		for (const tasks of [5_000, 10_000, 20_000, 40_000]) {
			await bench({
				group: "Semaphore.drain / width 10",
				name: `${tasks} tasks`,
				n: tasks,
				iterations: 4,
				setup: () => ({ maxCount: 10, tasks }),
				run: ({ maxCount, tasks: t }) => drain(maxCount, t)
			})
		}
	})

	it("FIFO order preserved", async () => {
		// Correctness guard the optimization must keep: waiters resume in acquire order.
		const sem = new Semaphore(1)
		const order: number[] = []

		await sem.acquire() // hold the only slot

		const waiters = [0, 1, 2, 3, 4].map(async i => {
			await sem.acquire()
			order.push(i)
			sem.release()
		})

		// Let them all queue, then release to drain in FIFO order.
		await Promise.resolve()
		sem.release()

		await Promise.all(waiters)

		expect(order).toEqual([0, 1, 2, 3, 4])
	})
})
