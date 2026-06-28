import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import { type Delta } from "../../src/lib/deltas"

/**
 * Task-dispatch benchmark (target T1). `tasks.process` dispatches deltas in 12 type passes by scanning
 * the WHOLE deltasSorted array 10 times (`for…if(type!==X)continue`) plus 2 `.filter()` passes for the
 * up/down transfers — 12·O(D) just to order the work. This isolates that dispatch overhead (with a
 * no-op task body) and compares it to a single bucketing pass, so we know whether T1 is worth doing
 * before touching the real executor.
 */

const DISPATCH_ORDER = [
	"renameLocalDirectory",
	"renameLocalFile",
	"renameRemoteDirectory",
	"renameRemoteFile",
	"deleteLocalDirectory",
	"deleteLocalFile",
	"deleteRemoteDirectory",
	"deleteRemoteFile",
	"createLocalDirectory",
	"createRemoteDirectory"
] as const

const noopProcess = async (): Promise<void> => {}

/** Current strategy: 10 full filter-scans (sequential) + 2 filter passes for transfers. */
async function dispatchCurrent(deltas: Delta[]): Promise<void> {
	for (const type of DISPATCH_ORDER) {
		for (const delta of deltas) {
			if (delta.type !== type) {
				continue
			}

			await noopProcess()
		}
	}

	await Promise.all(deltas.filter(d => d.type === "uploadFile").map(noopProcess))
	await Promise.all(deltas.filter(d => d.type === "downloadFile").map(noopProcess))
}

/** Bucketed strategy: one pass to partition, then drain each bucket in the same order. */
async function dispatchBucketed(deltas: Delta[]): Promise<void> {
	const buckets = new Map<string, Delta[]>()

	for (const delta of deltas) {
		let bucket = buckets.get(delta.type)

		if (!bucket) {
			bucket = []

			buckets.set(delta.type, bucket)
		}

		bucket.push(delta)
	}

	for (const type of DISPATCH_ORDER) {
		const bucket = buckets.get(type)

		if (bucket) {
			for (let i = 0; i < bucket.length; i++) {
				await noopProcess()
			}
		}
	}

	await Promise.all((buckets.get("uploadFile") ?? []).map(noopProcess))
	await Promise.all((buckets.get("downloadFile") ?? []).map(noopProcess))
}

function genUploads(d: number): Delta[] {
	const deltas: Delta[] = []

	for (let i = 0; i < d; i++) {
		deltas.push({ type: "uploadFile", path: `/dir-${i % 1000}/file-${i}.txt`, size: 64 })
	}

	return deltas
}

function genMixed(d: number): Delta[] {
	const deltas: Delta[] = []

	for (let i = 0; i < d; i++) {
		const r = i % 5

		if (r === 0) {
			deltas.push({ type: "uploadFile", path: `/u-${i}.txt`, size: 64 })
		} else if (r === 1) {
			deltas.push({ type: "downloadFile", path: `/d-${i}.txt`, size: 64 })
		} else if (r === 2) {
			deltas.push({ type: "deleteRemoteFile", path: `/x-${i}.txt` })
		} else if (r === 3) {
			deltas.push({ type: "createRemoteDirectory", path: `/c-${i}` })
		} else {
			deltas.push({ type: "renameRemoteFile", path: `/r-${i}.txt`, from: `/r-${i}.txt`, to: `/r2-${i}.txt` })
		}
	}

	return deltas
}

describe("tasks dispatch — 12-pass vs bucketed (T1)", () => {
	it("all-uploads (bulk add — worst case for the 10 no-op rename/delete passes)", async () => {
		for (const d of [10_000, 100_000, 1_000_000]) {
			const deltas = genUploads(d)

			await bench({
				group: "tasks dispatch / all uploads",
				name: `current 12-pass — D=${d}`,
				n: d,
				iterations: 5,
				setup: () => deltas,
				run: ds => dispatchCurrent(ds)
			})

			await bench({
				group: "tasks dispatch / all uploads",
				name: `bucketed — D=${d}`,
				n: d,
				iterations: 5,
				setup: () => deltas,
				run: ds => dispatchBucketed(ds)
			})
		}
	})

	it("mixed delta types", async () => {
		for (const d of [100_000, 1_000_000]) {
			const deltas = genMixed(d)

			expect(deltas.length).toBe(d)

			await bench({
				group: "tasks dispatch / mixed types",
				name: `current 12-pass — D=${d}`,
				n: d,
				iterations: 5,
				setup: () => deltas,
				run: ds => dispatchCurrent(ds)
			})

			await bench({
				group: "tasks dispatch / mixed types",
				name: `bucketed — D=${d}`,
				n: d,
				iterations: 5,
				setup: () => deltas,
				run: ds => dispatchBucketed(ds)
			})
		}
	})
})
