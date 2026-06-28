import { describe, it, expect } from "vitest"
import pathModule from "path"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { messagesOfType } from "../harness/snapshot"
import { renameLocal } from "../harness/mutations"

/**
 * The rename transfer messages now carry BOTH endpoints (`from` + `to`), not just the destination, so a
 * consumer (the desktop sync log) can tell an in-place RENAME (same parent directory) from a MOVE
 * (different parent) — the engine itself treats both as a single path change. This pins that the fields
 * are present and correct for both shapes.
 *
 * NEW FILE — does not touch existing tests.
 */
function renameFromTo(cycleMessages: Parameters<typeof messagesOfType>[0]): { from: string; to: string } {
	for (const message of messagesOfType(cycleMessages, "transfer")) {
		const data = message.data

		if (data.type === "success" && (data.of === "renameRemoteFile" || data.of === "renameLocalFile")) {
			return { from: data.from, to: data.to }
		}
	}

	throw new Error("no successful file-rename transfer message found")
}

describe("rename transfer messages carry from/to (move vs rename for the log)", () => {
	it("an in-place rename reports from/to in the SAME directory", async () => {
		const result = await runScenario({
			name: "inplace-rename",
			mode: "twoWay",
			initialLocal: { "/local/dir/foo.txt": "x" },
			steps: [runCycle(), localMutate(world => renameLocal(world, "dir/foo.txt", "dir/bar.txt")), runCycle(), runCycle()]
		})

		const { from, to } = renameFromTo(result.cycles[1]!.messages)

		expect(from).toBe("/dir/foo.txt")
		expect(to).toBe("/dir/bar.txt")
		// Same parent => the consumer renders "renamed".
		expect(pathModule.posix.dirname(from)).toBe(pathModule.posix.dirname(to))
	})

	it("a move (different parent) reports from/to in DIFFERENT directories", async () => {
		const result = await runScenario({
			name: "move",
			mode: "twoWay",
			initialLocal: { "/local/dir1/foo.txt": "x", "/local/dir2/keep.txt": "k" },
			steps: [runCycle(), localMutate(world => renameLocal(world, "dir1/foo.txt", "dir2/foo.txt")), runCycle(), runCycle()]
		})

		const { from, to } = renameFromTo(result.cycles[1]!.messages)

		expect(from).toBe("/dir1/foo.txt")
		expect(to).toBe("/dir2/foo.txt")
		// Different parent => the consumer renders "moved", even though the engine did the same path-change op.
		expect(pathModule.posix.dirname(from)).not.toBe(pathModule.posix.dirname(to))
	})
})
