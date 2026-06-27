import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { writeLocal, rmLocal, renameLocal } from "../harness/mutations"

/**
 * Category K — scale / stress (behavioral spec §K, §2). These exercise the perf-relevant bulk paths:
 * a wide single directory, a deep nesting chain, a large-subtree rename collapsing to one op, and a
 * heterogeneous bulk (adds + deletes + rename) in a single cycle.
 *
 * The spec aspires to much larger sizes (10k files wide, ~1k deep). CI uses a smaller but
 * representative scale that drives the identical code paths while keeping the whole file to a few
 * seconds. Every scenario asserts the §2 meta-invariants that apply: twoWay convergence
 * (`finalLocal` ≡ `finalRemote`) and idempotence (a fully settled trailing cycle emits no ops —
 * an empty `transferKinds`, which subsumes the empty-`transferOps` file-transfer check).
 */
describe("Category K — scale / stress", () => {
	it("K1: a wide tree of many files in one directory all upload and converge (twoWay)", async () => {
		// Spec §K aspires to ~10k files in one directory; CI uses a representative width.
		const fileCount = 400

		const result = await runScenario({
			name: "K1",
			mode: "twoWay",
			steps: [
				runCycle(),
				localMutate(world => {
					for (let index = 0; index < fileCount; index++) {
						writeLocal(world, `wide/file-${index}.txt`, `content-${index}`)
					}
				}),
				runCycle(),
				runCycle()
			]
		})

		// The bulk add uploaded on the op cycle.
		expect(transferKinds(result.cycles[1]!.messages)).toContain("upload")

		// Every file landed on the remote, and nothing extra was created under /wide.
		for (let index = 0; index < fileCount; index++) {
			expect(result.finalRemote[`/wide/file-${index}.txt`]).toMatchObject({ type: "file" })
		}

		expect(Object.keys(result.finalRemote).filter(path => path.startsWith("/wide/")).length).toBe(fileCount)

		// Convergence + idempotence: the worlds match and the settled cycle does no work.
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(transferKinds(result.cycles[2]!.messages)).toEqual([])
	})

	it("K2: a deeply nested chain creates every intermediate directory and converges (twoWay)", async () => {
		// Spec §K aspires to ~1000 levels of nesting; CI uses a representative depth.
		const depth = 30
		const segments: string[] = []

		for (let level = 0; level < depth; level++) {
			segments.push(`d${level}`)
		}

		const leafPath = `${segments.join("/")}/leaf.txt`

		const result = await runScenario({
			name: "K2",
			mode: "twoWay",
			steps: [runCycle(), localMutate(world => writeLocal(world, leafPath, "deep")), runCycle(), runCycle()]
		})

		// The leaf file exists at the bottom of the chain…
		expect(result.finalRemote[`/${leafPath}`]).toMatchObject({ type: "file", size: 4 })

		// …and every intermediate directory along the way was created remotely.
		let prefix = ""

		for (const segment of segments) {
			prefix += `/${segment}`

			expect(result.finalRemote[prefix]).toMatchObject({ type: "directory" })
		}

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(transferKinds(result.cycles[2]!.messages)).toEqual([])
	})

	it("K3: renaming the top directory of a big subtree is ONE op (children collapsed)", async () => {
		const dirCount = 4
		const filesPerDir = 5
		const initialLocal: Record<string, string> = {}

		for (let directory = 0; directory < dirCount; directory++) {
			for (let file = 0; file < filesPerDir; file++) {
				initialLocal[`/local/big/dir-${directory}/file-${file}.txt`] = `content-${directory}-${file}`
			}
		}

		let childUUID: string | undefined

		const result = await runScenario({
			name: "K3",
			mode: "twoWay",
			initialLocal,
			steps: [
				runCycle(),
				control(world => {
					childUUID = world.cloud.controls.getByPath("/big/dir-0/file-0.txt")?.uuid
				}),
				localMutate(world => renameLocal(world, "big", "big2")),
				runCycle(),
				runCycle()
			]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		// Exactly one parent rename carries the whole subtree — no per-child rename, no re-upload.
		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		expect(kinds).not.toContain("renameRemoteFile")
		expect(kinds).not.toContain("upload")

		// All content now lives under /big2; the old root is gone.
		expect(result.finalRemote["/big"]).toBeUndefined()

		for (let directory = 0; directory < dirCount; directory++) {
			for (let file = 0; file < filesPerDir; file++) {
				expect(result.finalRemote[`/big2/dir-${directory}/file-${file}.txt`]).toMatchObject({ type: "file" })
			}
		}

		// The child kept its remote identity → it was carried by the parent rename, not re-created.
		expect(childUUID).toBeDefined()
		expect(result.world.cloud.controls.getByPath("/big2/dir-0/file-0.txt")?.uuid).toBe(childUUID)

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(transferKinds(result.cycles[2]!.messages)).toEqual([])
	})

	it("K4: a mixed bulk (adds + deletes + dir rename) in one cycle all takes effect and converges", async () => {
		const result = await runScenario({
			name: "K4",
			mode: "twoWay",
			initialLocal: {
				"/local/docs/a.txt": "a",
				"/local/docs/b.txt": "b",
				"/local/docs/c.txt": "c",
				"/local/legacy/x.txt": "x",
				"/local/legacy/y.txt": "y",
				"/local/legacy/z.txt": "z",
				"/local/oldname/m.txt": "m",
				"/local/oldname/n.txt": "n",
				"/local/stay.txt": "stay"
			},
			steps: [
				runCycle(),
				localMutate(world => {
					// Heterogeneous deltas in a single cycle: adds (one into a brand-new directory),
					// deletes (across two directories), and a directory rename.
					writeLocal(world, "docs/d.txt", "d")
					writeLocal(world, "docs/e.txt", "e")
					writeLocal(world, "fresh/new.txt", "new")
					rmLocal(world, "docs/c.txt")
					rmLocal(world, "legacy/x.txt")
					rmLocal(world, "legacy/y.txt")
					renameLocal(world, "oldname", "newname")
				}),
				runCycle(),
				runCycle()
			]
		})

		const kinds = transferKinds(result.cycles[1]!.messages)

		// All three delta kinds were processed together in the one op cycle…
		expect(kinds).toContain("upload")
		expect(kinds.filter(kind => kind === "deleteRemoteFile")).toHaveLength(3)
		expect(kinds.filter(kind => kind === "renameRemoteDirectory")).toHaveLength(1)
		// …and the renamed directory's children were collapsed (carried, not re-renamed).
		expect(kinds).not.toContain("renameRemoteFile")

		// Adds took effect (including the new directory).
		expect(result.finalRemote["/docs/d.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/docs/e.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/fresh/new.txt"]).toMatchObject({ type: "file" })

		// Deletes took effect.
		expect(result.finalRemote["/docs/c.txt"]).toBeUndefined()
		expect(result.finalRemote["/legacy/x.txt"]).toBeUndefined()
		expect(result.finalRemote["/legacy/y.txt"]).toBeUndefined()

		// The rename took effect; the old directory name is gone, the new one holds both files.
		expect(result.finalRemote["/oldname"]).toBeUndefined()
		expect(result.finalRemote["/newname/m.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/newname/n.txt"]).toMatchObject({ type: "file" })

		// Untouched paths survived unchanged.
		expect(result.finalRemote["/docs/a.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/legacy/z.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/stay.txt"]).toMatchObject({ type: "file" })

		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(transferKinds(result.cycles[2]!.messages)).toEqual([])
	})
})
