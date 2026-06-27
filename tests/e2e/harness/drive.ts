import { type E2EWorld } from "./world"
import { snapshotLocalReal, snapshotRemoteReal } from "./assert"
import { type SyncMessage } from "../../../src/types"
import { expect } from "vitest"

/**
 * Drive exactly one synchronization cycle and return the messages it emitted.
 *
 * `resetCache` (default true) clears the in-memory local+remote tree caches and rolls the
 * local-change timestamp back, so the cycle re-reads both trees from scratch and immediately passes the
 * change-debounce — the deterministic way to make a cycle pick up a mutation we just applied. Pass
 * `false` to exercise the warm-cache / deviceId "unchanged" path (e.g. proving a settled sync no-ops).
 */
export async function cycle(world: E2EWorld, options: { resetCache?: boolean } = {}): Promise<SyncMessage[]> {
	const mark = world.messages.length

	if (options.resetCache ?? true) {
		world.worker.resetCache(world.syncPair.uuid)
	}

	await world.sync.runCycle()

	return world.messages.slice(mark)
}

/**
 * Run cycles until the world stops changing (a fixpoint of the combined local+remote structure/size
 * snapshot) or `maxCycles` is hit. Real backends settle a small tree in 2-3 cycles (transfer, then a
 * confirming no-op); the cap is a safety net, not the expected path.
 */
export async function settle(world: E2EWorld, options: { maxCycles?: number; resetCache?: boolean } = {}): Promise<void> {
	const maxCycles = options.maxCycles ?? 8
	let previous = ""

	for (let i = 0; i < maxCycles; i++) {
		await cycle(world, { resetCache: options.resetCache ?? true })

		const [local, remote] = await Promise.all([snapshotLocalReal(world), snapshotRemoteReal(world)])
		const signature = JSON.stringify([local, remote])

		if (signature === previous) {
			return
		}

		previous = signature
	}
}

const FILE_TRANSFER_OPS = ["upload", "uploadFile", "download", "downloadFile"] as const

/** The `of` discriminators of every "transfer" message in the stream. */
export function transferKinds(messages: SyncMessage[]): string[] {
	return messages.filter((message): message is Extract<SyncMessage, { type: "transfer" }> => message.type === "transfer").map(message => message.data.of)
}

/** Only the discriminators that represent an actual file transfer (not a dir/rename op). */
export function transferOps(messages: SyncMessage[]): string[] {
	return transferKinds(messages).filter(kind => (FILE_TRANSFER_OPS as readonly string[]).includes(kind))
}

/** All messages of a given `type`. */
export function messagesOfType<T extends SyncMessage["type"]>(messages: SyncMessage[], type: T): Extract<SyncMessage, { type: T }>[] {
	return messages.filter((message): message is Extract<SyncMessage, { type: T }> => message.type === type)
}

/**
 * Assert the local and remote trees are identical. With `withContent` (default) every file is hashed on
 * both sides (downloading the remote copy), so this proves real content identity, not just structure.
 */
export async function expectConverged(world: E2EWorld, options: { withContent?: boolean } = {}): Promise<void> {
	const withContent = options.withContent ?? true
	const [local, remote] = await Promise.all([snapshotLocalReal(world, { withContent }), snapshotRemoteReal(world, { withContent })])

	expect(local).toEqual(remote)
}
