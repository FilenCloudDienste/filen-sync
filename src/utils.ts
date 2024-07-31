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

export const isValidPath = memoize((inputPath: string): boolean => {
	// eslint-disable-next-line no-control-regex
	const illegalCharsWindows = /[<>:"/\\|?*\x00-\x1F]/
	const reservedNamesWindows = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
	// eslint-disable-next-line no-control-regex, no-useless-escape
	const illegalCharsMacOS = /[\/:\x00]/
	// eslint-disable-next-line no-control-regex
	const illegalCharsLinux = /[\x00]/

	if (process.platform === "win32") {
		inputPath = inputPath.replace(/\\/g, "/")
	}

	if (inputPath.includes("..")) {
		return false
	}

	const parts = inputPath.split("/")

	switch (process.platform) {
		case "win32": {
			for (const part of parts) {
				const trimmed = part.trim()

				// Skip drive letter
				if (trimmed.length === 0 || (trimmed.length === 2 && part.endsWith(":") && inputPath.startsWith(part))) {
					continue
				}

				if (illegalCharsWindows.test(part)) {
					return false
				}

				if (reservedNamesWindows.test(part)) {
					return false
				}

				const nameParts = part.split(".")

				if (nameParts[0] && nameParts[0].length > 0 && reservedNamesWindows.test(nameParts[0])) {
					return false
				}
			}

			return true
		}

		case "darwin": {
			for (const part of parts) {
				if (part.trim().length === 0) {
					continue
				}

				if (illegalCharsMacOS.test(part)) {
					return false
				}
			}

			return true
		}

		case "linux": {
			for (const part of parts) {
				if (part.trim().length === 0) {
					continue
				}

				if (illegalCharsLinux.test(part)) {
					return false
				}
			}

			return true
		}

		default: {
			return false
		}
	}
})

export const isNameIgnoredByDefault = memoize((name: string): boolean => {
	const nameLowercase = name.toLowerCase().trim()
	const extension = pathModule.extname(nameLowercase)
	const extensionLowercase = extension.toLowerCase()

	if (
		nameLowercase.length === 0 ||
		nameLowercase.startsWith(".~lock.") ||
		nameLowercase.startsWith(".~lock") ||
		nameLowercase.startsWith("~$") ||
		(extensionLowercase && extensionLowercase.length > 0 && DEFAULT_IGNORED.extensions.includes(extensionLowercase)) ||
		DEFAULT_IGNORED.names.includes(nameLowercase)
	) {
		return true
	}

	return false
})

export const isRelativePathIgnoredByDefault = memoize((path: string): boolean => {
	return path.split("/").some(part => part.length > 0 && isNameIgnoredByDefault(part))
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
		to = `/${to}`
	}

	return `${to}${path.slice(from.length)}`
}

/**
 * Check if a path includes a dot file.
 *
 * @export
 * @param {string} path
 * @returns {boolean}
 */
export const pathIncludesDotFile = memoize((path: string): boolean => {
	return path.split("/").some(part => part.length > 0 && part.trimStart().startsWith("."))
})
