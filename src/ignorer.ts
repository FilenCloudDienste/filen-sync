import ignore from "ignore"
import type Sync from "./lib/sync"
import pathModule from "path"
import { Semaphore } from "./semaphore"

export const IGNORER_VERSION = 1

export class Ignorer {
	private sync: Sync
	public instance = ignore()
	public name: string = "ignorer"
	private readonly mutex = new Semaphore(1)
	// The exact ignore-rule content the current `instance` + the filesystem ignoredCaches reflect. Used to
	// skip a needless cache wipe + matcher rebuild when a per-cycle re-init finds the rules unchanged.
	private lastAppliedContent: string | null = null

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
			const [exists, physicalExists] = await Promise.all([this.sync.environment.fs.exists(filePath), this.sync.environment.fs.exists(physicalFilePath)])

			if (exists) {
				const stats = await this.sync.environment.fs.stat(filePath)

				if (stats.size > 0) {
					content += await this.sync.environment.fs.readFile(filePath, {
						encoding: "utf-8"
					})
				}
			}

			if (physicalExists) {
				const stats = await this.sync.environment.fs.stat(physicalFilePath)

				if (stats.size > 0) {
					content += `${content.length > 0 ? "\n" : ""}${await this.sync.environment.fs.readFile(physicalFilePath, {
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

			await this.sync.environment.fs.ensureDir(pathModule.dirname(filePath))

			await this.sync.environment.writeFileAtomic(filePath, content, {
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
			const [exists, physicalExists] = await Promise.all([this.sync.environment.fs.exists(filePath), this.sync.environment.fs.exists(physicalFilePath)])

			if (exists) {
				await this.sync.environment.writeFileAtomic(filePath, "", {
					encoding: "utf-8"
				})
			}

			if (physicalExists) {
				await this.sync.environment.writeFileAtomic(physicalFilePath, "", {
					encoding: "utf-8"
				})
			}
		} finally {
			this.mutex.release()
		}
	}

	public async initialize(passedContent?: string): Promise<void> {
		if (typeof passedContent === "string") {
			// Explicit content update: persist it, then always (re)build from it.
			await this.write(passedContent)

			this.applyContent(passedContent)

			return
		}

		// Per-cycle re-init: the engine calls this EVERY cycle to pick up `.filenignore` edits. When the
		// rules are byte-for-byte unchanged, the per-path ignore decisions are still valid — skip wiping the
		// filesystem ignoredCaches. Clearing them forced every subsequent tree scan to recompute the
		// expensive per-file ignore checks (micromatch + the gitignore matcher) for the WHOLE tree on every
		// cycle, which dominated the incremental-change scan (the cache existed but was defeated each cycle).
		// Only rebuild when the content actually changed. excludeDotFiles/mode changes invalidate the caches
		// through their own update paths (index.ts), so this never serves a stale decision.
		const rawContent = await this.fetch()

		if (this.lastAppliedContent !== null && rawContent === this.lastAppliedContent) {
			return
		}

		this.applyContent(rawContent)
	}

	/**
	 * Rebuild the matcher from `rawContent` and reset the filesystem ignoredCaches so the next scan
	 * re-evaluates against the new rules. Records the content as the baseline for the unchanged-skip above.
	 */
	private applyContent(rawContent: string): void {
		this.lastAppliedContent = rawContent

		this.sync.localFileSystem.ignoredCache.clear()
		this.sync.remoteFileSystem.ignoredCache.clear()

		const content = rawContent
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0)

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

		// Invalidate the change-tracking baseline so the next initialize() rebuilds rather than skipping
		// (otherwise a clear() followed by a same-content initialize() would leave the empty matcher in place).
		this.lastAppliedContent = null
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
