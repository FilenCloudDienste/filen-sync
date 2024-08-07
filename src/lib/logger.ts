import pathModule from "path"
import pino, { type Logger as PinoLogger } from "pino"
import os from "os"
import fs from "fs-extra"

export function filenLogsPath(): string {
	let configPath = ""

	switch (process.platform) {
		case "win32":
			configPath = pathModule.resolve(process.env.APPDATA!)

			break
		case "darwin":
			configPath = pathModule.resolve(pathModule.join(os.homedir(), "Library/Application Support/"))

			break
		default:
			configPath = process.env.XDG_CONFIG_HOME
				? pathModule.resolve(process.env.XDG_CONFIG_HOME)
				: pathModule.resolve(pathModule.join(os.homedir(), ".config/"))

			break
	}

	if (!configPath || configPath.length === 0) {
		throw new Error("Could not find homedir path.")
	}

	configPath = pathModule.join(configPath, "@filen", "logs")

	if (!fs.existsSync(configPath)) {
		fs.mkdirSync(configPath, {
			recursive: true
		})
	}

	return configPath
}

export class Logger {
	private logger: PinoLogger
	private readonly dest: string
	private isCleaning: boolean = false
	private readonly maxSize = 1024 * 1024 * 10
	private readonly disableLogging: boolean

	public constructor(disableLogging: boolean = false) {
		this.dest = pathModule.join(filenLogsPath(), "sync.log")
		this.disableLogging = disableLogging

		if (fs.existsSync(this.dest)) {
			const stats = fs.statSync(this.dest)

			if (stats.size >= this.maxSize) {
				fs.rmSync(this.dest)
			}
		}

		this.logger = pino(
			pino.destination({
				sync: false,
				fsync: false,
				dest: this.dest
			})
		)

		this.clean()
	}

	public log(level: "info" | "debug" | "warn" | "error" | "trace" | "fatal", object?: unknown, where?: string): void {
		if (this.isCleaning || this.disableLogging) {
			return
		}

		const log = `[${level}] [${new Date()}] ${where ? `[${where}] ` : ""}${
			typeof object !== "undefined"
				? typeof object === "string" || typeof object === "number"
					? object
					: JSON.stringify(object)
				: ""
		}`

		if (level === "info") {
			this.logger.info(log)
		} else if (level === "debug") {
			this.logger.debug(log)
		} else if (level === "error") {
			this.logger.error(log)
		} else if (level === "warn") {
			this.logger.warn(log)
		} else if (level === "trace") {
			this.logger.trace(log)
		} else if (level === "fatal") {
			this.logger.fatal(log)
		} else {
			this.logger.info(log)
		}
	}

	public clean(): void {
		if (this.disableLogging) {
			return
		}

		setInterval(async () => {
			if (this.isCleaning) {
				return
			}

			this.isCleaning = true

			try {
				if ((await fs.exists(this.dest)) && (await fs.stat(this.dest)).size > this.maxSize) {
					await fs.unlink(this.dest)

					this.logger = pino(
						pino.destination({
							sync: false,
							fsync: false,
							dest: this.dest
						})
					)
				}
			} finally {
				this.isCleaning = false
			}
		}, 3600000)
	}
}

export default Logger
