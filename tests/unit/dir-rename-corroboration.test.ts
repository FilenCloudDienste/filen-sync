import { describe, it, expect } from "vitest"
import { directoryRenameCorroboratedByChild } from "../../src/lib/deltas"
import { type LocalTree, type LocalItem } from "../../src/lib/filesystems/local"

/**
 * Unit coverage for the directory-rename birthtime-unreliability hardening (deltas.ts). When a platform
 * rewrites a directory's creation/birthtime across a rename (observed on Windows), the inode+birthtime
 * rename guard would wrongly reject the rename, breaking cross-side dir-rename reconciliation. The
 * corroboration fallback accepts the rename iff a child IDENTITY survived the move — which an inode-reuse
 * coincidence (a brand-new directory on a recycled inode) never has. The full live behavior is validated
 * by the e2e edge BUG-A/BUG-B tests on a real Windows runner; this pins the decision logic deterministically
 * (memfs cannot simulate a birthtime rewrite). NEW FILE — does not touch existing tests.
 */
function item(path: string, inode: number, type: "file" | "directory" = "file"): LocalItem {
	return { path, inode, type, lastModified: 1, creation: 1, size: 0 }
}

function tree(items: LocalItem[]): LocalTree {
	const built: LocalTree = { tree: {}, inodes: {}, size: items.length }

	for (const entry of items) {
		built.tree[entry.path] = entry
		built.inodes[entry.inode] = entry
	}

	return built
}

describe("directoryRenameCorroboratedByChild (dir-rename birthtime hardening)", () => {
	it("corroborates when a child inode moved from under the old dir to under the new dir", () => {
		const previous = tree([item("/dir", 1, "directory"), item("/dir/child.txt", 2)])
		const current = tree([item("/dir2", 1, "directory"), item("/dir2/child.txt", 2)])

		expect(directoryRenameCorroboratedByChild("/dir", "/dir2", current, previous)).toBe(true)
	})

	it("corroborates a deeply-nested surviving child too", () => {
		const previous = tree([item("/dir", 1, "directory"), item("/dir/sub", 2, "directory"), item("/dir/sub/deep.txt", 3)])
		const current = tree([item("/dir2", 1, "directory"), item("/dir2/sub", 2, "directory"), item("/dir2/sub/deep.txt", 3)])

		expect(directoryRenameCorroboratedByChild("/dir", "/dir2", current, previous)).toBe(true)
	})

	it("does NOT corroborate an inode-reuse coincidence (new dir shares no children with the old)", () => {
		// /dir (inode 1) was deleted; a brand-new /dir2 reuses inode 1 but holds its own, different child.
		const previous = tree([item("/dir", 1, "directory"), item("/dir/old.txt", 2)])
		const current = tree([item("/dir2", 1, "directory"), item("/dir2/fresh.txt", 9)])

		expect(directoryRenameCorroboratedByChild("/dir", "/dir2", current, previous)).toBe(false)
	})

	it("does NOT corroborate an empty directory (no child to vouch for it)", () => {
		const previous = tree([item("/dir", 1, "directory")])
		const current = tree([item("/dir2", 1, "directory")])

		expect(directoryRenameCorroboratedByChild("/dir", "/dir2", current, previous)).toBe(false)
	})

	it("is not fooled by a similarly-prefixed sibling directory (slash-guarded prefix)", () => {
		// A child under "/dir22" must not be read as a child of "/dir2".
		const previous = tree([item("/dir", 1, "directory"), item("/dir/child.txt", 2)])
		const current = tree([item("/dir2", 1, "directory"), item("/dir22/child.txt", 2)])

		expect(directoryRenameCorroboratedByChild("/dir", "/dir2", current, previous)).toBe(false)
	})
})
