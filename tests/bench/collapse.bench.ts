import { describe, it, expect } from "vitest"
import { bench } from "./harness/measure"
import { collapseDeltas, type Delta } from "../../src/lib/deltas"

/**
 * collapseDeltas benchmark. After a directory rename/delete the diff emits a delta for every descendant;
 * collapseDeltas folds them into the parent op. It runs every change-cycle and the rename-top-dir delta
 * scenario showed up as the most expensive delta case, so its cost on a big subtree matters.
 */

/** One top-dir rename + `children` descendant renames that should all collapse into the parent. */
function renameSubtree(children: number): {
	deltas: Delta[]
	renamedRemoteDirectories: Delta[]
} {
	const parent: Delta = { type: "renameRemoteDirectory", path: "/dir", from: "/dir", to: "/dir2" }
	const deltas: Delta[] = [parent]

	for (let i = 0; i < children; i++) {
		// Spread across nested subdirs so nearestAncestor walks a few levels.
		const sub = i % 50
		deltas.push({
			type: "renameRemoteFile",
			path: `/dir/sub-${sub}/file-${i}.txt`,
			from: `/dir/sub-${sub}/file-${i}.txt`,
			to: `/dir2/sub-${sub}/file-${i}.txt`
		})
	}

	return { deltas, renamedRemoteDirectories: [parent] }
}

/** One top-dir delete + `children` descendant deletes that should all collapse. */
function deleteSubtree(children: number): {
	deltas: Delta[]
	deletedRemoteDirectories: Delta[]
} {
	const parent: Delta = { type: "deleteRemoteDirectory", path: "/dir" }
	const deltas: Delta[] = [parent]

	for (let i = 0; i < children; i++) {
		const sub = i % 50
		deltas.push({ type: "deleteRemoteFile", path: `/dir/sub-${sub}/file-${i}.txt` })
	}

	return { deltas, deletedRemoteDirectories: [parent] }
}

describe("collapseDeltas", () => {
	it("rename subtree collapse", async () => {
		for (const children of [10_000, 100_000, 500_000]) {
			const input = renameSubtree(children)

			const collapsed = collapseDeltas({
				deltas: input.deltas,
				renamedLocalDirectories: [],
				renamedRemoteDirectories: input.renamedRemoteDirectories,
				deletedLocalDirectories: [],
				deletedRemoteDirectories: []
			})

			// Every child folds into the single parent rename.
			expect(collapsed.length).toBe(1)

			await bench({
				group: "collapseDeltas / rename subtree",
				name: `1 dir rename + ${children} children`,
				n: children,
				iterations: 5,
				setup: () => input,
				run: i =>
					collapseDeltas({
						deltas: i.deltas,
						renamedLocalDirectories: [],
						renamedRemoteDirectories: i.renamedRemoteDirectories,
						deletedLocalDirectories: [],
						deletedRemoteDirectories: []
					})
			})
		}
	})

	it("delete subtree collapse", async () => {
		for (const children of [10_000, 100_000, 500_000]) {
			const input = deleteSubtree(children)

			const collapsed = collapseDeltas({
				deltas: input.deltas,
				renamedLocalDirectories: [],
				renamedRemoteDirectories: [],
				deletedLocalDirectories: [],
				deletedRemoteDirectories: input.deletedRemoteDirectories
			})

			expect(collapsed.length).toBe(1)

			await bench({
				group: "collapseDeltas / delete subtree",
				name: `1 dir delete + ${children} children`,
				n: children,
				iterations: 5,
				setup: () => input,
				run: i =>
					collapseDeltas({
						deltas: i.deltas,
						renamedLocalDirectories: [],
						renamedRemoteDirectories: [],
						deletedLocalDirectories: [],
						deletedRemoteDirectories: i.deletedRemoteDirectories
					})
			})
		}
	})
})
