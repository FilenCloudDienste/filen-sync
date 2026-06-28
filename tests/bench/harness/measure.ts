import fs from "fs"
import os from "os"
import pathModule from "path"

/**
 * A single benchmark measurement. Captures the three axes the goal cares about — wall time, CPU time,
 * and memory — plus the input scale so results are comparable across sizes.
 */
export type BenchResult = {
	group: string
	name: string
	/** Input scale (e.g. node count) so ms/op-per-node can be derived. */
	n: number
	iterations: number
	/** Wall-clock ms per iteration (mean / min). */
	msMean: number
	msMin: number
	/** CPU ms per iteration (user+system), via process.cpuUsage. */
	cpuMsMean: number
	/** Heap still alive AFTER the run but BEFORE gc (retained result + transient not-yet-collected). MB. */
	heapLiveMB: number
	/** Heap retained AFTER gc (the result the run keeps referenced). MB. */
	heapRetainedMB: number
	/** Peak RSS growth observed by sampling during the timed loop, relative to pre-run RSS. MB. */
	peakRssMB: number
	/** ns per node (msMean / n * 1e6) — the headline efficiency number. */
	nsPerNode: number
	extra?: Record<string, number | string>
}

const results: BenchResult[] = []

function mean(xs: number[]): number {
	return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function min(xs: number[]): number {
	return xs.length === 0 ? 0 : Math.min(...xs)
}

function gc(): void {
	globalThis.gc?.()
}

const MB = 1024 * 1024

function fmt(n: number, digits = 2): string {
	if (!Number.isFinite(n)) {
		return "—"
	}

	return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/**
 * Run one benchmark. `setup` builds a fresh input per iteration (NOT timed — so tree construction never
 * pollutes the measurement); `run` is the timed body. Time + CPU are averaged over `iterations`; peak RSS
 * is sampled across the whole timed loop; retained/live heap is measured on a single dedicated run so the
 * accumulated allocations of the time loop don't inflate it.
 */
export async function bench<T>(options: {
	group: string
	name: string
	n: number
	iterations?: number
	warmup?: number
	setup: () => T | Promise<T>
	run: (input: T) => unknown | Promise<unknown>
	/** Optional extra columns derived from one input (e.g. delta count). */
	extra?: (input: T) => Record<string, number | string>
}): Promise<BenchResult> {
	const iterations = options.iterations ?? 5
	const warmup = options.warmup ?? 1

	for (let i = 0; i < warmup; i++) {
		const input = await options.setup()

		await options.run(input)
	}

	gc()

	const times: number[] = []
	let cpuTotalMs = 0
	let peakRss = 0
	const rssBase = process.memoryUsage().rss
	const sampler = setInterval(() => {
		const rss = process.memoryUsage().rss - rssBase

		if (rss > peakRss) {
			peakRss = rss
		}
	}, 2)

	// Keep the sampler from holding the event loop open / keeping the process alive.
	if (typeof sampler === "object" && sampler && "unref" in sampler) {
		;(sampler as { unref: () => void }).unref()
	}

	let extra: Record<string, number | string> | undefined

	for (let i = 0; i < iterations; i++) {
		const input = await options.setup()

		if (i === 0 && options.extra) {
			extra = options.extra(input)
		}

		const cpu0 = process.cpuUsage()
		const t0 = performance.now()

		await options.run(input)

		const elapsed = performance.now() - t0
		const cpu = process.cpuUsage(cpu0)

		times.push(elapsed)
		cpuTotalMs += (cpu.user + cpu.system) / 1000
	}

	clearInterval(sampler)

	// Dedicated retained-memory run.
	gc()

	const heap0 = process.memoryUsage().heapUsed
	const memInput = await options.setup()
	const out = await options.run(memInput)
	const heapLive = process.memoryUsage().heapUsed - heap0

	gc()

	const heapRetained = process.memoryUsage().heapUsed - heap0

	// Hold a reference so the optimizer / gc can't drop the result before we read retained heap.
	void out
	void memInput

	const msMean = mean(times)
	const result: BenchResult = {
		group: options.group,
		name: options.name,
		n: options.n,
		iterations,
		msMean,
		msMin: min(times),
		cpuMsMean: cpuTotalMs / iterations,
		heapLiveMB: heapLive / MB,
		heapRetainedMB: heapRetained / MB,
		peakRssMB: peakRss / MB,
		nsPerNode: options.n > 0 ? (msMean / options.n) * 1e6 : 0,
		...(extra ? { extra } : {})
	}

	results.push(result)
	appendResult(result)

	return result
}

/** JSONL path that EVERY bench process appends to (cleared once at the start of a run by the runner). */
function jsonlPath(): string {
	return process.env["BENCH_JSONL"] ?? pathModule.join(process.cwd(), "docs/perf/benchmarks/_results.jsonl")
}

/**
 * Persist + print one result immediately. Incremental append (not an exit-time flush) so partial runs
 * still produce data and results survive across the separate worker processes vitest spawns per file —
 * vitest workers do not reliably fire `process.on("exit")`.
 */
function appendResult(r: BenchResult): void {
	const extraStr = r.extra
		? " | " +
		  Object.entries(r.extra)
				.map(([k, v]) => `${k}=${typeof v === "number" ? fmt(v, 0) : v}`)
				.join(" ")
		: ""

	// process.stdout.write bypasses vitest's console grouping so the line is always visible in the run log.
	process.stdout.write(
		`[bench] ${r.group} :: ${r.name} | n=${fmt(r.n, 0)} | ${fmt(r.msMean)}ms (min ${fmt(r.msMin)}) | cpu ${fmt(
			r.cpuMsMean
		)}ms | ns/node ${fmt(r.nsPerNode, 1)} | heapRet ${fmt(r.heapRetainedMB)}MB live ${fmt(r.heapLiveMB)}MB | peakRSS ${fmt(
			r.peakRssMB
		)}MB${extraStr}\n`
	)

	try {
		const path = jsonlPath()

		fs.mkdirSync(pathModule.dirname(path), { recursive: true })
		fs.appendFileSync(path, JSON.stringify(r) + "\n", "utf-8")
	} catch {
		// Best-effort persistence; the stdout line above is the fallback record.
	}
}

export function getResults(): BenchResult[] {
	return results
}

/**
 * Record a fully-computed result (for benchmarks like long-run leak detection that measure their own
 * bespoke metrics rather than a single timed `run`). Missing numeric fields default to 0.
 */
export function recordCustom(
	partial: { group: string; name: string; n: number } & Partial<Omit<BenchResult, "group" | "name" | "n">>
): void {
	const result: BenchResult = {
		iterations: 1,
		msMean: 0,
		msMin: 0,
		cpuMsMean: 0,
		heapLiveMB: 0,
		heapRetainedMB: 0,
		peakRssMB: 0,
		nsPerNode: 0,
		...partial
	}

	results.push(result)
	appendResult(result)
}

/**
 * Render a JSONL results file (produced incrementally by {@link bench}) into a grouped markdown report.
 * Run as a standalone step after the vitest bench run (see docs/perf/02-benchmarks.md).
 */
export function renderReport(inJsonl: string, outMd: string, label: string): void {
	if (!fs.existsSync(inJsonl)) {
		throw new Error(`No results file at ${inJsonl}`)
	}

	const rows: BenchResult[] = fs
		.readFileSync(inJsonl, "utf-8")
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as BenchResult)

	const lines: string[] = []

	lines.push(`# Benchmark results — ${label}`)
	lines.push("")
	lines.push(`Generated: ${new Date().toISOString()}`)
	lines.push(`Node: ${process.version} | platform: ${process.platform} | cpus: ${os.cpus().length}`)
	lines.push("")

	for (const group of [...new Set(rows.map(r => r.group))]) {
		lines.push(`## ${group}`)
		lines.push("")
		lines.push("| scenario | n | ms mean | ms min | cpu ms | ns/node | heap ret MB | heap live MB | peak RSS MB | extra |")
		lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")

		for (const r of rows.filter(x => x.group === group)) {
			const extraStr = r.extra
				? Object.entries(r.extra)
						.map(([k, v]) => `${k}=${typeof v === "number" ? fmt(v as number, 0) : v}`)
						.join(", ")
				: ""

			lines.push(
				`| ${r.name} | ${fmt(r.n, 0)} | ${fmt(r.msMean)} | ${fmt(r.msMin)} | ${fmt(r.cpuMsMean)} | ${fmt(
					r.nsPerNode,
					1
				)} | ${fmt(r.heapRetainedMB)} | ${fmt(r.heapLiveMB)} | ${fmt(r.peakRssMB)} | ${extraStr} |`
			)
		}

		lines.push("")
	}

	fs.mkdirSync(pathModule.dirname(outMd), { recursive: true })
	fs.writeFileSync(outMd, lines.join("\n"), "utf-8")

	process.stdout.write(`\n[bench] rendered ${rows.length} results -> ${outMd}\n`)
}
