import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, control } from "../harness/runner"
import { messagesOfType } from "../harness/snapshot"
import { mkdirLocal, rmLocal, renameLocal, writeLocalAt } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"
import { makeErrnoError } from "../fakes/virtual-fs"
import { type SyncMessage, type TransferData } from "../../src/types"

const SECOND = 1000

/**
 * Category O — per-task-type error paths (resilience / §H). This extends Category H to every task
 * type whose `catch` branch H did not exercise. The guarantee under test for each task type: when its
 * I/O fails with the target still present, the engine emits a `transfer`/`type:"error"` message of that
 * task's `of`, records a task error (which gates the cycle and prevents state persistence), and a retry
 * after the fault clears converges. The mirror guarantee: when the target has already vanished, the
 * re-check skips the task silently with no error.
 *
 * H already covers `uploadFile` (surface) and `deleteRemoteFile` (surface + not_found swallow); those
 * are not duplicated here.
 *
 * Deferred (noted, not faked): the REMOTE re-check SWALLOW branches — a deleteRemote/renameRemote/
 * downloadFile task whose target vanishes strictly BETWEEN delta-computation and the task's
 * existence re-check returning false. The fake cloud refreshes the engine's tree cache on every
 * revision bump, so a genuinely-gone target leaves the cache too (→ the op early-returns inside
 * RemoteFileSystem.unlink before the task catch, rather than throwing into it); holding the cache
 * stale enough to reach the catch's `!fileExists`/`!directoryExists` branch would require forcing the
 * existence probe to lie, i.e. faking the vanish. Those are true mid-I/O races, deferred to the live
 * e2e suite (same framing as H). The LOCAL re-check swallows ARE genuine and covered here (O9, O10).
 */

/** Total number of individual task errors reported across the message stream. */
function taskErrorCount(messages: SyncMessage[]): number {
	return messagesOfType(messages, "taskErrors").reduce((sum, message) => sum + message.data.errors.length, 0)
}

/** Whether a `transfer` message with the given `of` discriminator and `type` exists in the stream. */
function hasTransfer(messages: SyncMessage[], of: TransferData["of"], type: "error" | "success"): boolean {
	return messagesOfType(messages, "transfer").some(message => message.data.of === of && message.data.type === type)
}

describe("Category O — per-task-type error paths", () => {
	// REMOTE error-surface: inject the mutation method; the node stays present, so the catch's
	// existence re-check returns true and the error surfaces as a task error.

	it("O1: a remote mkdir failure surfaces a createRemoteDirectory error, and a retry converges", async () => {
		const result = await runScenario({
			name: "O1",
			mode: "twoWay",
			steps: [
				runCycle(),
				localMutate(world => mkdirLocal(world, "newdir")),
				control(world => world.cloud.controls.setError("createDirectory", new Error("mkdir boom"))),
				runCycle(),
				control(world => {
					world.cloud.controls.clearError("createDirectory")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[1]!

		// createRemoteDirectory has no existence re-check — any error surfaces directly.
		expect(hasTransfer(failCycle.messages, "createRemoteDirectory", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		// After recovery the directory exists remotely and the worlds converge.
		expect(result.finalRemote["/newdir"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O2: a remote dir-trash failure surfaces a deleteRemoteDirectory error, and a retry converges", async () => {
		// An EMPTY directory: deleting a non-empty one would also generate a child deleteRemoteFile,
		// muddying the per-task assertion. The empty dir yields exactly one deleteRemoteDirectory task.
		const result = await runScenario({
			name: "O2",
			mode: "twoWay",
			initialLocal: { "/local/d": null },
			steps: [
				runCycle(),
				localMutate(world => rmLocal(world, "d")),
				control(world => world.cloud.controls.setError("trashDirectory", new Error("trash dir boom"))),
				runCycle(),
				control(world => {
					world.cloud.controls.clearError("trashDirectory")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[1]!

		// trashDirectory threw a non-not_found error; the dir is still present, so directoryExists() is
		// true and the error surfaces (a not_found would have been swallowed inside RemoteFileSystem.unlink).
		expect(hasTransfer(failCycle.messages, "deleteRemoteDirectory", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		expect(result.finalRemote["/d"]).toBeUndefined()
		expect(result.finalLocal["/d"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O3: a remote renameFile failure surfaces a renameRemoteFile error, and a retry converges", async () => {
		// The file lives in a subdirectory: the catch's fileExists(from) re-check resolves the parent from
		// the tree cache, and the cache has no "/" entry — so a root-level file would re-check false and be
		// swallowed rather than surfaced (matching H3/H4's subdirectory choice).
		const result = await runScenario({
			name: "O3",
			mode: "twoWay",
			initialLocal: { "/local/sub/a.txt": "x" },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "sub/a.txt", "sub/b.txt")),
				control(world => world.cloud.controls.setError("renameFile", new Error("rename file boom"))),
				runCycle(),
				control(world => {
					world.cloud.controls.clearError("renameFile")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[1]!

		// The remote source (sub/a.txt) is still present, so fileExists(from) is true and the error surfaces.
		expect(hasTransfer(failCycle.messages, "renameRemoteFile", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		expect(result.finalRemote["/sub/b.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalRemote["/sub/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O4: a remote renameDirectory failure surfaces a renameRemoteDirectory error, and a retry converges", async () => {
		const result = await runScenario({
			name: "O4",
			mode: "twoWay",
			initialLocal: { "/local/d": null },
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "d", "e")),
				control(world => world.cloud.controls.setError("renameDirectory", new Error("rename dir boom"))),
				runCycle(),
				control(world => {
					world.cloud.controls.clearError("renameDirectory")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[1]!

		// The remote source (d) is still present, so directoryExists(from) is true and the error surfaces.
		expect(hasTransfer(failCycle.messages, "renameRemoteDirectory", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		expect(result.finalRemote["/e"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/d"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O5: a download failure surfaces both a download and a downloadFile error, and a retry converges", async () => {
		// Subdirectory again, so the downloadFile catch's fileExists(path) re-check can resolve the parent.
		const result = await runScenario({
			name: "O5",
			mode: "cloudToLocal",
			initialRemote: { "/sub/a.txt": "x" },
			steps: [
				// Fail the very first cycle, while sub/a.txt must download.
				control(world => world.cloud.controls.setError("downloadFileToLocal", new Error("dl boom"))),
				runCycle(),
				control(world => {
					world.cloud.controls.clearError("downloadFileToLocal")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[0]!

		// RemoteFileSystem.download posts the `download` error before rethrowing; the downloadFile task then
		// re-checks fileExists (still present → true) and posts the `downloadFile` error + records a task error.
		expect(hasTransfer(failCycle.messages, "download", "error")).toBe(true)
		expect(hasTransfer(failCycle.messages, "downloadFile", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		expect(result.finalLocal["/sub/a.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O5b: an aborted download that RESOLVES with a short file is discarded by the integrity guard, then a retry converges", async () => {
		// Unlike O5 (where the SDK throws), the real SDK RESOLVES an aborted download — the read stream ends
		// cleanly, so the pipeline reports no error even though the staged file is incomplete. The engine must
		// NOT commit that short/0-byte file as synced (which would leave local & remote permanently diverged,
		// since the cached size then matches the base). The remote.ts size guard discards it and the next cycle
		// re-downloads in full. The fake's `simulateIncompleteDownload` reproduces the SDK's resolve-with-short
		// behavior, which `setError` (a throw) does not — this pins the guard the live suite first surfaced.
		const result = await runScenario({
			name: "O5b",
			mode: "cloudToLocal",
			initialRemote: { "/r.txt": "remote-content" },
			steps: [
				control(world => world.cloud.controls.simulateIncompleteDownload("/r.txt")),
				runCycle(),
				control(world => {
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[0]!

		// The incomplete download was detected and surfaced as a download error — not silently committed.
		expect(hasTransfer(failCycle.messages, "download", "error")).toBe(true)
		// The regression guard: WITHOUT the size check the 0-byte file is committed + cached as synced, so the
		// base matches and it never re-downloads (finalLocal stays size 0, diverged). WITH the guard the short
		// file is discarded and the engine re-fetches the full 14 bytes, converging.
		expect(result.finalLocal["/r.txt"]).toMatchObject({ type: "file", size: 14 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// LOCAL error-surface: inject on a sub-path the op touches but the existence re-check does NOT.

	it("O6: a local mkdir failure surfaces a createLocalDirectory error, and a retry converges", async () => {
		const result = await runScenario({
			name: "O6",
			mode: "cloudToLocal",
			initialRemote: { "/sub/keep.txt": "x" },
			steps: [
				// createLocalDirectory("/sub") does ensureDir("/local/sub"); inject EACCES there. This case has
				// no existence re-check, so the error surfaces directly. (/local/sub is not in the local tree
				// scan yet, so the injection only affects the mkdir.)
				control(world => world.vfs.controls.setError("/local/sub", makeErrnoError("EACCES"))),
				runCycle(),
				control(world => {
					world.vfs.controls.clearError("/local/sub")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[0]!

		expect(hasTransfer(failCycle.messages, "createLocalDirectory", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		expect(result.finalLocal["/sub"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/sub/keep.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O7: a local delete I/O failure surfaces a deleteLocalFile error (not silently swallowed)", async () => {
		// The deleteLocal catch re-checks `localFileSystem.pathExists(join(syncPair.localPath, delta.path))`,
		// so when the unlink fails while the file is still present the re-check returns true and the error
		// surfaces — a failed delete is no longer swallowed and mis-recorded as success. (BUG-007 fix: the
		// re-check previously used the RELATIVE path, which never existed, so every failure was swallowed.)
		const result = await runScenario({
			name: "O7",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "x" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				// ensureDir(<localRoot>/.filen.trash.local) throws while /local/a.txt still exists → the unlink
				// genuinely fails with the target present, which SHOULD surface a deleteLocalFile error.
				control(world => world.vfs.controls.setError("/local/.filen.trash.local", makeErrnoError("EACCES"))),
				runCycle()
			]
		})

		const failCycle = result.cycles[1]!

		expect(hasTransfer(failCycle.messages, "deleteLocalFile", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
	})

	it("O8: a local rename failure surfaces a renameLocalFile error, and a retry converges", async () => {
		const result = await runScenario({
			name: "O8",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "x" },
			steps: [
				runCycle(),
				// Remote-move a.txt into a NEW subdir: the local rename's ensureDir(<dest parent>) is then
				// "/local/sub" — a path the local tree scan never touches and which leaves the source
				// "/local/a.txt" untouched. So ensureDir throws, the re-check pathExists(from) stays true, and
				// the renameLocalFile error surfaces (rather than being swallowed as a vanished source).
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/sub/b.txt")),
				control(world => world.vfs.controls.setError("/local/sub", makeErrnoError("EACCES"))),
				runCycle(),
				control(world => {
					world.vfs.controls.clearError("/local/sub")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[1]!

		expect(hasTransfer(failCycle.messages, "renameLocalFile", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		expect(result.finalLocal["/sub/b.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// "Already-vanished" SWALLOW: the target is gone before the task runs → silent skip, no task error.

	it("O9: a concurrent local+remote delete converges with no task error (deleteLocalFile vanish)", async () => {
		const result = await runScenario({
			name: "O9",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "x" },
			steps: [
				runCycle(),
				// The remote copy is trashed and the local copy is removed in the same beat: the fresh local
				// scan no longer sees a.txt, so no deleteLocalFile is generated — a silent, error-free no-op.
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(taskErrorCount(result.messages)).toBe(0)
		expect(hasTransfer(result.messages, "deleteLocalFile", "error")).toBe(false)
		expect(result.finalLocal["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O10: cloudToLocal — a remote rename racing a local delete of the source converges (no doomed rename)", async () => {
		const result = await runScenario({
			name: "O10",
			mode: "cloudToLocal",
			initialRemote: { "/a.txt": "x" },
			steps: [
				runCycle(),
				// The remote renames a.txt→b.txt while the local source a is removed in the same beat. In
				// cloudToLocal the remote is authoritative: renaming a local source that the local side just
				// changed (here: deleted) would target a stale/absent node, so the engine correctly does NOT
				// emit the rename — it downloads the remote's b instead, so the worlds still converge. (F2)
				remoteMutate(world => world.cloud.controls.movePath("/a.txt", "/b.txt")),
				localMutate(world => rmLocal(world, "a.txt")),
				runCycle(),
				runCycle()
			]
		})

		// No task error and no errored rename transfer; the remote's b is mirrored down and both sides agree.
		expect(taskErrorCount(result.messages)).toBe(0)
		expect(hasTransfer(result.messages, "renameLocalFile", "error")).toBe(false)
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: 1 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// Directory variants of the shared deleteLocal / renameLocal cases (the file variants are O7/O8/O10):
	// these exercise the directory switch-cases and their success → state-applied paths.

	it("O11: a remote directory deletion propagates to a local deleteLocalDirectory and converges", async () => {
		const result = await runScenario({
			name: "O11",
			mode: "cloudToLocal",
			initialRemote: { "/d": null },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/d")),
				runCycle(),
				runCycle()
			]
		})

		expect(hasTransfer(result.cycles[1]!.messages, "deleteLocalDirectory", "success")).toBe(true)
		expect(taskErrorCount(result.messages)).toBe(0)
		expect(result.finalLocal["/d"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("O12: a remote directory rename propagates to a local renameLocalDirectory and converges", async () => {
		const result = await runScenario({
			name: "O12",
			mode: "cloudToLocal",
			initialRemote: { "/d": null },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/d", "/e")),
				runCycle(),
				runCycle()
			]
		})

		expect(hasTransfer(result.cycles[1]!.messages, "renameLocalDirectory", "success")).toBe(true)
		expect(taskErrorCount(result.messages)).toBe(0)
		expect(result.finalLocal["/e"]).toMatchObject({ type: "directory" })
		expect(result.finalLocal["/d"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// O13 (F1 regression): an upload that fails AFTER the file was already synced once must not poison the
	// md5 dedup cache. The modify-branch upload (deltas.ts) writes localFileHashes[path] = newHash and only
	// THEN calls uploadLocalFile; if the upload throws, the hash must be reverted (or written only on
	// success). Otherwise, after the host clears the task error (resetTaskErrors — which does NOT clear
	// localFileHashes), the next cycle recomputes the same newHash, finds it already equal to the poisoned
	// cache entry, and SUPPRESSES the re-upload → the local edit is silently never pushed and the sides
	// diverge permanently. This is the modify branch (file present on BOTH sides); a first upload goes
	// through the additions branch which has no dedup, so only an edit-after-sync exposes it.
	it("O13: an upload failure on a MODIFIED (already-synced) file does not suppress the retry (F1)", async () => {
		const result = await runScenario({
			name: "O13",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v0-initial" },
			steps: [
				runCycle(),
				// Edit the already-synced file: distinct size + newer whole-second mtime → modify branch, localWins.
				localMutate(world => writeLocalAt(world, "a.txt", "v1-edited-longer-content", BASE_TIME + 5 * SECOND)),
				control(world => world.cloud.controls.setError("uploadLocalFile", new Error("upload boom"))),
				runCycle(),
				// Host recovery: clear the injected fault and the task error. Crucially does NOT touch localFileHashes.
				control(world => {
					world.cloud.controls.clearError("uploadLocalFile")
					world.worker.resetTaskErrors(world.syncPair.uuid)
					world.triggerWatcher()
				}),
				runCycle(),
				runCycle()
			]
		})

		const failCycle = result.cycles[1]!

		// The first attempt surfaced an upload error and gated the cycle.
		expect(hasTransfer(failCycle.messages, "upload", "error")).toBe(true)
		expect(taskErrorCount(failCycle.messages)).toBeGreaterThan(0)
		// After recovery the edit IS pushed and the sides converge on the new content (not the stale v0).
		expect(result.finalRemote["/a.txt"]).toMatchObject({ type: "file", size: "v1-edited-longer-content".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	// O14 (F4 regression): a deleteLocalFile whose target already vanished must still evict the cache entry,
	// otherwise that entry is persisted into the base tree as a PHANTOM. A later re-creation of the same path
	// on the remote would then be read as a local deletion to propagate, and the engine would DELETE the
	// re-created remote file instead of downloading it. The local unlink evicts the cache only AFTER a
	// successful move/rm; when the source is already gone the move throws and the eviction is skipped — the
	// fix makes unlink idempotent (evict when the source is confirmed gone). The remote unlink already does
	// this via cleanItemEntry; this restores the symmetry on the local side.
	it("O14: a deleteLocalFile on an already-vanished target evicts the cache, so a re-created remote file is not mis-deleted (F4)", async () => {
		const result = await runScenario({
			name: "O14",
			mode: "twoWay",
			initialLocal: { "/local/a.txt": "v0" },
			steps: [
				runCycle(),
				// Remote trashes a.txt → next cycle mirrors the delete down to the local side.
				remoteMutate(world => world.cloud.controls.trashPath("/a.txt")),
				// The local copy vanishes concurrently WITHOUT a watcher event (a control step does not trigger
				// the watcher), so the cached local scan still lists a.txt and a deleteLocalFile is generated —
				// but the file is already gone when the task runs (move → ENOENT).
				control(world => rmLocal(world, "a.txt")),
				runCycle(),
				// Another device re-creates a.txt remotely (new uuid). A phantom base entry for the old local
				// a.txt would make the engine read this as a local deletion to propagate, deleting the new file.
				remoteMutate(world => world.cloud.controls.addFile("/a.txt", "v2-recreated", { mtimeMs: BASE_TIME + 9 * SECOND })),
				control(world => world.triggerWatcher()),
				runCycle(),
				runCycle()
			]
		})

		expect(taskErrorCount(result.messages)).toBe(0)
		// The re-created remote file must SURVIVE and be mirrored down — not deleted by a phantom base entry.
		expect(result.finalRemote["/a.txt"], "re-created remote file must survive").toMatchObject({
			type: "file",
			size: "v2-recreated".length
		})
		expect(result.finalLocal["/a.txt"]).toMatchObject({ type: "file", size: "v2-recreated".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
