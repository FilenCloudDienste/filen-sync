import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { messagesOfType } from "../harness/snapshot"
import { renameLocal } from "../harness/mutations"

/**
 * Category AO — a large restructure must NOT be mistaken for a large deletion (twoWay). With
 * requireConfirmationOnLargeDeletion on, renaming/moving an entire subtree (so every OLD path
 * disappears) must be recognized as renames — NOT as a mass deletion that empties the side and fires
 * the confirmation prompt. If the rename detection failed and fell back to delete+add, the side would
 * look emptied and the gate would (wrongly) trigger; under frozen-clock cycles that would also wedge.
 * A short per-test timeout turns such a wedge into a fast failure. Add-only.
 */
const LARGE = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`/local/bigdir/f${String(i).padStart(2, "0")}.txt`, `body-${i}`]))

function confirmPrompts(messages: Parameters<typeof messagesOfType>[0]): number {
	return messagesOfType(messages, "confirmDeletion").length
}

describe("Category AO — large rename is not a large deletion", () => {
	it("AO1: renaming a whole directory subtree does not trip the deletion gate", async () => {
		const result = await runScenario({
			name: "AO1",
			mode: "twoWay",
			requireConfirmationOnLargeDeletion: true,
			initialLocal: LARGE,
			steps: [runCycle(), localMutate(world => renameLocal(world, "bigdir", "bigdir2")), runCycle(), runCycle()]
		})

		expect(confirmPrompts(result.messages)).toBe(0)
		expect(result.finalRemote["/bigdir2/f00.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/bigdir/f00.txt"]).toBeUndefined()
		// Every file survived the rename (all 16 under the new directory name, none lost).
		expect(Object.values(result.finalRemote).filter(entry => entry.type === "file").length).toBe(Object.keys(LARGE).length)
		expect(result.finalLocal).toEqual(result.finalRemote)
	}, 15_000)

	it("AO2: moving every file into a new subdirectory does not trip the deletion gate", async () => {
		const flat = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`/local/f${String(i).padStart(2, "0")}.txt`, `body-${i}`]))
		const result = await runScenario({
			name: "AO2",
			mode: "twoWay",
			requireConfirmationOnLargeDeletion: true,
			initialLocal: flat,
			steps: [
				runCycle(),
				localMutate(world => {
					for (let i = 0; i < 16; i++) {
						const name = `f${String(i).padStart(2, "0")}.txt`
						renameLocal(world, name, `archive/${name}`)
					}
				}),
				runCycle(),
				runCycle()
			]
		})

		expect(confirmPrompts(result.messages)).toBe(0)
		expect(result.finalRemote["/archive/f00.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/f00.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	}, 15_000)

	it("AO3: a large remote-side directory rename does not trip the deletion gate", async () => {
		const result = await runScenario({
			name: "AO3",
			mode: "twoWay",
			requireConfirmationOnLargeDeletion: true,
			initialLocal: LARGE,
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.movePath("/bigdir", "/bigdir2")), runCycle(), runCycle()]
		})

		expect(confirmPrompts(result.messages)).toBe(0)
		expect(result.finalLocal["/bigdir2/f00.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/bigdir/f00.txt"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	}, 15_000)
})
