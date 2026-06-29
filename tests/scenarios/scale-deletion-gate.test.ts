import { describe, it, expect, vi } from "vitest"
import pathModule from "path"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME, DB_ROOT, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotRemote, snapshotLocal, messagesOfType } from "../harness/snapshot"
import { IGNORER_VERSION } from "../../src/ignorer"
import { genDirs, genNoise, mergeSpecs } from "../harness/scale"

/** Seed the dbPath-side `.filenignore` copy (merged with the physical one each cycle). It does NOT itself
 * sync, so it can empty the local scan to size 0 — needed to exercise the gate's count-decrement path even
 * now that the PHYSICAL `.filenignore` syncs and would otherwise keep the tree non-empty. */
function writeDbIgnore(world: World, content: string): void {
	const dir = pathModule.posix.join(DB_ROOT, "ignorer", `v${IGNORER_VERSION}`, world.syncPair.uuid)

	world.vfs.ifs.mkdirSync(dir, { recursive: true })
	world.vfs.ifs.writeFileSync(pathModule.posix.join(dir, "filenIgnore"), content)
}

/**
 * Category LG2 — the large-deletion confirmation gate (Category G / ZT) at SCALE. The gate keys on the RAW
 * delete counts tallied across the deletion passes and decremented by the survivor + ignore filters, gated
 * by `previous.size <= deleteCount` and `current.size === 0`. G/ZT pin this with 2–3 files; what is unpinned
 * is the COUNTING and the ALL-OR-NOTHING application over a big tree: a declined large deletion must leave
 * EVERY item intact (no partial apply) and re-propose next cycle (base not advanced), a confirmed one must
 * empty the whole side, and ignoring a big synced subtree must NOT be miscounted as an emptying. add-only.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const

async function withWorld(options: CreateWorldOptions, body: (world: World) => Promise<void>): Promise<void> {
	vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
	vi.setSystemTime(BASE_TIME)

	try {
		const world = await createWorld(options)

		await body(world)
	} finally {
		vi.useRealTimers()
	}
}

async function plainCycle(world: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	await world.sync.runCycle()
}

async function cycleWithDecision(world: World, decision: "delete" | "restart"): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	let settled = false
	const cyclePromise = world.sync.runCycle().finally(() => {
		settled = true
	})

	for (let tick = 0; tick < 30 && !settled; tick++) {
		world.worker.confirmDeletion(world.syncPair.uuid, decision)

		await vi.advanceTimersByTimeAsync(1000)
	}

	await cyclePromise
}

function confirmDeletionCount(world: World): number {
	return messagesOfType(world.messages, "confirmDeletion").length
}

// A big synced tree: 8 dirs × 6 files + 20 root files = 68 files (plus dir nodes).
function bigTree(): Record<string, string> {
	return mergeSpecs(genDirs("g", 8, 6), genNoise("root", 20))
}

describe("Category LG2 — large-deletion gate, at scale", () => {
	it("LG2a: emptying a BIG local tree prompts with the correct counts and confirming empties the remote", async () => {
		await withWorld(
			{ mode: "twoWay", requireConfirmationOnLargeDeletion: true, initialLocal: bigTree() },
			async world => {
				await plainCycle(world)

				const previousSize = world.sync.previousLocalTree.size

				expect(previousSize, "the base tree should be large").toBeGreaterThan(68)

				// Wipe the WHOLE local tree.
				world.vfs.ifs.rmSync(`${world.localPath}/g`, { recursive: true, force: true })
				world.vfs.ifs.rmSync(`${world.localPath}/root`, { recursive: true, force: true })
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				const prompts = messagesOfType(world.messages, "confirmDeletion")

				expect(prompts.length).toBeGreaterThan(0)
				expect(prompts[0]!.data.where).toBe("local")
				// The gate reports the real scale: previous = the whole base, current = 0.
				expect(prompts[0]!.data.previous).toBe(previousSize)
				expect(prompts[0]!.data.current).toBe(0)
				// "delete" → the remote is emptied to match.
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})

	it("LG2b: declining a BIG emptying preserves EVERY item (no partial apply) and re-proposes next cycle", async () => {
		await withWorld(
			{ mode: "twoWay", requireConfirmationOnLargeDeletion: true, initialLocal: bigTree() },
			async world => {
				await plainCycle(world)

				const remoteBefore = snapshotRemote(world)

				expect(Object.keys(remoteBefore).length).toBeGreaterThan(68)

				world.vfs.ifs.rmSync(`${world.localPath}/g`, { recursive: true, force: true })
				world.vfs.ifs.rmSync(`${world.localPath}/root`, { recursive: true, force: true })
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				const promptsAfterFirst = confirmDeletionCount(world)

				expect(promptsAfterFirst).toBeGreaterThan(0)
				// NOTHING was deleted — the remote is byte-for-byte what it was (no partial application).
				expect(snapshotRemote(world)).toEqual(remoteBefore)

				// The base was not advanced (a declined cycle never saves), so when the still-empty directory is
				// re-observed the next cycle re-derives the SAME deletes and prompts AGAIN — the gate keeps asking
				// until the user resolves it, never silently applying. (Re-trigger the watcher so the cycle
				// re-scans rather than short-circuiting on the unchanged-tree cache.)
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(promptsAfterFirst)
				expect(snapshotRemote(world)).toEqual(remoteBefore)
			}
		)
	})

	it("LG2c: ignoring a BIG synced subtree does NOT false-fire the gate and keeps every backup (ZT at scale)", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				// Everything under one bare, glob-prunable directory so ignoring it empties the local scan to
				// size 0 (the gate's count-decrement path). The ignore rule is seeded via the dbPath copy, which
				// does NOT sync — so it empties the scan without a physical `.filenignore` keeping the tree
				// non-empty (the physical file now syncs by design).
				initialLocal: genDirs("vault", 10, 6)
			},
			async world => {
				await plainCycle(world)

				const remoteBefore = snapshotRemote(world)

				expect(Object.keys(remoteBefore).length).toBeGreaterThan(60)

				// Ignore the whole subtree by bare name (glob-pruned from the scan → local scan size 0).
				writeDbIgnore(world, "vault")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				// Ignoring is not deleting: NO prompt, and every remote backup survives untouched.
				expect(confirmDeletionCount(world)).toBe(0)
				expect(snapshotRemote(world)).toEqual(remoteBefore)
				// Locally the ignored files are still on disk (ignore ≠ delete).
				expect(Object.keys(snapshotLocal(world)).length).toBeGreaterThan(60)
			}
		)
	})
})
