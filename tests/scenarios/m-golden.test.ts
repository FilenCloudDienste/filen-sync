import { describe, it, expect, beforeAll, expectTypeOf } from "vitest"
import SyncWorker, * as rootExports from "../../src/index"
import { type SyncMessage, type SyncPair, type SyncMode } from "../../src/types"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { messagesOfType } from "../harness/snapshot"
import { renameLocal, rmLocal } from "../harness/mutations"
import { DB_ROOT } from "../harness/world"
import { IGNORER_VERSION } from "../../src/ignorer"
import { DEVICE_ID_VERSION } from "../../src/lib/filesystems/remote"

/**
 * Category M — golden / compatibility pins (behavioral spec §M).
 *
 * These freeze the *public contract* downstream consumers (filen-desktop, @filen/web) depend on:
 * the {@link SyncMessage} shapes streamed over IPC, the on-disk persistence layout (a migration
 * contract), the {@link SyncWorker} constructor + method surface, and the root module's named
 * exports. They are deliberately STRUCTURAL (`toMatchObject` / `toHaveProperty` / `typeof`) rather
 * than giant value snapshots, so they document intent and survive incidental field-order changes.
 *
 * Only happy-path message families are pinned — error/`cycleError`/smoke-test shapes need error
 * injection and are covered elsewhere. The two `setTimeout`-gated lifecycle signals
 * (`cycleAcquiringLockStarted`, `cycleGettingTreesStarted`) never fire under the harness's frozen
 * clock and are intentionally NOT pinned here.
 */

/** The documented {@link SyncPair} fields every message carries under `message.syncPair`. */
const syncPairShape = {
	name: expect.any(String),
	uuid: expect.any(String),
	localPath: expect.any(String),
	remotePath: expect.any(String),
	remoteParentUUID: expect.any(String),
	mode: expect.any(String),
	excludeDotFiles: expect.any(Boolean),
	paused: expect.any(Boolean),
	localTrashDisabled: expect.any(Boolean)
}

/** Pull the first message of `type`, asserting at least one was emitted. */
function requireMessage<T extends SyncMessage["type"]>(messages: SyncMessage[], type: T): Extract<SyncMessage, { type: T }> {
	const found = messagesOfType(messages, type)[0]

	expect(found, `expected at least one "${type}" message`).toBeDefined()

	return found as Extract<SyncMessage, { type: T }>
}

/** Pull the first `transfer` message with the given `data.of` / `data.type`, asserting it exists. */
function requireTransfer(messages: SyncMessage[], of: string, type: string): Extract<SyncMessage, { type: "transfer" }> {
	const found = messagesOfType(messages, "transfer").find(message => message.data.of === of && message.data.type === type)

	expect(found, `expected a transfer message of="${of}" type="${type}"`).toBeDefined()

	return found as Extract<SyncMessage, { type: "transfer" }>
}

describe("Category M — golden / compatibility pins", () => {
	describe("M1 — SyncMessage shape pins", () => {
		let messages: SyncMessage[] = []

		// One rich twoWay scenario that exercises every happy-path op family: uploads + a created
		// remote dir, downloads + a created local dir, then a file/dir rename, then a file/dir delete.
		// All emitted messages are aggregated; each family is asserted to appear at least once with the
		// documented shape (robust to deviceId-cache settling, which only shifts WHICH cycle emits what).
		beforeAll(async () => {
			const result = await runScenario({
				name: "M1",
				mode: "twoWay",
				uuid: "11111111-1111-4111-8111-111111111111",
				initialLocal: {
					"/local/up.txt": "upload-me",
					"/local/ldir/nested.txt": "nested-content"
				},
				initialRemote: {
					"/down.txt": "download-me",
					"/rdir/rnested.txt": "rnested-content"
				},
				steps: [
					runCycle(),
					runCycle(),
					localMutate(world => {
						renameLocal(world, "up.txt", "up2.txt")
						renameLocal(world, "ldir", "ldir2")
					}),
					runCycle(),
					runCycle(),
					localMutate(world => {
						rmLocal(world, "up2.txt")
						rmLocal(world, "ldir2")
					}),
					runCycle(),
					runCycle()
				]
			})

			messages = result.messages
		})

		it("M1a: pins the upload / download progress transfer families (queued → started → progress → finished)", () => {
			for (const of of ["upload", "download"] as const) {
				expect(requireTransfer(messages, of, "queued")).toMatchObject({
					type: "transfer",
					syncPair: syncPairShape,
					data: { of, type: "queued", relativePath: expect.any(String), localPath: expect.any(String), size: expect.any(Number) }
				})

				expect(requireTransfer(messages, of, "started")).toMatchObject({
					type: "transfer",
					syncPair: syncPairShape,
					data: { of, type: "started", relativePath: expect.any(String), localPath: expect.any(String), size: expect.any(Number) }
				})

				expect(requireTransfer(messages, of, "progress")).toMatchObject({
					type: "transfer",
					syncPair: syncPairShape,
					data: {
						of,
						type: "progress",
						relativePath: expect.any(String),
						localPath: expect.any(String),
						bytes: expect.any(Number),
						size: expect.any(Number)
					}
				})

				expect(requireTransfer(messages, of, "finished")).toMatchObject({
					type: "transfer",
					syncPair: syncPairShape,
					data: { of, type: "finished", relativePath: expect.any(String), localPath: expect.any(String), size: expect.any(Number) }
				})
			}
		})

		it("M1b: pins the per-op success transfer families (uploadFile/downloadFile/create/rename/delete)", () => {
			const successOps = [
				"uploadFile",
				"downloadFile",
				"createRemoteDirectory",
				"createLocalDirectory",
				"renameRemoteFile",
				"renameRemoteDirectory",
				"deleteRemoteFile",
				"deleteRemoteDirectory"
			] as const

			for (const of of successOps) {
				expect(requireTransfer(messages, of, "success")).toMatchObject({
					type: "transfer",
					syncPair: syncPairShape,
					data: { of, type: "success", relativePath: expect.any(String), localPath: expect.any(String) }
				})
			}
		})

		it("M1c: pins the cycle lifecycle signal families (each is a bare { type, syncPair }, no data)", () => {
			// Only signals that actually fire under the harness's frozen clock; the setTimeout-gated
			// `cycleAcquiringLockStarted` / `cycleGettingTreesStarted` are deliberately excluded.
			const lifecycleTypes = [
				"cycleStarted",
				"cycleAcquiringLockDone",
				"cycleWaitingForLocalDirectoryChangesDone",
				"cycleGettingTreesDone",
				"cycleProcessingDeltasStarted",
				"cycleProcessingDeltasDone",
				"cycleProcessingTasksStarted",
				"cycleProcessingTasksDone",
				"cycleApplyingStateStarted",
				"cycleApplyingStateDone",
				"cycleSavingStateStarted",
				"cycleSavingStateDone",
				"cycleReleasingLockStarted",
				"cycleReleasingLockDone",
				"cycleSuccess"
			] as const

			for (const type of lifecycleTypes) {
				const message = requireMessage(messages, type)

				expect(message).toMatchObject({ type, syncPair: syncPairShape })
				expect(message).not.toHaveProperty("data")
			}
		})

		it("M1e: pins the cycleNoChanges signal emitted by a converged (idempotent) world", async () => {
			// `cycleNoChanges` is the steady-state quiet signal; capture it from its own converged world
			// (which reliably quiesces) rather than the busy fixture above (§A documents the settling).
			const result = await runScenario({
				name: "M1-noop",
				mode: "twoWay",
				uuid: "55555555-5555-4555-8555-555555555555",
				initialLocal: { "/local/stable.txt": "stable" },
				steps: [runCycle(), runCycle(), runCycle(), runCycle()]
			})

			const noChanges = requireMessage(result.messages, "cycleNoChanges")

			expect(noChanges).toMatchObject({ type: "cycleNoChanges", syncPair: syncPairShape })
			expect(noChanges).not.toHaveProperty("data")
		})

		it("M1d: pins the data-carrying delta / tree / error report families", () => {
			expect(requireMessage(messages, "deltasCount")).toMatchObject({
				type: "deltasCount",
				syncPair: syncPairShape,
				data: { count: expect.any(Number) }
			})

			expect(requireMessage(messages, "deltasSize")).toMatchObject({
				type: "deltasSize",
				syncPair: syncPairShape,
				data: { size: expect.any(Number) }
			})

			expect(requireMessage(messages, "localTreeIgnored")).toMatchObject({
				type: "localTreeIgnored",
				syncPair: syncPairShape,
				data: { ignored: expect.any(Array) }
			})

			expect(requireMessage(messages, "remoteTreeIgnored")).toMatchObject({
				type: "remoteTreeIgnored",
				syncPair: syncPairShape,
				data: { ignored: expect.any(Array) }
			})

			expect(requireMessage(messages, "localTreeErrors")).toMatchObject({
				type: "localTreeErrors",
				syncPair: syncPairShape,
				data: { errors: expect.any(Array) }
			})

			expect(requireMessage(messages, "taskErrors")).toMatchObject({
				type: "taskErrors",
				syncPair: syncPairShape,
				data: { errors: expect.any(Array) }
			})
		})
	})

	describe("M2 — on-disk format pins", () => {
		it("M2: pins the state/v2 + deviceId/v1 + ignorer/v1 persistence layout and serialization", async () => {
			const uuid = "22222222-2222-4222-8222-222222222222"
			const result = await runScenario({
				name: "M2",
				mode: "twoWay",
				uuid,
				initialLocal: { "/local/golden.txt": "golden-content" },
				steps: [runCycle(), runCycle(), runCycle()]
			})

			const { world } = result
			const ifs = world.vfs.ifs
			const exists = (path: string): boolean => world.vfs.controls.exists(path)
			const readLines = (path: string): string[] =>
				(ifs.readFileSync(path, "utf-8") as string).split("\n").filter(line => line.trim().length > 0)

			// --- State directory layout: the engine's own public paths must live under `state/v2/<uuid>`.
			const state = world.sync.state

			expect(state.statePath).toContain("/state/v2/")
			expect(state.statePath.endsWith(`/${uuid}`)).toBe(true)

			for (const filePath of [
				state.previousLocalTreePath,
				state.previousLocalINodesPath,
				state.previousRemoteTreePath,
				state.previousRemoteUUIDsPath,
				state.localFileHashesPath
			]) {
				expect(state.statePath.length, `${filePath} must live under statePath`).toBeGreaterThan(0)
				expect(filePath.startsWith(state.statePath)).toBe(true)
				expect(exists(filePath), `expected persisted state file ${filePath}`).toBe(true)
			}

			// --- Line-delimited JSON format: every line is `{"prop":<key>,"data":<value>}` + "\n".
			const localTreeLines = readLines(state.previousLocalTreePath)

			expect(localTreeLines.length).toBeGreaterThan(0)

			const localEntry = JSON.parse(localTreeLines[0]!) as { prop: string; data: Record<string, unknown> }

			expect(typeof localEntry.prop).toBe("string")
			expect(localEntry.data).toBeTypeOf("object")
			// A serialized LocalItem keeps `path` + `type` (the delta engine's identity fields).
			expect(localEntry.data).toHaveProperty("path")
			expect(localEntry.data).toHaveProperty("type")

			const remoteTreeLines = readLines(state.previousRemoteTreePath)

			expect(remoteTreeLines.length).toBeGreaterThan(0)

			const remoteEntry = JSON.parse(remoteTreeLines[0]!) as { prop: string; data: Record<string, unknown> }

			expect(typeof remoteEntry.prop).toBe("string")
			// A serialized RemoteItem keeps its cloud `uuid` (remote identity) + `path` + `type`.
			expect(remoteEntry.data).toHaveProperty("uuid")
			expect(remoteEntry.data).toHaveProperty("path")
			expect(remoteEntry.data).toHaveProperty("type")

			// localFileHashes maps a path → md5 hex STRING (not an object).
			const hashLines = readLines(state.localFileHashesPath)

			expect(hashLines.length).toBeGreaterThan(0)

			const hashEntry = JSON.parse(hashLines[0]!) as { prop: string; data: unknown }

			expect(typeof hashEntry.prop).toBe("string")
			expect(typeof hashEntry.data).toBe("string")

			// --- deviceId file: `deviceId/v1/<uuid>` holds a non-empty uuid string (drives the tree cache).
			expect(DEVICE_ID_VERSION).toBe(1)

			const deviceIdPath = `${DB_ROOT}/deviceId/v${DEVICE_ID_VERSION}/${uuid}`

			expect(deviceIdPath).toContain("/deviceId/v1/")
			expect(exists(deviceIdPath), `expected persisted deviceId file ${deviceIdPath}`).toBe(true)

			const deviceId = (ifs.readFileSync(deviceIdPath, "utf-8") as string).trim()

			expect(deviceId.length).toBeGreaterThan(0)
			expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

			// --- Ignorer layout: `<dbPath>/ignorer/v${IGNORER_VERSION}/<uuid>/filenIgnore`. The engine only
			// materializes this dbPath copy lazily (the physical `<localPath>/.filenignore` is the source of
			// truth), so the migration contract is pinned via the version constant + the dir-name field that
			// together compose the path, rather than via an on-disk file.
			expect(IGNORER_VERSION).toBe(1)
			expect(world.sync.ignorer.name).toBe("ignorer")

			const ignorerPath = `${DB_ROOT}/${world.sync.ignorer.name}/v${IGNORER_VERSION}/${uuid}/filenIgnore`

			expect(ignorerPath).toBe(`${DB_ROOT}/ignorer/v1/${uuid}/filenIgnore`)
		})
	})

	describe("M3 — public surface pins", () => {
		it("M3: SyncWorker is constructible with the documented options and exposes the public methods", async () => {
			// Reuse the harness to obtain a wired fake SDK; construct a worker directly to pin that the
			// documented constructor options object is accepted (sdk branch → no socket connection).
			const result = await runScenario({
				name: "M3",
				mode: "twoWay",
				uuid: "33333333-3333-4333-8333-333333333333",
				steps: [runCycle()]
			})

			expect(typeof SyncWorker).toBe("function")

			const pair: SyncPair = {
				name: "m3-pair",
				uuid: "44444444-4444-4444-8444-444444444444",
				localPath: "/local",
				remotePath: "/",
				remoteParentUUID: result.world.cloud.controls.rootUUID,
				mode: "twoWay",
				excludeDotFiles: false,
				paused: false,
				localTrashDisabled: false,
				requireConfirmationOnLargeDeletion: false
			}

			const worker = new SyncWorker({
				syncPairs: [pair],
				dbPath: DB_ROOT,
				sdk: result.world.cloud.sdk,
				onMessage: () => {},
				runOnce: true,
				disableLogging: true
			})

			expect(worker).toBeInstanceOf(SyncWorker)

			// Documented public readonly properties.
			expect(Array.isArray(worker.syncPairs)).toBe(true)
			expect(typeof worker.dbPath).toBe("string")
			expect(worker.sdk).toBeDefined()
			expect(typeof worker.syncs).toBe("object")
			expect(typeof worker.runOnce).toBe("boolean")

			// Documented public methods (config updates, deletion confirmation, ignorer, transfers, lifecycle).
			const methods = [
				"updateMode",
				"updateExcludeDotFiles",
				"updateIgnorerContent",
				"updateRequireConfirmationOnLargeDeletion",
				"confirmDeletion",
				"fetchIgnorerContent",
				"updatePaused",
				"pauseTransfer",
				"resumeTransfer",
				"stopTransfer",
				"updateSyncPairs",
				"updateRemoved",
				"resetCache",
				"resetTaskErrors",
				"resetLocalTreeErrors",
				"toggleLocalTrash",
				"initialize"
			] as const

			for (const method of methods) {
				expect(typeof worker[method], `worker.${method} should be a function`).toBe("function")
			}

			// Type-level signature pins (validated by tsc, no-op at runtime).
			expectTypeOf(worker.updateMode).parameters.toEqualTypeOf<[string, SyncMode]>()
			expectTypeOf(worker.confirmDeletion).parameters.toEqualTypeOf<[string, "delete" | "restart"]>()
			expectTypeOf(worker.updateExcludeDotFiles).parameters.toEqualTypeOf<[string, boolean]>()
			expectTypeOf(worker.fetchIgnorerContent).returns.toEqualTypeOf<Promise<string>>()
			expectTypeOf(worker.updateIgnorerContent).returns.toEqualTypeOf<Promise<void>>()
		})
	})

	describe("M4 — root exports pin", () => {
		it("M4: serializeError/deserializeError/tryingToSyncDesktop/isPathSyncedByICloud are exported functions", () => {
			// Default export is the SyncWorker class; the four utils are re-exported via `export * from "./utils"`.
			expect(typeof rootExports.default).toBe("function")
			expect(rootExports.default).toBe(SyncWorker)

			for (const name of ["serializeError", "deserializeError", "tryingToSyncDesktop", "isPathSyncedByICloud"] as const) {
				expect(rootExports, `root export "${name}" is missing`).toHaveProperty(name)
				expect(typeof rootExports[name], `root export "${name}" should be a function`).toBe("function")
			}

			// serializeError / deserializeError round-trip pins the SerializedError IPC shape.
			const original = new Error("boom")

			original.name = "GoldenError"

			const serialized = rootExports.serializeError(original)

			expect(serialized).toMatchObject({ name: "GoldenError", message: "boom", stringified: "GoldenError: boom" })
			expect(typeof serialized.stringified).toBe("string")

			const restored = rootExports.deserializeError(serialized)

			expect(restored).toBeInstanceOf(Error)
			expect(restored.message).toBe("boom")
			expect(restored.name).toBe("GoldenError")

			// tryingToSyncDesktop is a pure, synchronous predicate. isPathSyncedByICloud spawns `xattr` on
			// darwin, so it is only pinned as a callable function (not invoked) to keep the suite hermetic.
			expect(typeof rootExports.tryingToSyncDesktop("/definitely/not/the/desktop")).toBe("boolean")
			expectTypeOf(rootExports.isPathSyncedByICloud).returns.toEqualTypeOf<Promise<boolean>>()
		})
	})
})
