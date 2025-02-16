import { DEFAULT_IGNORED } from "./constants"
import pathModule from "path"
import crypto from "crypto"
import { exec } from "child_process"
import micromatch from "micromatch"

/**
 * Chunk large Promise.all executions.
 *
 * @export
 * @async
 * @template T
 * @param {Promise<T>[]} promises
 * @param {number} [chunkSize=10000]
 * @param {boolean} [withResults=true]
 * @returns {Promise<T[]>}
 */
export async function promiseAllChunked<T>(promises: Promise<T>[], chunkSize: number = 10000, withResults: boolean = true): Promise<T[]> {
	const results: T[] = []

	for (let i = 0; i < promises.length; i += chunkSize) {
		if (withResults) {
			const chunkResults = await Promise.all(promises.slice(i, i + chunkSize))

			results.push(...chunkResults)
		} else {
			await Promise.all(promises.slice(i, i + chunkSize))
		}
	}

	return results
}

/**
 * Chunk large Promise.allSettled executions.
 *
 * @export
 * @async
 * @template T
 * @param {Promise<T>[]} promises
 * @param {number} [chunkSize=10000]
 * @param {boolean} [withResults=true]
 * @returns {Promise<T[]>}
 */
export async function promiseAllSettledChunked<T>(
	promises: Promise<T>[],
	chunkSize: number = 10000,
	withResults: boolean = true
): Promise<T[]> {
	const results: T[] = []

	for (let i = 0; i < promises.length; i += chunkSize) {
		if (withResults) {
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
		} else {
			await Promise.allSettled(promises.slice(i, i + chunkSize))
		}
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
		return path.length + 1 > 512
	}

	return path.length + 1 > 512
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

// eslint-disable-next-line no-control-regex
export const illegalCharsWindows = /[<>:"/\\|?*\x00-\x1F]/
export const reservedNamesWindows = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
// eslint-disable-next-line no-control-regex, no-useless-escape
export const illegalCharsMacOS = /[\/:\x00]/
// eslint-disable-next-line no-control-regex
export const illegalCharsLinux = /[\x00]/

export function isValidPath(inputPath: string): boolean {
	if (process.platform === "win32") {
		inputPath = inputPath.replace(/\\/g, "/")
	}

	/*if (
		(process.platform === "win32" && inputPath.includes("\\..")) ||
		((process.platform === "linux" || process.platform === "darwin") && inputPath.includes("/.."))
	) {
		return false
	}*/

	const parts = inputPath.split("/")

	switch (process.platform) {
		case "win32": {
			for (const part of parts) {
				// Skip drive letter and empty parts
				if (part.trim().length === 0 || (part.length === 2 && part.endsWith(":") && inputPath.startsWith(part))) {
					continue
				}

				if (illegalCharsWindows.test(part)) {
					return false
				}

				if (reservedNamesWindows.test(part)) {
					return false
				}

				const parsedName = part.includes(".") ? pathModule.parse(part).name : part

				if (parsedName.length > 0 && reservedNamesWindows.test(parsedName)) {
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
}

export function isNameIgnoredByDefault(name: string): boolean {
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
}

export function isRelativePathIgnoredByDefault(path: string): boolean {
	return (
		path.split("/").some(part => part.length > 0 && isNameIgnoredByDefault(part)) ||
		micromatch.isMatch(path, DEFAULT_IGNORED.relativeGlobs)
	)
}

export function isAbsolutePathIgnoredByDefault(path: string): boolean {
	return micromatch.isMatch(path, DEFAULT_IGNORED.absoluteGlobs)
}

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
export function pathIncludesDotFile(path: string): boolean {
	return path.split("/").some(part => part.length > 0 && part.trimStart().startsWith("."))
}

export function normalizeUTime(time: number): number {
	if (Number.isInteger(time)) {
		return time
	}

	return Math.floor(time)
}

/**
 * We need to normalize lastModified times (milliseconds) for delta comparison.
 * Some filesystems provide different floating point precisions, therefore sometimes borking the comparison.
 * We normalize it to a second.
 * Downside is that we _can_ miss modifications if they happen in the 1000ms window that we are rounding too.
 *
 * @export
 * @param {number} time
 * @returns {number}
 */
export function normalizeLastModifiedMsForComparison(time: number): number {
	return Math.floor(time / 1000)
}

export function fastHash(input: string): string {
	return crypto.createHash("md5").update(input).digest("hex")
}

export function tryingToSyncDesktop(path: string): boolean {
	if (process.platform !== "darwin") {
		return false
	}

	return (
		path.trim().toLowerCase() === `/users/${process.env.USER ?? "user"}/desktop` ||
		path.trim().toLowerCase() === `/users/${process.env.USER ?? "user"}/desktop/`
	)
}

export async function pathSyncedByICloud(path: string): Promise<boolean> {
	if (process.platform !== "darwin") {
		return false
	}

	return await new Promise<boolean>(resolve => {
		exec(`xattr "${path}"`, (err, stdout, stderr) => {
			if (err) {
				resolve(false)

				return
			}

			if (stderr) {
				resolve(false)

				return
			}

			resolve(
				stdout.toLowerCase().includes("com.apple.cloud") ||
					stdout.toLowerCase().includes("com.apple.icloud") ||
					stdout.toLowerCase().includes("com.apple.fileprovider") ||
					stdout.toLowerCase().includes("com.apple.file-provider") ||
					stdout.toLowerCase().includes("com.apple.cloudDocs")
			)
		})
	})
}

export async function isPathSyncedByICloud(path: string): Promise<boolean> {
	if (process.platform !== "darwin") {
		return false
	}

	let currentPath = path

	while (currentPath !== "/" && currentPath !== "." && currentPath.length > 0) {
		if (await pathSyncedByICloud(currentPath)) {
			return true
		}

		currentPath = pathModule.dirname(currentPath)
	}

	return false
}
