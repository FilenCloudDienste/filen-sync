import memoize from "lodash/memoize"
import { DEFAULT_IGNORED } from "./constants"
import pathModule from "path"

/**
 * Chunk large Promise.all executions.
 * @date 2/14/2024 - 11:59:34 PM
 *
 * @export
 * @async
 * @template T
 * @param {Promise<T>[]} promises
 * @param {number} [chunkSize=10000]
 * @returns {Promise<T[]>}
 */
export async function promiseAllChunked<T>(promises: Promise<T>[], chunkSize = 100000): Promise<T[]> {
	const results: T[] = []

	for (let i = 0; i < promises.length; i += chunkSize) {
		const chunkResults = await Promise.all(promises.slice(i, i + chunkSize))

		results.push(...chunkResults)
	}

	return results
}

/**
 * Chunk large Promise.allSettled executions.
 * @date 3/5/2024 - 12:41:08 PM
 *
 * @export
 * @async
 * @template T
 * @param {Promise<T>[]} promises
 * @param {number} [chunkSize=100000]
 * @returns {Promise<T[]>}
 */
export async function promiseAllSettledChunked<T>(promises: Promise<T>[], chunkSize = 100000): Promise<T[]> {
	const results: T[] = []

	for (let i = 0; i < promises.length; i += chunkSize) {
		const chunkPromisesSettled = await Promise.allSettled(promises.slice(i, i + chunkSize))
		const chunkResults = chunkPromisesSettled.reduce((acc: T[], current) => {
			if (current.status === "fulfilled") {
				acc.push(current.value)
			} else {
				// Handle rejected promises or do something with the error (current.reason)
			}

			return acc
		}, [])

		results.push(...chunkResults)
	}

	return results
}

/**
 * Convert a timestamp from seconds to milliseconds.
 *
 * @export
 * @param {number} timestamp
 * @returns {number}
 */
export function convertTimestampToMs(timestamp: number): number {
	const now = Date.now()

	if (Math.abs(now - timestamp) < Math.abs(now - timestamp * 1000)) {
		return timestamp
	}

	return Math.floor(timestamp * 1000)
}

export function isPathOverMaxLength(path: string): boolean {
	if (process.platform === "linux") {
		return path.length + 1 > 4096
	} else if (process.platform === "darwin") {
		return path.length + 1 > 1024
	} else if (process.platform === "win32") {
		return path.length + 1 > 260
	}

	return path.length + 1 > 260
}

export function isNameOverMaxLength(name: string): boolean {
	if (process.platform === "linux") {
		return name.length + 1 > 255
	} else if (process.platform === "darwin") {
		return name.length + 1 > 255
	} else if (process.platform === "win32") {
		return name.length + 1 > 255
	}

	return name.length + 1 > 255
}

export const isValidPath = memoize((path: string): boolean => {
	const illegalCharsWindows = /[<>:"/\\|?*]|^(?:aux|con|clock\$|nul|prn|com[1-9]|lpt[1-9])$/i
	const illegalCharsMacOS = /[:]/i
	const illegalCharsLinux = /[\0/]/i

	switch (process.platform) {
		case "win32": {
			return illegalCharsWindows.test(path)
		}

		case "darwin": {
			return illegalCharsMacOS.test(path)
		}

		case "linux": {
			return illegalCharsLinux.test(path)
		}

		default: {
			return false
		}
	}
})

export const isNameIgnoredByDefault = memoize((name: string): boolean => {
	const nameLowercase = name.toLowerCase()
	const extension = pathModule.extname(name)
	const extensionLowercase = extension.toLowerCase()

	if (
		name.length === 0 ||
		name.startsWith(" ") ||
		name.endsWith(" ") ||
		name.includes("\n") ||
		name.includes("\r") ||
		nameLowercase.startsWith(".~lock.") ||
		nameLowercase.startsWith(".~lock") ||
		nameLowercase.startsWith("~$") ||
		DEFAULT_IGNORED.extensions.includes(extensionLowercase) ||
		DEFAULT_IGNORED.names.includes(nameLowercase)
	) {
		return true
	}

	return false
})

export const isRelativePathIgnoredByDefault = memoize((path: string): boolean => {
	if (isNameIgnoredByDefault(pathModule.basename(path))) {
		return true
	}

	const ex = path.split("/")

	for (const part of ex) {
		if (part.length === 0) {
			continue
		}

		if (isNameIgnoredByDefault(part)) {
			return true
		}
	}

	return false
})

export const isSystemPathIgnoredByDefault = memoize((path: string): boolean => {
	for (const systemPath of DEFAULT_IGNORED.system) {
		if (path.toLowerCase().includes(systemPath.toLowerCase())) {
			return true
		}
	}

	return false
})

export const isDirectoryPathIgnoredByDefault = memoize((path: string): boolean => {
	for (const directoryPath of DEFAULT_IGNORED.directories) {
		if (path.toLowerCase().includes(directoryPath.toLowerCase())) {
			return true
		}
	}

	return false
})

export type SerializedError = {
	name: string
	message: string
	stack?: string
	stringified: string
}

export function serializeError(error: Error): SerializedError {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
		stringified: `${error.name}: ${error.message}`
	}
}

export function deserializeError(serializedError: SerializedError): Error {
	const error = new Error(serializedError.message)

	error.name = serializedError.name
	error.stack = serializedError.stack

	return error
}

/**
 * Replace a path with it's new parent path.
 *
 * @export
 * @param {string} path
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function replacePathStartWithFromAndTo(path: string, from: string, to: string): string {
	if (path.endsWith("/")) {
		path = path.slice(0, path.length - 1)
	}

	if (from.endsWith("/")) {
		from = from.slice(0, from.length - 1)
	}

	if (to.endsWith("/")) {
		to = to.slice(0, to.length - 1)
	}

	if (!path.startsWith("/")) {
		path = `/${path}`
	}

	if (!from.startsWith("/")) {
		from = `/${from}`
	}

	if (!to.startsWith("/")) {
		from = `/${to}`
	}

	return `${to}${path.slice(from.length)}`
}
