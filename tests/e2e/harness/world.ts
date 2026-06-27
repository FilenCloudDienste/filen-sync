import type FilenSDK from "@filen/sdk"
import Sync from "../../../src/lib/sync"
import SyncWorker from "../../../src/index"
import { type SyncPair, type SyncMessage, type SyncMode } from "../../../src/types"
import { type SyncEnvironment, defaultEnvironment } from "../../../src/lib/environment"
import os from "os"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"

export type E2EWorldOptions = {
	sdk: FilenSDK
	mode: SyncMode
	/** Default true: local deletions are permanent (no `.filen.trash` subdir to reason about). */
	localTrashDisabled?: boolean
	excludeDotFiles?: boolean
	requireConfirmationOnLargeDeletion?: boolean
	/** `.filenignore` contents to seed at the local root before the first cycle. */
	filenIgnore?: string
	/**
	 * Default false: use a no-op watcher and drive cycles manually (deterministic). Set true only for a
	 * test that specifically exercises the production fs.watch watcher.
	 */
	useRealWatcher?: boolean
}

export type E2EWorld = {
	sdk: FilenSDK
	worker: SyncWorker
	sync: Sync
	syncPair: SyncPair
	messages: SyncMessage[]
	/** The unique id for this world; used for both the local tmp dir name and the remote dir name. */
	runId: string
	/** UUID of the remote `/<runId>` directory that is this sync's remote root. */
	remoteParentUUID: string
	/** Absolute path of the local sync root (a fresh tmp dir). */
	localRoot: string
	/** Absolute path of the per-world state/db dir (a fresh tmp dir). */
	dbPath: string
	/** Absolute path of the tmp dir tree that holds localRoot + dbPath (removed on teardown). */
	workRoot: string
}

const noopWatcher: SyncEnvironment["createWatcher"] = async () => ({
	close: async (): Promise<void> => {}
})

/**
 * Build a real, isolated sync world against the live account:
 *   - a remote directory `/<runId>` under the account's base folder is the sync's remote root,
 *   - a fresh local tmp dir is the sync's local root, with its state/db in a sibling tmp dir,
 *   - a real {@link SyncWorker}/{@link Sync} wired with the PRODUCTION environment (real fs, real
 *     write-file-atomic, the msgpack `fetchDirTree`) so the engine talks to the real backend exactly as
 *     it does in the desktop client. Only the directory watcher is a no-op by default — cycles are
 *     driven explicitly for determinism.
 *
 * Always pair with {@link destroyE2EWorld} (permanent remote delete + trash empty + local tmp removal).
 */
export async function createE2EWorld(options: E2EWorldOptions): Promise<E2EWorld> {
	const { sdk } = options
	const runId = uuidv4()
	const baseFolderUUID = sdk.config.baseFolderUUID

	if (!baseFolderUUID || baseFolderUUID.length === 0) {
		throw new Error("SDK has no baseFolderUUID — login likely failed.")
	}

	// Remote root: a fresh /<runId> directory under the account base folder.
	const remoteParentUUID = await sdk.cloud().createDirectory({
		name: runId,
		parent: baseFolderUUID
	})

	// Local roots: a fresh tmp tree, sync dir + db dir as siblings.
	const workRoot = pathModule.join(os.tmpdir(), `filen-sync-e2e-${runId}`)
	const localRoot = pathModule.join(workRoot, "local")
	const dbPath = pathModule.join(workRoot, "db")

	await fs.ensureDir(localRoot)
	await fs.ensureDir(dbPath)

	if (typeof options.filenIgnore === "string") {
		await fs.writeFile(pathModule.join(localRoot, ".filenignore"), options.filenIgnore)
	}

	const messages: SyncMessage[] = []
	const syncPair: SyncPair = {
		name: `e2e-${runId}`,
		uuid: runId,
		localPath: localRoot,
		remotePath: `/${runId}`,
		remoteParentUUID,
		mode: options.mode,
		excludeDotFiles: options.excludeDotFiles ?? false,
		paused: false,
		localTrashDisabled: options.localTrashDisabled ?? true,
		requireConfirmationOnLargeDeletion: options.requireConfirmationOnLargeDeletion ?? false
	}

	const environment: SyncEnvironment = options.useRealWatcher
		? defaultEnvironment()
		: { ...defaultEnvironment(), createWatcher: noopWatcher }

	const worker = new SyncWorker({
		syncPairs: [syncPair],
		dbPath,
		sdk,
		onMessage: message => {
			messages.push(message)
		},
		disableLogging: true,
		environment
	})

	const sync = new Sync({ syncPair, worker })

	worker.syncs[syncPair.uuid] = sync

	// Mirror the harness pattern: load persisted state directly and drive discrete cycles ourselves
	// instead of letting initialize() start the self-scheduling loop.
	await sync.state.initialize()
	await sync.ignorer.initialize()

	return {
		sdk,
		worker,
		sync,
		syncPair,
		messages,
		runId,
		remoteParentUUID,
		localRoot,
		dbPath,
		workRoot
	}
}

/**
 * Tear a world down completely and leave the account clean:
 *   1. permanently delete the remote `/<runId>` directory (real delete, NOT trash),
 *   2. empty the account trash (the engine trashes its own deletions during a test; a dedicated test
 *      account means this is safe and is what "no trash left behind" requires),
 *   3. remove the local tmp tree.
 * Every step is best-effort so one failure cannot strand the others.
 */
export async function destroyE2EWorld(world: E2EWorld): Promise<void> {
	try {
		await world.sync.cleanup({ deleteLocalDbFiles: false })
	} catch {
		// best effort
	}

	try {
		await world.sdk.cloud().deleteDirectory({ uuid: world.remoteParentUUID })
	} catch {
		// already gone
	}

	try {
		await world.sdk.cloud().emptyTrash()
	} catch {
		// best effort
	}

	try {
		await fs.rm(world.workRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
	} catch {
		// best effort
	}
}

/**
 * Simulate a process restart / client upgrade: rebuild the worker + sync over the SAME local dir, db
 * dir, and remote root, so persisted state (previous trees, deviceId, hashes) is reloaded from disk.
 * Mutates `world` in place and keeps appending to the same message stream.
 */
export async function restartE2EWorld(world: E2EWorld, options: { useRealWatcher?: boolean } = {}): Promise<void> {
	try {
		await world.sync.cleanup({ deleteLocalDbFiles: false })
	} catch {
		// best effort
	}

	const environment: SyncEnvironment = options.useRealWatcher ? defaultEnvironment() : { ...defaultEnvironment(), createWatcher: noopWatcher }

	const worker = new SyncWorker({
		syncPairs: [world.syncPair],
		dbPath: world.dbPath,
		sdk: world.sdk,
		onMessage: message => {
			world.messages.push(message)
		},
		disableLogging: true,
		environment
	})

	const sync = new Sync({ syncPair: world.syncPair, worker })

	worker.syncs[world.syncPair.uuid] = sync

	await sync.state.initialize()
	await sync.ignorer.initialize()

	world.worker = worker
	world.sync = sync
}

/**
 * Create a world, run `body`, and ALWAYS tear it down (permanent remote delete + trash empty + local
 * tmp removal) — even when the body throws. The standard way to write an e2e case so no account state
 * leaks between tests or on failure.
 */
export async function withE2EWorld(options: E2EWorldOptions, body: (world: E2EWorld) => Promise<void>): Promise<void> {
	const world = await createE2EWorld(options)

	try {
		await body(world)
	} finally {
		await destroyE2EWorld(world)
	}
}
