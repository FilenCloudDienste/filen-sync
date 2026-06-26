import { vi, expect } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, restartSync, BASE_TIME, type CreateWorldOptions, type World } from "./world"
import { snapshotLocal, snapshotRemote, type WorldSnapshot } from "./snapshot"
import { type SyncMessage } from "../../src/types"

/**
 * One step in a scenario. `runCycle` drives exactly one synchronization cycle; the mutate/control
 * steps apply changes between cycles. `localMutate` automatically fires the watcher afterwards so the
 * next cycle rescans the local tree.
 */
export type Step =
	| { type: "runCycle" }
	| { type: "restart" }
	| { type: "localMutate"; mutate: (world: World) => unknown }
	| { type: "remoteMutate"; mutate: (world: World) => unknown }
	| { type: "control"; control: (world: World) => unknown }

export function runCycle(): Step {
	return { type: "runCycle" }
}

/** Simulate a process restart: reload persisted state and rebuild the engine over the same world. */
export function restart(): Step {
	return { type: "restart" }
}

export function localMutate(mutate: (world: World) => unknown): Step {
	return { type: "localMutate", mutate }
}

export function remoteMutate(mutate: (world: World) => unknown): Step {
	return { type: "remoteMutate", mutate }
}

export function control(controlFn: (world: World) => unknown): Step {
	return { type: "control", control: controlFn }
}

export type Scenario = CreateWorldOptions & {
	name: string
	steps: Step[]
}

export type RunResult = {
	world: World
	finalLocal: WorldSnapshot
	finalRemote: WorldSnapshot
	messages: SyncMessage[]
	/** Per-`runCycle` snapshots and the messages emitted during that cycle. */
	cycles: { local: WorldSnapshot; remote: WorldSnapshot; messages: SyncMessage[] }[]
}

async function applyStep(world: World, step: Step): Promise<void> {
	switch (step.type) {
		case "runCycle": {
			// Advance past the local-change debounce window so waitForLocalDirectoryChanges returns
			// immediately (its first synchronous check passes); during the cycle the clock is frozen,
			// so the engine's internal progress timeouts and the lock-refresh interval never fire.
			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

			await world.sync.runCycle()

			break
		}

		case "restart": {
			await restartSync(world)

			break
		}

		case "localMutate": {
			await step.mutate(world)

			world.triggerWatcher()

			break
		}

		case "remoteMutate": {
			await step.mutate(world)

			break
		}

		case "control": {
			await step.control(world)

			break
		}
	}
}

/**
 * Build an in-memory world from the scenario spec, run its steps under fake timers, and return the
 * final local/remote snapshots, the full message stream, and per-cycle snapshots.
 */
export async function runScenario(scenario: Scenario): Promise<RunResult> {
	// Fake only the timers the engine schedules on (debounce, lock refresh, cleanup, retries) and the
	// clock. Leave setImmediate/microtasks real so async I/O (fast-glob traversal, streams) resolves
	// while the fake clock is frozen mid-cycle.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
	vi.setSystemTime(BASE_TIME)

	try {
		const world = await createWorld(scenario)
		const cycles: { local: WorldSnapshot; remote: WorldSnapshot; messages: SyncMessage[] }[] = []

		for (const step of scenario.steps) {
			const messagesBefore = world.messages.length

			await applyStep(world, step)

			if (step.type === "runCycle") {
				cycles.push({
					local: snapshotLocal(world),
					remote: snapshotRemote(world),
					messages: world.messages.slice(messagesBefore)
				})
			}
		}

		return {
			world,
			finalLocal: snapshotLocal(world),
			finalRemote: snapshotRemote(world),
			messages: world.messages,
			cycles
		}
	} finally {
		vi.useRealTimers()
	}
}

/**
 * Assert the two normalized worlds are identical (used for twoWay equivalence: §2.3).
 */
export function expectWorldsEqual(a: WorldSnapshot, b: WorldSnapshot): void {
	expect(a).toEqual(b)
}
