import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { writeLocal } from "../harness/mutations"

/**
 * Category ZS — .filenignore traversal pruning + filter-before-lstat.
 *
 * The local scan now (1) passes provably-safe prune globs to FastGlob so an ignored directory's subtree is
 * never traversed/stat'd/enumerated, and (2) runs the ignore check BEFORE the per-entry lstat so even a
 * glob-pattern-ignored entry costs no syscall. These tests prove BOTH optimizations actually happen (via a
 * readdir spy and the onStat lstat hook) AND that correctness/safety is fully preserved: excluded things are
 * skipped, negation re-includes and prefix-similar names still sync, a dir-only rule never drops a same-named
 * file, and an ignore-added-after-sync never deletes the already-synced remote copy. add-only.
 */
describe("Category ZS — ignore traversal pruning", () => {
	it("ZS1: a .filenignore'd directory subtree is never traversed (pruned, not post-filtered)", async () => {
		const readdirPaths: string[] = []

		const result = await runScenario({
			name: "ZS1",
			mode: "twoWay",
			filenIgnore: "node_modules",
			initialLocal: {
				"/local/keep.txt": "keep",
				"/local/node_modules/dep/sub/index.js": "x",
				"/local/node_modules/big/a.js": "y"
			},
			steps: [
				runCycle(),
				control(world => {
					const origAsync = world.vfs.globFs.readdir as (...a: unknown[]) => unknown
					const origSync = world.vfs.globFs.readdirSync as (...a: unknown[]) => unknown

					world.vfs.globFs.readdir = ((path: string, ...rest: unknown[]) => {
						readdirPaths.push(String(path))

						return origAsync(path, ...rest)
					}) as NonNullable<typeof world.vfs.globFs.readdir>
					world.vfs.globFs.readdirSync = ((path: string, ...rest: unknown[]) => {
						readdirPaths.push(String(path))

						return origSync(path, ...rest)
					}) as NonNullable<typeof world.vfs.globFs.readdirSync>
				}),
				// Force a fresh scan with the spy installed.
				localMutate(world => writeLocal(world, "trigger.txt", "t")),
				runCycle()
			]
		})

		// The walk must never read INSIDE node_modules (it may appear as an entry of the root readdir, but its
		// own directory and descendants are never opened).
		expect(readdirPaths.some(p => p.endsWith("/node_modules") || p.includes("/node_modules/"))).toBe(false)
		// And the ignored subtree never even reaches the ignored LIST (proof it was pruned, not post-filtered).
		const ignoredPaths = result.world.sync.localFileSystem.getDirectoryTreeCache.ignored.map(i => i.relativePath)

		expect(ignoredPaths.some(p => p.includes("node_modules"))).toBe(false)
		// Correctness: the non-ignored files synced, the ignored subtree did not.
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/trigger.txt"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalRemote).some(p => p.includes("node_modules"))).toBe(false)
	})

	it("ZS2: a glob-ignored entry is filtered BEFORE the lstat (no stat syscall on it)", async () => {
		const statted: string[] = []

		await runScenario({
			name: "ZS2",
			mode: "twoWay",
			// A glob pattern is NOT pruned at the glob level, so it IS enumerated — the filter-before-lstat path
			// is what spares it the syscall.
			filenIgnore: "*.log",
			initialLocal: { "/local/keep.txt": "keep", "/local/app.log": "L1", "/local/debug.log": "L2" },
			steps: [
				runCycle(),
				control(world =>
					world.vfs.controls.onStat(posixPath => {
						statted.push(posixPath)
					})
				),
				localMutate(world => writeLocal(world, "trigger.txt", "t")),
				runCycle(),
				control(world => world.vfs.controls.clearStatHook())
			]
		})

		// The ignored .log files were never lstat'd; the freshly-added non-ignored file was.
		expect(statted.some(p => p.endsWith("app.log") || p.endsWith("debug.log"))).toBe(false)
		expect(statted.some(p => p.endsWith("trigger.txt"))).toBe(true)
	})

	it("ZS3: a negation re-include still syncs (glob patterns are never pruned, post-filter honors !)", async () => {
		const result = await runScenario({
			name: "ZS3",
			mode: "twoWay",
			filenIgnore: "*.log\n!keep.log",
			initialLocal: { "/local/keep.log": "important", "/local/skip.log": "noise", "/local/a.txt": "a" },
			steps: [runCycle(), runCycle()]
		})

		// keep.log is re-included; skip.log stays ignored; a.txt is unrelated.
		expect(result.finalRemote["/keep.log"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/skip.log"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file" })
		// Every SYNCED path is identical on both sides; ignored files legitimately remain local-only, so this
		// asserts remote ⊆ local rather than full equality.
		for (const remotePath of Object.keys(result.finalRemote)) {
			expect(result.finalLocal[remotePath]).toEqual(result.finalRemote[remotePath])
		}
	})

	it("ZS4: a prefix-similar sibling of an ignored name is NOT pruned", async () => {
		const result = await runScenario({
			name: "ZS4",
			mode: "twoWay",
			filenIgnore: "build",
			initialLocal: {
				"/local/build/artifact.o": "obj",
				"/local/buildscript.txt": "script",
				"/local/build.txt": "note"
			},
			steps: [runCycle(), runCycle()]
		})

		// `build` (dir) is pruned, but `buildscript.txt` and `build.txt` only SHARE A PREFIX — they must sync.
		expect(result.finalRemote["/buildscript.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/build.txt"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalRemote).some(p => p.startsWith("/build/"))).toBe(false)
		// Every SYNCED path is identical on both sides; ignored files legitimately remain local-only, so this
		// asserts remote ⊆ local rather than full equality.
		for (const remotePath of Object.keys(result.finalRemote)) {
			expect(result.finalLocal[remotePath]).toEqual(result.finalRemote[remotePath])
		}
	})

	it("ZS5: a dir-only rule prunes the directory's contents but NOT a same-named file", async () => {
		const result = await runScenario({
			name: "ZS5",
			mode: "twoWay",
			filenIgnore: "cache/",
			initialLocal: { "/local/cache/data.bin": "blob", "/local/sibling/cache": "i-am-a-file" },
			steps: [runCycle(), runCycle()]
		})

		// The directory cache/ is ignored, but a FILE named "cache" elsewhere must still sync.
		expect(result.finalRemote["/sibling/cache"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalRemote).some(p => p.startsWith("/cache/"))).toBe(false)
		// Every SYNCED path is identical on both sides; ignored files legitimately remain local-only, so this
		// asserts remote ⊆ local rather than full equality.
		for (const remotePath of Object.keys(result.finalRemote)) {
			expect(result.finalLocal[remotePath]).toEqual(result.finalRemote[remotePath])
		}
	})

	it("ZS6: adding an ignore AFTER a dir was synced does NOT delete the remote copy", async () => {
		const result = await runScenario({
			name: "ZS6",
			mode: "twoWay",
			initialLocal: { "/local/data/x.txt": "X", "/local/keep.txt": "K" },
			steps: [
				runCycle(),
				// Now ignore the already-synced directory, then force a rescan (which will PRUNE it locally).
				control(world => world.sync.ignorer.update("data")),
				localMutate(world => writeLocal(world, "trigger.txt", "t")),
				runCycle(),
				runCycle()
			]
		})

		// The now-pruned dir vanishes from the local scan, but its delete is dropped by the delta-level ignore
		// filter — the remote backup survives (ignore-after-sync ≠ delete), exactly as without pruning.
		expect(result.finalRemote["/data/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/data/x.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/trigger.txt"]).toMatchObject({ type: "file" })
	})

	it("ZS7: a nested anchored ignore prunes only that path; a sibling under the same parent syncs", async () => {
		const result = await runScenario({
			name: "ZS7",
			mode: "twoWay",
			filenIgnore: "a/b",
			initialLocal: { "/local/a/b/secret.txt": "s", "/local/a/c/public.txt": "p" },
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a/c/public.txt"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalRemote).some(p => p.startsWith("/a/b/"))).toBe(false)
		// Every SYNCED path is identical on both sides; ignored files legitimately remain local-only, so this
		// asserts remote ⊆ local rather than full equality.
		for (const remotePath of Object.keys(result.finalRemote)) {
			expect(result.finalLocal[remotePath]).toEqual(result.finalRemote[remotePath])
		}
	})

	it("ZS8: a mixed ignored/non-ignored tree converges and is idempotent across cycles", async () => {
		const result = await runScenario({
			name: "ZS8",
			mode: "twoWay",
			filenIgnore: "node_modules\n*.tmp\nbuild/",
			initialLocal: {
				"/local/src/index.ts": "code",
				"/local/node_modules/x/y.js": "dep",
				"/local/scratch.tmp": "tmp",
				"/local/build/out.o": "obj",
				"/local/README.md": "readme"
			},
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalRemote["/src/index.ts"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/README.md"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalRemote).some(p => p.includes("node_modules") || p.endsWith(".tmp") || p.startsWith("/build/"))).toBe(
			false
		)
		// Every SYNCED path is identical on both sides; ignored files legitimately remain local-only, so this
		// asserts remote ⊆ local rather than full equality.
		for (const remotePath of Object.keys(result.finalRemote)) {
			expect(result.finalLocal[remotePath]).toEqual(result.finalRemote[remotePath])
		}
		// Idempotent: the last cycle did no work.
		expect(result.cycles[2]!.messages.filter(m => m.type === "transfer").length).toBe(0)
	})
})
