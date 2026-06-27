import SyncWorker from "../../src/index"
import Sync from "../../src/lib/sync"
import { type SyncPair, type SyncMode, type SyncMessage } from "../../src/types"
import { type SyncEnvironment, type SyncWatcher } from "../../src/lib/environment"
import { createVirtualFS, type VfsSpec, type VirtualFS } from "../fakes/virtual-fs"
import { createFakeCloud, type CloudSpec, type FakeCloud } from "../fakes/fake-cloud"
import { v4 as uuidv4 } from "uuid"

/**
 * A fixed, realistic base time so file mtimes are large ms values (the engine's
 * `convertTimestampToMs` treats them as already-ms) and the fake clock is deterministic.
 */
export const BASE_TIME = new Date("2024-06-01T00:00:00.000Z").getTime()

export const LOCAL_ROOT = "/local"
export const DB_ROOT = "/db"

export type CreateWorldOptions = {
	mode: SyncMode
	initialLocal?: VfsSpec
	initialRemote?: CloudSpec
	excludeDotFiles?: boolean
	localTrashDisabled?: boolean
	requireConfirmationOnLargeDeletion?: boolean
	paused?: boolean
	uuid?: string
	filenIgnore?: string
}

export type World = {
	worker: SyncWorker
	sync: Sync
	vfs: VirtualFS
	cloud: FakeCloud
	messages: SyncMessage[]
	syncPair: SyncPair
	localPath: string
	/** Simulate the directory watcher firing (a local change was observed). */
	triggerWatcher: () => void
}

/**
 * A manual watcher whose `onChange` callbacks are invoked on demand, so tests deterministically
 * tell the engine "the local directory changed" instead of relying on a real fs watcher.
 */
function createManualWatcher(): { factory: SyncEnvironment["createWatcher"]; trigger: () => void } {
	const callbacks = new Set<() => void>()

	return {
		factory: async (_path: string, onChange: () => void): Promise<SyncWatcher> => {
			callbacks.add(onChange)

			return {
				close: async (): Promise<void> => {
					callbacks.delete(onChange)
				}
			}
		},
		trigger: (): void => {
			for (const callback of callbacks) {
				callback()
			}
		}
	}
}

/**
 * Build a fully wired, in-memory sync world: a virtual filesystem + a stateful fake cloud injected
 * into a real {@link SyncWorker}/{@link Sync}, with all engine I/O routed through the fakes and the
 * scheduling loop bypassed (the runner drives {@link Sync.runCycle} directly).
 *
 * Must be called with vitest fake timers already installed and the system time set, so memfs and the
 * engine share a deterministic clock.
 */
export async function createWorld(options: CreateWorldOptions): Promise<World> {
	const localSpec: VfsSpec = { [LOCAL_ROOT]: null, [DB_ROOT]: null }

	for (const [path, value] of Object.entries(options.initialLocal ?? {})) {
		localSpec[path] = value
	}

	if (typeof options.filenIgnore === "string") {
		localSpec[`${LOCAL_ROOT}/.filenignore`] = options.filenIgnore
	}

	const vfs = createVirtualFS(localSpec)
	const cloud = createFakeCloud(options.initialRemote ?? {}, { localFs: vfs.fs })
	const watcher = createManualWatcher()

	const environment: SyncEnvironment = {
		fs: vfs.fs,
		globFs: vfs.globFs,
		writeFileAtomic: async (filename, data, writeOptions): Promise<void> => {
			await vfs.fs.writeFile(filename, data, writeOptions)
		},
		createWatcher: watcher.factory,
		// Route the tree fetch back through the fake cloud's SDK so every scenario exercises the real
		// engine logic without HTTP/msgpack (the production msgpack path is unit-tested separately).
		fetchDirTree: (_sdk, request) => cloud.sdk.api(3).dir().tree(request)
	}

	const messages: SyncMessage[] = []
	const syncPair: SyncPair = {
		name: "test-pair",
		uuid: options.uuid ?? uuidv4(),
		localPath: LOCAL_ROOT,
		remotePath: "/",
		remoteParentUUID: cloud.controls.rootUUID,
		mode: options.mode,
		excludeDotFiles: options.excludeDotFiles ?? false,
		paused: options.paused ?? false,
		localTrashDisabled: options.localTrashDisabled ?? false,
		requireConfirmationOnLargeDeletion: options.requireConfirmationOnLargeDeletion ?? false
	}

	const worker = new SyncWorker({
		syncPairs: [syncPair],
		dbPath: DB_ROOT,
		sdk: cloud.sdk,
		onMessage: message => {
			messages.push(message)
		},
		disableLogging: true,
		environment
	})

	const sync = new Sync({ syncPair, worker })

	worker.syncs[syncPair.uuid] = sync

	// The engine's initialize() would also call run() (the self-scheduling loop); we skip it and
	// load persisted state directly so the runner can drive discrete cycles.
	await sync.state.initialize()
	await sync.ignorer.initialize()

	return {
		worker,
		sync,
		vfs,
		cloud,
		messages,
		syncPair,
		localPath: LOCAL_ROOT,
		triggerWatcher: watcher.trigger
	}
}

/**
 * Simulate a process restart: rebuild the worker/sync over the SAME virtual filesystem and cloud,
 * so persisted state (previous trees, deviceId, ignorer) is reloaded from disk. Mutates `world` in
 * place (new worker/sync/watcher) and keeps appending to the same message stream.
 */
export async function restartSync(world: World): Promise<void> {
	const watcher = createManualWatcher()

	const environment: SyncEnvironment = {
		fs: world.vfs.fs,
		globFs: world.vfs.globFs,
		writeFileAtomic: async (filename, data, writeOptions): Promise<void> => {
			await world.vfs.fs.writeFile(filename, data, writeOptions)
		},
		createWatcher: watcher.factory,
		fetchDirTree: (_sdk, request) => world.cloud.sdk.api(3).dir().tree(request)
	}

	const worker = new SyncWorker({
		syncPairs: [world.syncPair],
		dbPath: DB_ROOT,
		sdk: world.cloud.sdk,
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
	world.triggerWatcher = watcher.trigger
}
