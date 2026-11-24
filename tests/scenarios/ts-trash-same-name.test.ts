import { describe, it, expect } from "vitest"
import pathModule from "path"
import { runScenario, runCycle, remoteMutate } from "../harness/runner"
import { LOCAL_ROOT, type World } from "../harness/world"
import { readLocal } from "../harness/mutations"
import { toPosixPath } from "../fakes/virtual-fs"
import { LOCAL_TRASH_NAME } from "../../src/constants"

/**
 * Category TS — local trash must not overwrite earlier entries that share a basename.
 *
 * A local delete moves the item to `.filen.trash.local/<basename>`. With `overwrite: true` and no collision
 * handling, two deletions of different paths with the same basename (e.g. `/a/report.txt` and `/b/report.txt`)
 * made the second move silently replace the first — destroying the only local recovery copy of the first file.
 * Each trashed item now gets a unique name inside the trash.
 */

const TRASH_ROOT = pathModule.posix.join(LOCAL_ROOT, LOCAL_TRASH_NAME)

function trashEntries(world: World): string[] {
	return (world.vfs.ifs.readdirSync(toPosixPath(TRASH_ROOT)) as string[]).sort()
}

function trashContents(world: World): string[] {
	return trashEntries(world)
		.map(name => readLocal(world, `${LOCAL_TRASH_NAME}/${name}`))
		.sort()
}

describe("Category TS — local trash keeps same-basename entries", () => {
	it("TS1: two same-named files deleted in the same cycle both survive in the local trash", async () => {
		const result = await runScenario({
			name: "TS1",
			mode: "twoWay",
			initialRemote: { "/a/report.txt": "from a", "/b/report.txt": "from b" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/a/report.txt")),
				remoteMutate(world => world.cloud.controls.trashPath("/b/report.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(trashEntries(result.world), "both trashed files must have a distinct entry").toHaveLength(2)
		expect(trashContents(result.world), "the second trash move overwrote the first file's recovery copy").toEqual(["from a", "from b"])
	})

	it("TS2: same-named files deleted in separate cycles both survive", async () => {
		const result = await runScenario({
			name: "TS2",
			mode: "cloudToLocal",
			initialRemote: { "/a/report.txt": "from a", "/b/report.txt": "from b" },
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/a/report.txt")),
				runCycle(),
				remoteMutate(world => world.cloud.controls.trashPath("/b/report.txt")),
				runCycle(),
				runCycle()
			]
		})

		expect(trashContents(result.world)).toEqual(["from a", "from b"])
	})

	it("TS3: without a collision the trashed item keeps its plain basename", async () => {
		const result = await runScenario({
			name: "TS3",
			mode: "cloudToLocal",
			initialRemote: { "/notes.md": "only one" },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.trashPath("/notes.md")), runCycle()]
		})

		expect(trashEntries(result.world)).toEqual(["notes.md"])
	})
})
