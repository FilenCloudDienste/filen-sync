import { describe, it, expect } from "vitest"
import { collapseDeltas, type Delta } from "../../src/lib/deltas"

/**
 * Direct unit coverage for the delta-collapse pass (deltas.ts). The full-cycle scenario net
 * (tests/scenarios/r-rename-stress.test.ts) can only observe convergence after the engine re-runs and
 * self-heals, which masks a corrupt FIRST cycle. These tests assert the collapse output directly, so a
 * dropped or duplicated op is caught even when a later cycle would have papered over it.
 *
 * The headline case is BUG-004's deterministic half: a child under TWO overlapping renamed parents, in
 * the array ordering that made the previous in-place splice clobber an unrelated delta.
 */
const empty = {
	renamedLocalDirectories: [] as Delta[],
	renamedRemoteDirectories: [] as Delta[],
	deletedLocalDirectories: [] as Delta[],
	deletedRemoteDirectories: [] as Delta[]
}

describe("collapseDeltas", () => {
	it("drops a child carried by its most-specific parent without clobbering an unrelated delta (specific-first ordering)", () => {
		// /a -> /x AND /a/b -> /x/y both cover /a/b/c.txt. /unrelated.txt is an independent rename that
		// must survive untouched. The most-specific parent is listed FIRST — the exact ordering under
		// which the old splice-in-place loop removed slot i then overwrote the delta that shifted into it,
		// silently dropping /unrelated.txt and emitting a bogus duplicate rename of the child.
		const deltas: Delta[] = [
			{ type: "renameLocalDirectory", path: "/a", from: "/a", to: "/x" },
			{ type: "renameLocalDirectory", path: "/a/b", from: "/a/b", to: "/x/y" },
			{ type: "renameLocalFile", path: "/a/b/c.txt", from: "/a/b/c.txt", to: "/x/y/c.txt" },
			{ type: "renameLocalFile", path: "/unrelated.txt", from: "/unrelated.txt", to: "/renamed.txt" }
		]
		const renamedLocalDirectories: Delta[] = [
			{ type: "renameLocalDirectory", path: "/a/b", from: "/a/b", to: "/x/y" },
			{ type: "renameLocalDirectory", path: "/a", from: "/a", to: "/x" }
		]

		const out = collapseDeltas({ ...empty, deltas, renamedLocalDirectories })

		// The unrelated rename survives byte-for-byte.
		expect(out).toContainEqual({ type: "renameLocalFile", path: "/unrelated.txt", from: "/unrelated.txt", to: "/renamed.txt" })
		// The child is fully carried by its immediate parent dir rename — dropped, not duplicated.
		expect(out.find(delta => delta.path === "/a/b/c.txt")).toBeUndefined()
		expect(out.filter(delta => "to" in delta && delta.to === "/x/y/c.txt")).toEqual([])
		// The nested dir rename is rewritten to its post-/a-rename source.
		expect(out).toContainEqual({ type: "renameLocalDirectory", path: "/a/b", from: "/x/b", to: "/x/y" })
		// Exactly three ops remain: the top rename, the rewritten nested rename, the unrelated rename.
		expect(out).toHaveLength(3)
	})

	it("is order-independent: general-first parent ordering yields the identical collapse", () => {
		const deltas: Delta[] = [
			{ type: "renameLocalDirectory", path: "/a", from: "/a", to: "/x" },
			{ type: "renameLocalDirectory", path: "/a/b", from: "/a/b", to: "/x/y" },
			{ type: "renameLocalFile", path: "/a/b/c.txt", from: "/a/b/c.txt", to: "/x/y/c.txt" },
			{ type: "renameLocalFile", path: "/unrelated.txt", from: "/unrelated.txt", to: "/renamed.txt" }
		]
		const renamedLocalDirectories: Delta[] = [
			{ type: "renameLocalDirectory", path: "/a", from: "/a", to: "/x" },
			{ type: "renameLocalDirectory", path: "/a/b", from: "/a/b", to: "/x/y" }
		]

		const out = collapseDeltas({ ...empty, deltas, renamedLocalDirectories })

		expect(out).toContainEqual({ type: "renameLocalFile", path: "/unrelated.txt", from: "/unrelated.txt", to: "/renamed.txt" })
		expect(out.find(delta => delta.path === "/a/b/c.txt")).toBeUndefined()
		expect(out).toContainEqual({ type: "renameLocalDirectory", path: "/a/b", from: "/x/b", to: "/x/y" })
		expect(out).toHaveLength(3)
	})

	it("rewrites (does not drop) a child rename whose target differs from the parent-implied location", () => {
		// The parent dir rename carries the file to /x/c.txt, but the user ALSO renamed the file itself,
		// so an explicit rename from the post-parent-rename source must remain.
		const deltas: Delta[] = [
			{ type: "renameLocalDirectory", path: "/a", from: "/a", to: "/x" },
			{ type: "renameLocalFile", path: "/a/c.txt", from: "/a/c.txt", to: "/x/renamed.txt" }
		]
		const renamedLocalDirectories: Delta[] = [{ type: "renameLocalDirectory", path: "/a", from: "/a", to: "/x" }]

		const out = collapseDeltas({ ...empty, deltas, renamedLocalDirectories })

		expect(out).toContainEqual({ type: "renameLocalFile", path: "/a/c.txt", from: "/x/c.txt", to: "/x/renamed.txt" })
		expect(out).toHaveLength(2)
	})

	it("leaves a rename with no covering parent untouched", () => {
		const deltas: Delta[] = [{ type: "renameLocalFile", path: "/loose.txt", from: "/loose.txt", to: "/moved.txt" }]

		const out = collapseDeltas({ ...empty, deltas })

		expect(out).toEqual(deltas)
	})

	it("collapses the remote rename side symmetrically", () => {
		const deltas: Delta[] = [
			{ type: "renameRemoteDirectory", path: "/a", from: "/a", to: "/x" },
			{ type: "renameRemoteDirectory", path: "/a/b", from: "/a/b", to: "/x/y" },
			{ type: "renameRemoteFile", path: "/a/b/c.txt", from: "/a/b/c.txt", to: "/x/y/c.txt" }
		]
		const renamedRemoteDirectories: Delta[] = [
			{ type: "renameRemoteDirectory", path: "/a/b", from: "/a/b", to: "/x/y" },
			{ type: "renameRemoteDirectory", path: "/a", from: "/a", to: "/x" }
		]

		const out = collapseDeltas({ ...empty, deltas, renamedRemoteDirectories })

		expect(out.find(delta => delta.path === "/a/b/c.txt")).toBeUndefined()
		expect(out).toContainEqual({ type: "renameRemoteDirectory", path: "/a/b", from: "/x/b", to: "/x/y" })
		expect(out).toHaveLength(2)
	})

	it("drops a child delete covered by an ancestor directory delete, keeping unrelated deletes", () => {
		const deltas: Delta[] = [
			{ type: "deleteLocalDirectory", path: "/gone" },
			{ type: "deleteLocalFile", path: "/gone/inner.txt" },
			{ type: "deleteLocalDirectory", path: "/gone/sub" },
			{ type: "deleteLocalFile", path: "/gone/sub/deep.txt" },
			{ type: "deleteLocalFile", path: "/keep-deleted.txt" }
		]
		const deletedLocalDirectories: Delta[] = [
			{ type: "deleteLocalDirectory", path: "/gone" },
			{ type: "deleteLocalDirectory", path: "/gone/sub" }
		]

		const out = collapseDeltas({ ...empty, deltas, deletedLocalDirectories })

		// Only the top-level dir delete and the unrelated file delete survive.
		expect(out).toEqual([
			{ type: "deleteLocalDirectory", path: "/gone" },
			{ type: "deleteLocalFile", path: "/keep-deleted.txt" }
		])
	})

	it("drops a child remote delete covered by an ancestor remote directory delete", () => {
		const deltas: Delta[] = [
			{ type: "deleteRemoteDirectory", path: "/gone" },
			{ type: "deleteRemoteFile", path: "/gone/inner.txt" },
			{ type: "deleteRemoteFile", path: "/keep.txt" }
		]
		const deletedRemoteDirectories: Delta[] = [{ type: "deleteRemoteDirectory", path: "/gone" }]

		const out = collapseDeltas({ ...empty, deltas, deletedRemoteDirectories })

		expect(out).toEqual([
			{ type: "deleteRemoteDirectory", path: "/gone" },
			{ type: "deleteRemoteFile", path: "/keep.txt" }
		])
	})

	it("passes non-rename / non-delete deltas through unchanged", () => {
		const deltas: Delta[] = [
			{ type: "uploadFile", path: "/up.txt", size: 12 },
			{ type: "downloadFile", path: "/down.txt", size: 34 },
			{ type: "createRemoteDirectory", path: "/newdir" },
			{ type: "createLocalDirectory", path: "/newlocal" }
		]
		const renamedLocalDirectories: Delta[] = [{ type: "renameLocalDirectory", path: "/a", from: "/a", to: "/x" }]

		const out = collapseDeltas({ ...empty, deltas, renamedLocalDirectories })

		expect(out).toEqual(deltas)
	})

	it("does not treat a sibling-prefix path as a child (no false prefix match)", () => {
		// "/abc" must NOT be collapsed under a rename of "/ab" — the boundary "/" guards against this.
		const deltas: Delta[] = [{ type: "renameLocalFile", path: "/abc.txt", from: "/abc.txt", to: "/abc2.txt" }]
		const renamedLocalDirectories: Delta[] = [{ type: "renameLocalDirectory", path: "/ab", from: "/ab", to: "/zz" }]

		const out = collapseDeltas({ ...empty, deltas, renamedLocalDirectories })

		expect(out).toEqual(deltas)
	})
})
