import { describe, it, expect } from "vitest"
import pathModule from "path"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { BASE_TIME, DB_ROOT, type World } from "../harness/world"
import { messagesOfType } from "../harness/snapshot"
import { writeLocal } from "../harness/mutations"
import { knownBug } from "../harness/known-bug"
import { IGNORER_VERSION } from "../../src/ignorer"
import { type SyncMessage } from "../../src/types"

/**
 * Category F — ignore / filter (behavioral spec §F, §5). Default OS junk, excludeDotFiles, and
 * `.filenignore` (gitignore semantics) gate which paths enter the trees. An ignored path is excluded
 * from sync but NOT removed from the side it physically lives on — so assertions are path-specific
 * (the normalized local snapshot still walks the real disk, which keeps ignored files).
 */
const SECOND = 1000

/** All structural-ignore reasons reported across the message stream (local + remote). */
function ignoredReasons(messages: SyncMessage[]): string[] {
	const local = messagesOfType(messages, "localTreeIgnored").flatMap(message => message.data.ignored.map(entry => entry.reason))
	const remote = messagesOfType(messages, "remoteTreeIgnored").flatMap(message => message.data.ignored.map(entry => entry.reason))

	return [...local, ...remote]
}

/** Seed the dbPath-side `.filenignore` copy (merged with the physical one each cycle). */
function writeDbIgnore(world: World, content: string): void {
	const dir = pathModule.posix.join(DB_ROOT, "ignorer", `v${IGNORER_VERSION}`, world.syncPair.uuid)

	world.vfs.ifs.mkdirSync(dir, { recursive: true })
	world.vfs.ifs.writeFileSync(pathModule.posix.join(dir, "filenIgnore"), content)
}

describe("Category F — ignore / filter", () => {
	it("F1: default OS-junk names are ignored (not uploaded), real files sync", async () => {
		const result = await runScenario({
			name: "F1",
			mode: "twoWay",
			initialLocal: {
				"/local/.DS_Store": "junk",
				"/local/Thumbs.db": "junk",
				"/local/real.txt": "real"
			},
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/.DS_Store"]).toBeUndefined()
		expect(result.finalRemote["/Thumbs.db"]).toBeUndefined()
		expect(result.finalRemote["/real.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("defaultIgnore")
	})

	it("F2: excludeDotFiles hides dot paths; toggling it off re-includes them next cycle", async () => {
		const result = await runScenario({
			name: "F2",
			mode: "twoWay",
			excludeDotFiles: true,
			initialLocal: {
				"/local/.secret": "hidden",
				"/local/real.txt": "real"
			},
			steps: [
				runCycle(),
				// Toggle inside a local mutation so the watcher fires and the tree is rebuilt next cycle.
				localMutate(world => world.worker.updateExcludeDotFiles(world.syncPair.uuid, false)),
				runCycle(),
				runCycle()
			]
		})

		// First cycle: the dot file is excluded.
		expect(result.cycles[0]!.remote["/.secret"]).toBeUndefined()
		expect(result.cycles[0]!.remote["/real.txt"]).toMatchObject({ type: "file" })
		// After toggling off, it is re-included.
		expect(result.finalRemote["/.secret"]).toMatchObject({ type: "file" })
	})

	it("F3: a simple `.filenignore` name pattern is ignored", async () => {
		const result = await runScenario({
			name: "F3",
			mode: "twoWay",
			filenIgnore: "ignored.txt",
			initialLocal: {
				"/local/ignored.txt": "nope",
				"/local/kept.txt": "yes"
			},
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/ignored.txt"]).toBeUndefined()
		expect(result.finalRemote["/kept.txt"]).toMatchObject({ type: "file" })
		// The ignored file is untouched on local disk.
		expect(result.finalLocal["/ignored.txt"]).toMatchObject({ type: "file" })
	})

	it("F4: a directory pattern with a trailing slash ignores the directory and its contents", async () => {
		const result = await runScenario({
			name: "F4",
			mode: "twoWay",
			filenIgnore: "build/",
			initialLocal: {
				"/local/build/out.js": "compiled",
				"/local/build/nested/more.js": "compiled",
				"/local/src.txt": "source"
			},
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/build"]).toBeUndefined()
		expect(result.finalRemote["/build/out.js"]).toBeUndefined()
		expect(result.finalRemote["/build/nested/more.js"]).toBeUndefined()
		expect(result.finalRemote["/src.txt"]).toMatchObject({ type: "file" })
	})

	it("F5: a `**` nested glob ignores matches at any depth", async () => {
		const result = await runScenario({
			name: "F5",
			mode: "twoWay",
			filenIgnore: "**/*.log",
			initialLocal: {
				"/local/a.log": "log",
				"/local/deep/b.log": "log",
				"/local/deep/deeper/c.log": "log",
				"/local/keep.txt": "keep"
			},
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/a.log"]).toBeUndefined()
		expect(result.finalRemote["/deep/b.log"]).toBeUndefined()
		expect(result.finalRemote["/deep/deeper/c.log"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("F6: a negation pattern re-includes a specifically excepted file", async () => {
		const result = await runScenario({
			name: "F6",
			mode: "twoWay",
			filenIgnore: "*.txt\n!keep.txt",
			initialLocal: {
				"/local/drop.txt": "drop",
				"/local/keep.txt": "keep"
			},
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote["/drop.txt"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("F7: editing `.filenignore` mid-run takes effect on the next cycle", async () => {
		const result = await runScenario({
			name: "F7",
			mode: "twoWay",
			initialLocal: { "/local/seed.txt": "seed" },
			steps: [
				runCycle(),
				// Add an ignore rule and a matching file in the same beat; the new rule must apply next cycle.
				localMutate(world => {
					world.worker.updateIgnorerContent(world.syncPair.uuid, "later.txt")
					writeLocal(world, "later.txt", "added-after-rule")
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/later.txt"]).toBeUndefined()
		expect(result.finalRemote["/seed.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/later.txt"]).toMatchObject({ type: "file" })
	})

	it("F8: the physical and dbPath `.filenignore` copies are merged", async () => {
		const result = await runScenario({
			name: "F8",
			mode: "twoWay",
			filenIgnore: "physical-ignored.txt",
			initialLocal: {
				"/local/physical-ignored.txt": "a",
				"/local/db-ignored.txt": "b",
				"/local/kept.txt": "c"
			},
			steps: [
				control(world => writeDbIgnore(world, "db-ignored.txt")),
				runCycle(),
				runCycle()
			]
		})

		// Both sources contribute patterns.
		expect(result.finalRemote["/physical-ignored.txt"]).toBeUndefined()
		expect(result.finalRemote["/db-ignored.txt"]).toBeUndefined()
		expect(result.finalRemote["/kept.txt"]).toMatchObject({ type: "file" })
	})

	// F9 — TARGET: a symlink is recognized and skipped structurally (reason "symlink"). The engine
	// stats THROUGH the link (uses fs.stat, which follows, instead of lstat), so isSymbolicLink() is
	// always false and the link is never flagged — it is silently followed and collides on the target's
	// inode (producing flaky spurious ops). The "symlink" reason is therefore dead code. See BUG-006.
	knownBug("BUG-006", "F9: a symlink is skipped structurally with the symlink reason", async () => {
		const result = await runScenario({
			name: "F9",
			mode: "twoWay",
			initialLocal: { "/local/target.txt": "real" },
			steps: [
				control(world => world.vfs.ifs.symlinkSync("/local/target.txt", "/local/link.txt")),
				localMutate(() => {}),
				runCycle(),
				runCycle()
			]
		})

		expect(ignoredReasons(result.messages)).toContain("symlink")
	})

	it("F10: a file whose name exceeds the max length is ignored (nameLength)", async () => {
		const longName = `${"x".repeat(300)}.txt`

		const result = await runScenario({
			name: "F10",
			mode: "twoWay",
			initialLocal: {
				[`/local/${longName}`]: "too-long",
				"/local/ok.txt": "fine"
			},
			steps: [runCycle(), runCycle()]
		})

		expect(result.finalRemote[`/${longName}`]).toBeUndefined()
		expect(result.finalRemote["/ok.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("nameLength")
	})

	it("F11: a case-insensitive duplicate keeps one copy and flags the other", async () => {
		const result = await runScenario({
			name: "F11",
			mode: "twoWay",
			initialLocal: {
				"/local/Report.txt": "one",
				"/local/report.txt": "two"
			},
			steps: [runCycle(), runCycle()]
		})

		// Exactly one of the two case variants survives on the remote (the backend is case-insensitive).
		const surviving = ["/Report.txt", "/report.txt"].filter(path => result.finalRemote[path] !== undefined)

		expect(surviving).toHaveLength(1)
		expect(ignoredReasons(result.messages)).toContain("duplicate")
	})

	it("F12: a permission-denied path is skipped (permissions) and the sync continues", async () => {
		const denied: NodeJS.ErrnoException = Object.assign(new Error("EACCES"), { code: "EACCES" })

		const result = await runScenario({
			name: "F12",
			mode: "twoWay",
			initialLocal: {
				"/local/denied.txt": "secret",
				"/local/ok.txt": "fine"
			},
			steps: [
				control(world => world.vfs.controls.setError("/local/denied.txt", denied)),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/denied.txt"]).toBeUndefined()
		expect(result.finalRemote["/ok.txt"]).toMatchObject({ type: "file" })
		expect(ignoredReasons(result.messages)).toContain("permissions")
	})

	it("F13: a file already synced and then newly ignored is NOT deleted on the remote", async () => {
		const result = await runScenario({
			name: "F13",
			mode: "twoWay",
			initialLocal: { "/local/keep-me.txt": "content" },
			steps: [
				runCycle(),
				// Now ignore the already-synced file; ignore must not imply deletion.
				localMutate(world => {
					world.worker.updateIgnorerContent(world.syncPair.uuid, "keep-me.txt")
					world.vfs.ifs.utimesSync("/local/keep-me.txt", (BASE_TIME + 5 * SECOND) / 1000, (BASE_TIME + 5 * SECOND) / 1000)
				}),
				runCycle(),
				runCycle()
			]
		})

		// The remote copy survives — ignoring is not deletion.
		expect(result.finalRemote["/keep-me.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/keep-me.txt"]).toMatchObject({ type: "file" })
	})

	it("F14: a directory-only ignore pattern does not ignore a remote FILE of the same name (BUG-005)", async () => {
		// BUG-005 regression: the remote walk must ignore-check a file AS a file. It previously passed
		// type:"directory", appending a trailing slash, so a file named "build" was matched by the
		// directory-only pattern "build/" and wrongly skipped. A file named "build" must still sync, while
		// a real directory "cache" is still correctly ignored by "cache/".
		const result = await runScenario({
			name: "F14",
			mode: "cloudToLocal",
			filenIgnore: "build/\ncache/",
			initialRemote: {
				"/build": "i am a file, not a directory",
				"/cache/tmp.txt": "real dir content"
			},
			steps: [runCycle(), runCycle()]
		})

		// "build" is a FILE, so the directory-only pattern "build/" must NOT match it → it downloads.
		expect(result.finalLocal["/build"]).toMatchObject({ type: "file" })
		// "cache" IS a directory, so "cache/" correctly ignores it and its contents.
		expect(result.finalLocal["/cache"]).toBeUndefined()
		expect(result.finalLocal["/cache/tmp.txt"]).toBeUndefined()
	})
})
