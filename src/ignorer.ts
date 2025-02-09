import ignore from "ignore"
import type Sync from "./lib/sync"
import pathModule from "path"
import fs from "fs-extra"
import writeFileAtomic from "write-file-atomic"
import { Semaphore } from "./semaphore"

export const IGNORER_VERSION = 1

export class Ignorer {
	private sync: Sync
	public instance = ignore()
	public name: string = "ignorer"
	public pattern: string[] = []
	private readonly mutex = new Semaphore(1)

	public constructor(sync: Sync, name: string = "ignorer") {
		this.sync = sync
		this.name = name
	}

	public async fetch(): Promise<string> {
		await this.mutex.acquire()

		try {
			const filePath = pathModule.join(this.sync.dbPath, this.name, `v${IGNORER_VERSION}`, this.sync.syncPair.uuid, "filenIgnore")
			const physicalFilePath = pathModule.join(this.sync.syncPair.localPath, ".filenignore")
			let content: string = ""
			const [exists, physicalExists] = await Promise.all([fs.exists(filePath), fs.exists(physicalFilePath)])

			if (exists) {
				const stats = await fs.stat(filePath)

				if (stats.size > 0) {
					content += await fs.readFile(filePath, {
						encoding: "utf-8"
					})
				}
			}

			if (physicalExists) {
				const stats = await fs.stat(physicalFilePath)

				if (stats.size > 0) {
					content += `${content.length > 0 ? "\n" : ""}${await fs.readFile(physicalFilePath, {
						encoding: "utf-8"
					})}`
				}
			}

			return content
		} finally {
			this.mutex.release()
		}
	}

	public async write(content: string): Promise<void> {
		await this.mutex.acquire()

		try {
			const filePath = pathModule.join(this.sync.syncPair.localPath, ".filenignore")

			await fs.ensureDir(pathModule.dirname(filePath))

			await writeFileAtomic(filePath, content, {
				encoding: "utf-8"
			})
		} finally {
			this.mutex.release()
		}
	}

	public async clearFile(): Promise<void> {
		await this.mutex.acquire()

		try {
			const filePath = pathModule.join(this.sync.dbPath, this.name, `v${IGNORER_VERSION}`, this.sync.syncPair.uuid, "filenIgnore")
			const physicalFilePath = pathModule.join(this.sync.syncPair.localPath, ".filenignore")
			const [exists, physicalExists] = await Promise.all([fs.exists(filePath), fs.exists(physicalFilePath)])

			if (exists) {
				await writeFileAtomic(filePath, "", {
					encoding: "utf-8"
				})
			}

			if (physicalExists) {
				await writeFileAtomic(physicalFilePath, "", {
					encoding: "utf-8"
				})
			}
		} finally {
			this.mutex.release()
		}
	}

	public async initialize(passedContent?: string): Promise<void> {
		this.sync.localFileSystem.ignoredCache.clear()
		this.sync.remoteFileSystem.ignoredCache.clear()

		let content: string[] = []

		if (typeof passedContent === "string") {
			await this.write(passedContent)

			content = passedContent
				.split("\n")
				.map(line => line.trim())
				.filter(line => line.length > 0)
		} else {
			content = (await this.fetch())
				.split("\n")
				.map(line => line.trim())
				.filter(line => line.length > 0)
		}

		this.pattern = content
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
