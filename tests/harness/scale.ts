import { type World } from "./world"
import { writeLocal } from "./mutations"

/**
 * Large-tree generation helpers for the scale-hardening scenarios. The weird/conflict/race categories
 * are all pinned with tiny (1–4 item) trees; these build big, noisy trees so the same mechanics are
 * exercised through the engine's AGGREGATE code paths (collapseDeltas, directoriesWithSurvivingChildren
 * and its splice maintenance, the rename-rebase block, gate-counting, the depth-sort, the parallel task
 * buckets) — which only ever run at trivial scale today.
 *
 * Every key is a `/local/...` path (the snapshot root is `/local`; a bare key lands outside the sync
 * root and is silently NOT synced). Add-only, used by new scenario files only.
 */
export type TreeSpec = Record<string, string>

/** Merge several spec fragments into one (later fragments win on key collision). */
export function mergeSpecs(...specs: TreeSpec[]): TreeSpec {
	return Object.assign({}, ...specs)
}

/**
 * Re-key a `/local/...`-rooted spec for use as `initialRemote` (the remote root is `/`, not `/local`).
 * e.g. stripLocal(genDirs("docs", ...)) yields `/docs/...` keys.
 */
export function stripLocal(spec: TreeSpec): TreeSpec {
	const out: TreeSpec = {}

	for (const [path, value] of Object.entries(spec)) {
		out[path.startsWith("/local/") ? path.slice("/local".length) : path] = value
	}

	return out
}

/**
 * `dirCount` directories under `/local/<root>`, each holding `filesPerDir` files
 * `file-<f>.txt` with deterministic content. e.g. genDirs("big", 16, 3).
 */
export function genDirs(root: string, dirCount: number, filesPerDir: number, contentPrefix = "c"): TreeSpec {
	const spec: TreeSpec = {}

	for (let d = 0; d < dirCount; d++) {
		for (let f = 0; f < filesPerDir; f++) {
			spec[`/local/${root}/d${d}/file-${f}.txt`] = `${contentPrefix}-${d}-${f}`
		}
	}

	return spec
}

/** `count` flat files `/local/<root>/n-<i>.txt` of unique content — untouched "noise" / haystack. */
export function genNoise(root: string, count: number, contentPrefix = "noise"): TreeSpec {
	const spec: TreeSpec = {}

	for (let i = 0; i < count; i++) {
		spec[`/local/${root}/n-${i}.txt`] = `${contentPrefix}-${i}`
	}

	return spec
}

/** A single deeply nested chain `/local/<root>/l0/l1/.../l<depth-1>/leaf.txt`. Returns [spec, leafRelPath]. */
export function genChain(root: string, depth: number, leafContent = "leaf"): { spec: TreeSpec; leaf: string } {
	const segments: string[] = []

	for (let level = 0; level < depth; level++) {
		segments.push(`l${level}`)
	}

	const leaf = `${root}/${segments.join("/")}/leaf.txt`

	return { spec: { [`/local/${leaf}`]: leafContent }, leaf }
}

/** Write `count` files into `/local/<dir>/` in one local mutation (e.g. a bulk add). */
export function writeManyLocal(world: World, dir: string, count: number, contentPrefix = "m"): void {
	for (let i = 0; i < count; i++) {
		writeLocal(world, `${dir}/file-${i}.txt`, `${contentPrefix}-${i}`)
	}
}

/** Count snapshot keys under a relative dir prefix (e.g. "/big/"). */
export function countUnder(snapshot: Record<string, unknown>, prefix: string): number {
	return Object.keys(snapshot).filter(path => path.startsWith(prefix)).length
}
