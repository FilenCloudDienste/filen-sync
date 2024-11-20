import ignore from "ignore"
import type Sync from "./lib/sync"
import pathModule from "path"
import fs from "fs-extra"
import writeFileAtomic from "write-file-atomic"

export const IGNORER_VERSION = 1

export class Ignorer {
	private sync: Sync
	public instance = ignore()
	public name: string = "ignorer"

	public constructor(sync: Sync, name: string = "ignorer") {
		this.sync = sync
		this.name = name
	}

	public async fetch(): Promise<string> {
		const filePath = pathModule.join(this.sync.dbPath, this.name, `v${IGNORER_VERSION}`, this.sync.syncPair.uuid, "filenIgnore")

		await fs.ensureDir(pathModule.dirname(filePath))

		const exists = await fs.exists(filePath)

		if (!exists) {
			return ""
		}

		const stats = await fs.stat(filePath)

		if (stats.size === 0) {
			return ""
		}

		const readContent = await fs.readFile(filePath, {
			encoding: "utf-8"
		})

		if (readContent.length === 0) {
			return ""
		}

		return readContent
	}

	public async initialize(passedContent?: string): Promise<void> {
		this.sync.localFileSystem.ignoredCache.clear()
		this.sync.remoteFileSystem.ignoredCache.clear()

		let content: string[] = []
		const filePath = pathModule.join(this.sync.dbPath, this.name, `v${IGNORER_VERSION}`, this.sync.syncPair.uuid, "filenIgnore")

		await fs.ensureDir(pathModule.dirname(filePath))

		if (typeof passedContent === "string") {
			await writeFileAtomic(filePath, passedContent, {
				encoding: "utf-8"
			})

			content = passedContent.split("\n").map(line => line.trim())
		} else {
			content = (await this.fetch()).split("\n").map(line => line.trim())
		}

		this.instance = ignore()

		if (content.length > 0) {
			this.instance.add(content)
		}
	}

	public async update(content?: string): Promise<void> {
		await this.initialize(content)
	}

	public clear(): void {
		this.instance = ignore()
	}

	public async clearFile(): Promise<void> {
		const filePath = pathModule.join(this.sync.dbPath, this.name, `v${IGNORER_VERSION}`, this.sync.syncPair.uuid, "filenIgnore")

		await fs.ensureDir(pathModule.dirname(filePath))

		await fs.rm(filePath, {
			force: true,
			maxRetries: 60 * 10,
			recursive: true,
			retryDelay: 100
		})
	}

	public ignores(path: string): boolean {
		const normalizedPath = path.startsWith("\\") ? path.slice(1) : path.startsWith("/") ? path.slice(1) : path

		if (normalizedPath.length === 0) {
			return false
		}

		const ig = this.instance.ignores(normalizedPath)

		return ig
	}
}

export default Ignorer
