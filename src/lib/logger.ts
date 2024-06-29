import pathModule from "path"
import fs from "fs-extra"
import { type RotatingFileStream, createStream } from "rotating-file-stream"
import { Semaphore } from "../semaphore"

export class Logger {
	private readonly path: string
	private readonly debugPath: string
	private readonly errorPath: string
	private readonly infoPath: string
	private readonly warnPath: string
	private readonly debugStream: RotatingFileStream
	private readonly infoStream: RotatingFileStream
	private readonly errorStream: RotatingFileStream
	private readonly warnStream: RotatingFileStream
	private readonly infoMutex = new Semaphore(1)
	private readonly debugMutex = new Semaphore(1)
	private readonly errorMutex = new Semaphore(1)
	private readonly warnMutex = new Semaphore(1)

	public constructor(dbPath: string) {
		this.path = pathModule.join(dbPath, "logs")
		this.debugPath = pathModule.join(this.path, "debug.log")
		this.errorPath = pathModule.join(this.path, "error.log")
		this.infoPath = pathModule.join(this.path, "info.log")
		this.warnPath = pathModule.join(this.path, "warn.log")

		fs.ensureFileSync(this.debugPath)
		fs.ensureFileSync(this.errorPath)
		fs.ensureFileSync(this.infoPath)
		fs.ensureFileSync(this.warnPath)

		this.debugStream = createStream(this.debugPath, {
			size: "10M",
			interval: "5m",
			compress: "gzip",
			maxFiles: 3,
			encoding: "utf-8"
		})

		this.infoStream = createStream(this.infoPath, {
			size: "10M",
			interval: "5m",
			compress: "gzip",
			maxFiles: 3,
			encoding: "utf-8"
		})

		this.warnStream = createStream(this.warnPath, {
			size: "10M",
			interval: "5m",
			compress: "gzip",
			maxFiles: 3,
			encoding: "utf-8"
		})

		this.errorStream = createStream(this.errorPath, {
			size: "10M",
			interval: "5m",
			compress: "gzip",
			maxFiles: 3,
			encoding: "utf-8"
		})
	}

	public log(level: "info" | "debug" | "warn" | "error", object: unknown, where?: string): void {
		// eslint-disable-next-line no-extra-semi
		;(async () => {
			const mutex =
				level === "info"
					? this.infoMutex
					: level === "debug"
					? this.debugMutex
					: level === "warn"
					? this.warnMutex
					: this.errorMutex

			await mutex.acquire()

			try {
				const stream =
					level === "info"
						? this.infoStream
						: level === "debug"
						? this.debugStream
						: level === "warn"
						? this.warnStream
						: this.errorStream

				if (
					!stream.writable ||
					stream.destroyed ||
					stream.errored ||
					stream.closed ||
					stream.writableEnded ||
					stream.writableFinished
				) {
					return
				}

				const log = `[${level}] [${new Date()}] ${where ? `[${where}] ` : ""}${JSON.stringify(object)}`

				await new Promise<void>(resolve => {
					stream.write(`${log}\n`, () => {
						resolve()
					})
				})
			} finally {
				mutex.release()
			}
		})()
	}
}

export default Logger
