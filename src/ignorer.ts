import ignore from "ignore"
import type Sync from "./lib/sync"
import pathModule from "path"
import fs from "fs-extra"

export const IGNORER_VERSION = 1

export class Ignorer {
	private readonly sync: Sync
	private instance = ignore()
	private readonly name: string = "localIgnorer"
	private readonly cache: Record<string, boolean> = {}

	public constructor(sync: Sync, name: string = "localIgnorer") {
		this.sync = sync
		this.name = name
	}

	public async initialize(passedContent?: string): Promise<void> {
		let content: string = ""
		const filePath = pathModule.join(this.sync.dbPath, this.name, `v${IGNORER_VERSION}`, this.sync.syncPair.uuid, "filenIgnore")

		await fs.ensureDir(pathModule.dirname(filePath))

		if (passedContent) {
			await fs.writeFile(filePath, passedContent, {
				encoding: "utf-8"
			})

			content = passedContent
		} else {
			const exists = await fs.exists(filePath)

			if (!exists) {
				return
			}

			const stats = await fs.stat(filePath)

			if (stats.size === 0) {
				return
			}

			const readContent = await fs.readFile(filePath, {
				encoding: "utf-8"
			})

			if (readContent.length === 0) {
				return
			}

			content = readContent
		}

		this.instance = ignore().add(content)
	}

	public async update(content?: string): Promise<void> {
		await this.initialize(content)
	}

	public clear(): void {
		this.instance = ignore()
	}

	public ignores(path: string): boolean {
		if (this.cache[path]) {
			return this.cache[path]!
		}

		const ig = this.instance.ignores(path.startsWith("\\") ? path.slice(1) : path.startsWith("/") ? path.slice(1) : path)

		this.cache[path] = ig

		return ig
	}
}

export default Ignorer
