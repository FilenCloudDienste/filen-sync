import { describe, it, expect } from "vitest"
import { APIError } from "@filen/sdk"
import { createFakeCloud, type CloudSpec } from "./fake-cloud"
import { createVirtualFS, type VfsSpec } from "./virtual-fs"

function setup(localSpec: VfsSpec = {}, cloudSpec: CloudSpec = {}) {
	const vfs = createVirtualFS(localSpec)
	const cloud = createFakeCloud(cloudSpec, { localFs: vfs.fs })

	return { vfs, cloud, sdk: cloud.sdk, controls: cloud.controls }
}

describe("fake cloud — tree, cache, tuples", () => {
	it("returns the root folder with parent 'base' and no files for an empty cloud", async () => {
		const { sdk, controls } = setup()

		const tree = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1" })

		expect(tree.files).toEqual([])
		expect(tree.folders).toHaveLength(1)
		expect(tree.folders[0]![0]).toBe(controls.rootUUID)
		expect(tree.folders[0]![2]).toBe("base")
	})

	it("emits the canonical file tuple order [uuid,bucket,region,chunks,parent,metadata,version,n]", async () => {
		const { vfs, sdk, controls } = setup({ "/src/a.txt": "hello world" })

		const item = await sdk.cloud().uploadLocalFile({ source: "/src/a.txt", parent: controls.rootUUID, name: "a.txt" })
		const tree = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1", skipCache: true })
		const fileTuple = tree.files.find(file => file[0] === item.uuid)!

		expect(fileTuple).toBeDefined()
		expect(fileTuple[0]).toBe(item.uuid) // uuid
		expect(fileTuple[1]).toBe("filen-1") // bucket
		expect(fileTuple[2]).toBe("de-1") // region
		expect(fileTuple[3]).toBe(1) // chunks (11 bytes → 1 chunk)
		expect(fileTuple[4]).toBe(controls.rootUUID) // parent
		expect(fileTuple[6]).toBe(2) // version

		expect(item.type).toBe("file")

		const decrypted = await sdk.crypto().decrypt().fileMetadata({ metadata: fileTuple[5] })

		expect(decrypted.name).toBe("a.txt")
		expect(decrypted.size).toBe("hello world".length)

		if (item.type === "file") {
			expect(decrypted.key).toBe(item.key)
		}

		// uploadLocalFile reads the bytes from the injected virtual filesystem.
		expect(item.size).toBe("hello world".length)
		void vfs
	})

	it("honors the per-deviceId revision cache (unchanged → empty, skipCache → full, new device → full)", async () => {
		const { sdk, controls } = setup()

		await sdk.cloud().createDirectory({ name: "docs", parent: controls.rootUUID })

		// First fetch for device-1 → full tree.
		const first = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1" })
		expect(first.folders.length).toBe(2)

		// Nothing changed since device-1 last fetched → empty "unchanged" response.
		const second = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1" })
		expect(second.files).toEqual([])
		expect(second.folders).toEqual([])

		// skipCache always returns the full tree.
		const skip = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1", skipCache: true })
		expect(skip.folders.length).toBe(2)

		// A different device has never fetched → full tree.
		const otherDevice = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-2" })
		expect(otherDevice.folders.length).toBe(2)

		// A mutation invalidates device-1's cache.
		await sdk.cloud().createDirectory({ name: "more", parent: controls.rootUUID })
		const afterChange = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1" })
		expect(afterChange.folders.length).toBe(3)
	})
})

describe("fake cloud — directories, decrypt", () => {
	it("createDirectory adds a folder tuple and is idempotent by name", async () => {
		const { sdk, controls } = setup()

		const uuid1 = await sdk.cloud().createDirectory({ name: "docs", parent: controls.rootUUID })
		const uuid2 = await sdk.cloud().createDirectory({ name: "docs", parent: controls.rootUUID })

		expect(uuid2).toBe(uuid1)

		const tree = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1", skipCache: true })
		const folderTuple = tree.folders.find(folder => folder[0] === uuid1)!

		expect(folderTuple[2]).toBe(controls.rootUUID)

		const decrypted = await sdk.crypto().decrypt().folderMetadata({ metadata: folderTuple[1] })
		expect(decrypted.name).toBe("docs")
	})

	it("decrypt round-trips JSON metadata for files and folders", async () => {
		const { sdk, controls } = setup({ "/src/note.md": "content" })

		const dirUUID = await sdk.cloud().createDirectory({ name: "folder", parent: controls.rootUUID })
		const fileItem = await sdk.cloud().uploadLocalFile({ source: "/src/note.md", parent: dirUUID, name: "note.md" })
		const tree = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1", skipCache: true })

		const folderTuple = tree.folders.find(folder => folder[0] === dirUUID)!
		const fileTuple = tree.files.find(file => file[0] === fileItem.uuid)!

		expect((await sdk.crypto().decrypt().folderMetadata({ metadata: folderTuple[1] })).name).toBe("folder")

		const fileMeta = await sdk.crypto().decrypt().fileMetadata({ metadata: fileTuple[5] })
		expect(fileMeta.name).toBe("note.md")
		expect(fileMeta.mime).toBe("text/markdown")
	})
})

describe("fake cloud — case-insensitive uniqueness & versioning", () => {
	it("errors on a file/folder type clash in either direction", async () => {
		const { sdk, controls } = setup({ "/src/x": "data" })

		await sdk.cloud().createDirectory({ name: "X", parent: controls.rootUUID })

		await expect(sdk.cloud().uploadLocalFile({ source: "/src/x", parent: controls.rootUUID, name: "x" })).rejects.toThrow()

		const { vfs, sdk: sdk2, controls: controls2 } = setup({ "/src/y": "data" })
		await sdk2.cloud().uploadLocalFile({ source: "/src/y", parent: controls2.rootUUID, name: "y" })
		await expect(sdk2.cloud().createDirectory({ name: "Y", parent: controls2.rootUUID })).rejects.toThrow()
		void vfs
	})

	it("versions a file on same-name re-upload: a fresh uuid supersedes and the old leaves the tree", async () => {
		const { vfs, sdk, controls } = setup({ "/src/a.txt": "v1" })

		const first = await sdk.cloud().uploadLocalFile({ source: "/src/a.txt", parent: controls.rootUUID, name: "a.txt" })

		await vfs.fs.writeFile("/src/a.txt", "v2-longer", { encoding: "utf-8" })
		const second = await sdk.cloud().uploadLocalFile({ source: "/src/a.txt", parent: controls.rootUUID, name: "a.txt" })

		expect(second.uuid).not.toBe(first.uuid)

		const tree = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1", skipCache: true })
		const matching = tree.files.filter(file => file[4] === controls.rootUUID)
		expect(matching).toHaveLength(1)
		expect(matching[0]![0]).toBe(second.uuid)

		// The superseded uuid is gone from the sync perspective.
		expect((await sdk.api(3).dir().present({ uuid: first.uuid })).present).toBe(false)
		expect((await sdk.api(3).dir().present({ uuid: second.uuid })).present).toBe(true)
	})
})

describe("fake cloud — trash, delete, present", () => {
	it("reports trashed as present+trash:true and permanently deleted as not present", async () => {
		const { sdk, controls } = setup({ "/a.txt": "data" }, { "/cloudfile.txt": "x" })

		const node = controls.getByPath("/cloudfile.txt")!

		await sdk.cloud().trashFile({ uuid: node.uuid })
		expect(await sdk.api(3).dir().present({ uuid: node.uuid })).toEqual({ present: true, trash: true })

		// Trashed nodes drop out of the tree.
		const tree = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1", skipCache: true })
		expect(tree.files).toHaveLength(0)

		await sdk.cloud().deleteFile({ uuid: node.uuid })
		expect(await sdk.api(3).dir().present({ uuid: node.uuid })).toEqual({ present: false, trash: false })
		void controls
	})

	it("raises APIError(file_not_found / folder_not_found) on gone uuids", async () => {
		const { sdk } = setup()

		await expect(sdk.cloud().trashFile({ uuid: "missing" })).rejects.toBeInstanceOf(APIError)
		await expect(sdk.cloud().deleteFile({ uuid: "missing" })).rejects.toMatchObject({ code: "file_not_found" })
		await expect(sdk.cloud().deleteDirectory({ uuid: "missing" })).rejects.toMatchObject({ code: "folder_not_found" })
	})
})

describe("fake cloud — rename/move overwriteIfExists & fileExists", () => {
	it("trashes the occupant when overwriteIfExists is set, and throws otherwise", async () => {
		const { sdk, controls } = setup({}, { "/a.txt": "A", "/b.txt": "B" })

		const a = controls.getByPath("/a.txt")!
		const b = controls.getByPath("/b.txt")!

		await expect(
			sdk.cloud().renameFile({ uuid: b.uuid, metadata: { name: "b.txt", size: 1, mime: "x", key: "k", lastModified: 1 }, name: "a.txt" })
		).rejects.toThrow()

		await sdk.cloud().renameFile({
			uuid: b.uuid,
			metadata: { name: "b.txt", size: 1, mime: "x", key: "k", lastModified: 1 },
			name: "a.txt",
			overwriteIfExists: true
		})

		expect((await sdk.api(3).dir().present({ uuid: a.uuid })).trash).toBe(true)

		const tree = await sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1", skipCache: true })
		expect(tree.files).toHaveLength(1)
		expect(tree.files[0]![0]).toBe(b.uuid)
	})

	it("fileExists distinguishes files from directories", async () => {
		const { sdk, controls } = setup({}, { "/a.txt": "A", "/dir": null })

		const a = controls.getByPath("/a.txt")!

		expect(await sdk.cloud().fileExists({ name: "a.txt", parent: controls.rootUUID })).toEqual({ exists: true, uuid: a.uuid })
		expect(await sdk.cloud().fileExists({ name: "missing.txt", parent: controls.rootUUID })).toEqual({ exists: false })
		expect(await sdk.cloud().fileExists({ name: "dir", parent: controls.rootUUID })).toEqual({ exists: false })
	})
})

describe("fake cloud — locks, error injection", () => {
	it("grants an uncontended lock and rejects while held by another holder", async () => {
		const { sdk } = setup()

		await sdk.user().acquireResourceLock({ resource: "r", lockUUID: "holder-1" })
		await expect(sdk.user().acquireResourceLock({ resource: "r", lockUUID: "holder-2" })).rejects.toThrow()

		await sdk.user().releaseResourceLock({ resource: "r", lockUUID: "holder-1" })
		await expect(sdk.user().acquireResourceLock({ resource: "r", lockUUID: "holder-2" })).resolves.toBeUndefined()
	})

	it("simulates external contention via controls.contendLock", async () => {
		const { sdk, controls } = setup()

		controls.contendLock("r")
		await expect(sdk.user().acquireResourceLock({ resource: "r", lockUUID: "me" })).rejects.toThrow()

		controls.releaseLockContention("r")
		await expect(sdk.user().acquireResourceLock({ resource: "r", lockUUID: "me" })).resolves.toBeUndefined()
	})

	it("throws an injected error from the named method", async () => {
		const { sdk, controls } = setup()

		controls.setError("tree", new Error("boom"))
		await expect(sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1" })).rejects.toThrow("boom")

		controls.clearError("tree")
		await expect(sdk.api(3).dir().tree({ uuid: controls.rootUUID, deviceId: "device-1" })).resolves.toBeDefined()
	})
})

describe("fake cloud — snapshot & external mutators", () => {
	it("reflects external mutations in the normalized snapshot", async () => {
		const { controls } = setup({}, { "/keep.txt": "keep" })

		controls.addDir("/photos")
		controls.addFile("/photos/p.txt", "pixels", { mtimeMs: 1_700_000_000_000 })
		controls.movePath("/keep.txt", "/photos/kept.txt")

		const snapshot = controls.snapshot()

		expect(snapshot["/photos"]).toEqual({ type: "directory", size: 0, mtimeSec: 0, contentHash: "" })
		expect(snapshot["/photos/p.txt"]!.type).toBe("file")
		expect(snapshot["/photos/p.txt"]!.mtimeSec).toBe(1_700_000_000)
		expect(snapshot["/photos/kept.txt"]!.type).toBe("file")
		expect(snapshot["/keep.txt"]).toBeUndefined()
	})
})
