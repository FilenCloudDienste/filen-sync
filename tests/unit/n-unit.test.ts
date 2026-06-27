import { describe, it, expect } from "vitest"
import {
	isValidPath,
	isPathOverMaxLength,
	isNameOverMaxLength,
	convertTimestampToMs,
	normalizeUTime,
	normalizeLastModifiedMsForComparison,
	pathIncludesDotFile,
	isNameIgnoredByDefault,
	isRelativePathIgnoredByDefault,
	isAbsolutePathIgnoredByDefault,
	serializeError,
	deserializeError,
	fastHash,
	tryingToSyncDesktop,
	replacePathStartWithFromAndTo
} from "../../src/utils"
import { Semaphore } from "../../src/semaphore"
import { Logger } from "../../src/lib/logger"

/**
 * Category N — unit tests (behavioral spec §N).
 *
 * Pure-function and small-class coverage that complements the scenario suite: platform-specific
 * path/length validation (via stubbed `process.platform`), time normalization, default-ignore
 * helpers, error (de)serialization, hashing, the desktop guard, the Semaphore primitive and the
 * disabled-Logger path. Every expectation here was verified against the real implementation.
 */

/**
 * Run `fn` with `process.platform` temporarily stubbed. `process.platform` is a non-writable but
 * configurable property, so it must be replaced via `defineProperty` and restored from its original
 * descriptor.
 */
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform")

	Object.defineProperty(process, "platform", { value: platform, configurable: true })

	try {
		fn()
	} finally {
		if (original) {
			Object.defineProperty(process, "platform", original)
		}
	}
}

/**
 * Run `fn` with a `process.env` key temporarily overridden, restoring (or deleting) it afterwards.
 */
function withEnv(key: string, value: string, fn: () => void): void {
	const original = process.env[key]

	process.env[key] = value

	try {
		fn()
	} finally {
		if (original === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = original
		}
	}
}

/**
 * Resolve on the next macrotask tick so all pending promise microtasks have drained — used to assert
 * that a Semaphore waiter has NOT resolved.
 */
function tick(): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, 0))
}

describe("Category N — utils.isValidPath (win32)", () => {
	it("accepts an ordinary drive-rooted path", () => {
		withPlatform("win32", () => {
			expect(isValidPath("C:/Users/me/Documents/report.txt")).toBe(true)
		})
	})

	it("normalizes backslashes before validating", () => {
		withPlatform("win32", () => {
			expect(isValidPath("C:\\Users\\me\\file.txt")).toBe(true)
		})
	})

	it("rejects each Windows illegal char in a component", () => {
		withPlatform("win32", () => {
			for (const bad of ["<", ">", "\"", "|", "?", "*"]) {
				expect(isValidPath(`C:/folder/in${bad}valid.txt`)).toBe(false)
			}
		})
	})

	it("rejects a colon outside the drive-letter position", () => {
		withPlatform("win32", () => {
			expect(isValidPath("C:/a:b/c")).toBe(false)
		})
	})

	it("rejects reserved device names case-insensitively", () => {
		withPlatform("win32", () => {
			for (const name of ["con", "CON", "Prn", "aux", "NUL", "com1", "LPT9"]) {
				expect(isValidPath(`C:/folder/${name}`)).toBe(false)
			}
		})
	})

	it("rejects a reserved name even when it carries an extension", () => {
		withPlatform("win32", () => {
			expect(isValidPath("C:/folder/con.txt")).toBe(false)
			expect(isValidPath("C:/folder/com1.log")).toBe(false)
		})
	})
})

describe("Category N — utils.isValidPath (darwin)", () => {
	it("accepts an ordinary absolute path", () => {
		withPlatform("darwin", () => {
			expect(isValidPath("/Users/me/Documents/file.txt")).toBe(true)
		})
	})

	it("rejects a colon and a NUL byte", () => {
		withPlatform("darwin", () => {
			expect(isValidPath("/Users/me/foo:bar.txt")).toBe(false)
			expect(isValidPath("/Users/me/foo\x00bar")).toBe(false)
		})
	})

	it("permits chars that are illegal on Windows but legal on macOS", () => {
		withPlatform("darwin", () => {
			expect(isValidPath("/Users/me/a<b>c|d?e*.txt")).toBe(true)
		})
	})

	it("does not treat Windows reserved names as invalid", () => {
		withPlatform("darwin", () => {
			expect(isValidPath("/Users/me/con")).toBe(true)
		})
	})
})

describe("Category N — utils.isValidPath (linux)", () => {
	it("accepts an ordinary absolute path", () => {
		withPlatform("linux", () => {
			expect(isValidPath("/home/me/Documents/file.txt")).toBe(true)
		})
	})

	it("permits a colon (only NUL is illegal on linux)", () => {
		withPlatform("linux", () => {
			expect(isValidPath("/home/me/foo:bar")).toBe(true)
			expect(isValidPath("/home/me/a<b>:c")).toBe(true)
		})
	})

	it("rejects a NUL byte", () => {
		withPlatform("linux", () => {
			expect(isValidPath("/home/me/foo\x00bar")).toBe(false)
		})
	})
})

describe("Category N — utils.isValidPath (unknown platform)", () => {
	it("rejects everything on an unrecognized platform (default branch)", () => {
		withPlatform("freebsd", () => {
			expect(isValidPath("/perfectly/valid/path.txt")).toBe(false)
		})
	})
})

describe("Category N — utils.isPathOverMaxLength / isNameOverMaxLength", () => {
	it("uses a 4096 path limit on linux (length + 1 > limit)", () => {
		withPlatform("linux", () => {
			expect(isPathOverMaxLength("a".repeat(4095))).toBe(false)
			expect(isPathOverMaxLength("a".repeat(4096))).toBe(true)
		})
	})

	it("uses a 1024 path limit on darwin", () => {
		withPlatform("darwin", () => {
			expect(isPathOverMaxLength("a".repeat(1023))).toBe(false)
			expect(isPathOverMaxLength("a".repeat(1024))).toBe(true)
		})
	})

	it("uses a 512 path limit on win32", () => {
		withPlatform("win32", () => {
			expect(isPathOverMaxLength("a".repeat(511))).toBe(false)
			expect(isPathOverMaxLength("a".repeat(512))).toBe(true)
		})
	})

	it("falls back to a 512 path limit on an unknown platform", () => {
		withPlatform("freebsd", () => {
			expect(isPathOverMaxLength("a".repeat(511))).toBe(false)
			expect(isPathOverMaxLength("a".repeat(512))).toBe(true)
		})
	})

	it("uses a 255 name limit on every platform", () => {
		for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
			withPlatform(platform, () => {
				expect(isNameOverMaxLength("a".repeat(254))).toBe(false)
				expect(isNameOverMaxLength("a".repeat(255))).toBe(true)
			})
		}
	})
})

describe("Category N — utils.convertTimestampToMs", () => {
	it("passes a value already in milliseconds through unchanged", () => {
		const nowMs = Date.now()

		expect(convertTimestampToMs(nowMs)).toBe(nowMs)
		// Fixed golden well above the seconds/ms crossover.
		expect(convertTimestampToMs(1_700_000_000_000)).toBe(1_700_000_000_000)
	})

	it("multiplies a value expressed in seconds by 1000", () => {
		const nowSec = Math.floor(Date.now() / 1000)

		expect(convertTimestampToMs(nowSec)).toBe(nowSec * 1000)
		// Fixed golden well below the crossover (year 2001 in seconds).
		expect(convertTimestampToMs(1_000_000_000)).toBe(1_000_000_000_000)
	})
})

describe("Category N — utils.normalizeUTime", () => {
	it("returns integers unchanged", () => {
		expect(normalizeUTime(1234)).toBe(1234)
		expect(normalizeUTime(0)).toBe(0)
	})

	it("floors non-integers (towards negative infinity, not truncation)", () => {
		expect(normalizeUTime(1234.99)).toBe(1234)
		expect(normalizeUTime(-3.2)).toBe(-4)
	})
})

describe("Category N — utils.normalizeLastModifiedMsForComparison", () => {
	it("floors milliseconds down to whole seconds", () => {
		expect(normalizeLastModifiedMsForComparison(1500)).toBe(1)
		expect(normalizeLastModifiedMsForComparison(1999)).toBe(1)
		expect(normalizeLastModifiedMsForComparison(2000)).toBe(2)
		expect(normalizeLastModifiedMsForComparison(0)).toBe(0)
	})

	it("collapses two times within the same second to the same value", () => {
		expect(normalizeLastModifiedMsForComparison(1000)).toBe(normalizeLastModifiedMsForComparison(1999))
	})
})

describe("Category N — utils.pathIncludesDotFile", () => {
	it("detects a dot-prefixed component at any depth", () => {
		expect(pathIncludesDotFile("/a/.b/c")).toBe(true)
		expect(pathIncludesDotFile("/a/b/.c/d")).toBe(true)
		expect(pathIncludesDotFile("/a/b/c/.last")).toBe(true)
		expect(pathIncludesDotFile(".hidden")).toBe(true)
	})

	it("returns false when no component is dot-prefixed", () => {
		expect(pathIncludesDotFile("/a/b/c")).toBe(false)
		// A dot inside a component (an extension) is not a dot file.
		expect(pathIncludesDotFile("/normal/path.txt")).toBe(false)
		expect(pathIncludesDotFile("")).toBe(false)
	})
})

describe("Category N — utils default-ignore helpers", () => {
	it("ignores OS-junk names case-insensitively", () => {
		expect(isNameIgnoredByDefault(".DS_Store")).toBe(true)
		expect(isNameIgnoredByDefault(".ds_store")).toBe(true)
		expect(isNameIgnoredByDefault("thumbs.db")).toBe(true)
		expect(isNameIgnoredByDefault("desktop.ini")).toBe(true)
	})

	it("ignores names by lock/owner prefix and ignored extensions", () => {
		expect(isNameIgnoredByDefault(".~lock.document.odt#")).toBe(true)
		expect(isNameIgnoredByDefault("~$report.docx")).toBe(true)
		expect(isNameIgnoredByDefault("scratch.tmp")).toBe(true)
		// Extension match is case-insensitive.
		expect(isNameIgnoredByDefault("Scratch.TMP")).toBe(true)
	})

	it("ignores empty / whitespace-only names", () => {
		expect(isNameIgnoredByDefault("")).toBe(true)
		expect(isNameIgnoredByDefault("   ")).toBe(true)
	})

	it("does NOT ignore an ordinary name", () => {
		expect(isNameIgnoredByDefault("report.txt")).toBe(false)
		expect(isNameIgnoredByDefault("photo.jpg")).toBe(false)
	})

	it("ignores a relative path containing an ignored component or matching a glob", () => {
		expect(isRelativePathIgnoredByDefault("foo/.DS_Store")).toBe(true)
		expect(isRelativePathIgnoredByDefault("a/b/thumbs.db")).toBe(true)
		expect(isRelativePathIgnoredByDefault(".filen.trash.local/sub/file.txt")).toBe(true)
	})

	it("does NOT ignore an ordinary relative path", () => {
		expect(isRelativePathIgnoredByDefault("documents/work/report.txt")).toBe(false)
	})

	it("ignores absolute Windows system paths via globs", () => {
		expect(isAbsolutePathIgnoredByDefault("C:/Program Files/app/x.dll")).toBe(true)
		expect(isAbsolutePathIgnoredByDefault("D:/$RECYCLE.BIN/S-1-5/desktop.ini")).toBe(true)
	})

	it("does NOT ignore an ordinary absolute path", () => {
		expect(isAbsolutePathIgnoredByDefault("/home/user/documents/file.txt")).toBe(false)
		expect(isAbsolutePathIgnoredByDefault("C:/Users/me/file.txt")).toBe(false)
	})
})

describe("Category N — utils.serializeError / deserializeError", () => {
	it("captures exactly name, message, stack and stringified", () => {
		const error = new Error("something failed")
		const serialized = serializeError(error)

		expect(serialized.name).toBe("Error")
		expect(serialized.message).toBe("something failed")
		expect(serialized.stack).toBe(error.stack)
		expect(serialized.stringified).toBe("Error: something failed")
		expect(Object.keys(serialized).sort()).toEqual(["message", "name", "stack", "stringified"])
	})

	it("round-trips name, message and stack through deserializeError", () => {
		const error = new TypeError("bad type")
		const restored = deserializeError(serializeError(error))

		expect(restored).toBeInstanceOf(Error)
		expect(restored.name).toBe("TypeError")
		expect(restored.message).toBe("bad type")
		expect(restored.stack).toBe(error.stack)
	})

	it("does not carry a `code` property across the round-trip (display-oriented contract)", () => {
		const error = Object.assign(new Error("missing file"), { code: "ENOENT" })
		const serialized = serializeError(error)

		// `SerializedError` deliberately has no `code` field, so name/message survive but `code` does not.
		expect(serialized.name).toBe("Error")
		expect(serialized.message).toBe("missing file")
		expect("code" in serialized).toBe(false)

		const restored = deserializeError(serialized) as Error & { code?: string }

		expect(restored.message).toBe("missing file")
		expect(restored.code).toBeUndefined()
	})
})

describe("Category N — utils.fastHash", () => {
	it("is deterministic for identical input", () => {
		expect(fastHash("the quick brown fox")).toBe(fastHash("the quick brown fox"))
	})

	it("produces different digests for different input", () => {
		expect(fastHash("a")).not.toBe(fastHash("b"))
	})

	it("matches the well-known md5 digests", () => {
		expect(fastHash("hello")).toBe("5d41402abc4b2a76b9719d911017c592")
		expect(fastHash("")).toBe("d41d8cd98f00b204e9800998ecf8427e")
		expect(fastHash("input")).toMatch(/^[0-9a-f]{32}$/)
	})
})

describe("Category N — utils.tryingToSyncDesktop", () => {
	it("matches the user's Desktop path on darwin (case-insensitive, trailing slash tolerant)", () => {
		withPlatform("darwin", () => {
			withEnv("USER", "alice", () => {
				expect(tryingToSyncDesktop("/Users/alice/Desktop")).toBe(true)
				expect(tryingToSyncDesktop("/Users/alice/Desktop/")).toBe(true)
				expect(tryingToSyncDesktop("  /users/alice/desktop  ")).toBe(true)
			})
		})
	})

	it("does not match a non-Desktop path on darwin", () => {
		withPlatform("darwin", () => {
			withEnv("USER", "alice", () => {
				expect(tryingToSyncDesktop("/Users/alice/Documents")).toBe(false)
				expect(tryingToSyncDesktop("/Users/bob/Desktop")).toBe(false)
			})
		})
	})

	it("always returns false on non-darwin platforms", () => {
		withEnv("USER", "alice", () => {
			withPlatform("linux", () => {
				expect(tryingToSyncDesktop("/Users/alice/Desktop")).toBe(false)
			})
			withPlatform("win32", () => {
				expect(tryingToSyncDesktop("/Users/alice/Desktop")).toBe(false)
			})
		})
	})
})

describe("Category N — utils.replacePathStartWithFromAndTo (edge cases)", () => {
	it("maps the root onto the new root when from === path", () => {
		expect(replacePathStartWithFromAndTo("/foo/bar", "/foo/bar", "/baz/qux")).toBe("/baz/qux")
	})

	it("strips a trailing slash on the path before reparenting", () => {
		expect(replacePathStartWithFromAndTo("/foo/bar/", "/foo", "/baz")).toBe("/baz/bar")
	})

	it("strips trailing slashes on from and to", () => {
		expect(replacePathStartWithFromAndTo("/foo/bar", "/foo/", "/baz/")).toBe("/baz/bar")
	})

	it("normalizes missing leading slashes on all three inputs", () => {
		expect(replacePathStartWithFromAndTo("foo/bar", "foo", "baz")).toBe("/baz/bar")
	})

	it("supports reparenting onto a deeper destination", () => {
		expect(replacePathStartWithFromAndTo("/a/b/c", "/a", "/x/y/z")).toBe("/x/y/z/b/c")
	})
})

describe("Category N — Semaphore", () => {
	it("starts empty and reports its counter via count()", async () => {
		const sem = new Semaphore(1)

		expect(sem.count()).toBe(0)

		await sem.acquire()

		expect(sem.count()).toBe(1)
	})

	it("serializes acquisition with max = 1 until release", async () => {
		const sem = new Semaphore(1)

		await sem.acquire()

		let secondAcquired = false
		const second = sem.acquire().then(() => {
			secondAcquired = true
		})

		await tick()

		// The second acquire is blocked behind the first holder.
		expect(secondAcquired).toBe(false)
		expect(sem.count()).toBe(1)

		sem.release()
		await second

		expect(secondAcquired).toBe(true)
		expect(sem.count()).toBe(1)

		sem.release()

		expect(sem.count()).toBe(0)
	})

	it("ignores release() when nothing is held", () => {
		const sem = new Semaphore(1)

		expect(() => sem.release()).not.toThrow()
		expect(sem.count()).toBe(0)
	})

	it("setMax raises concurrency and unblocks a waiter", async () => {
		const sem = new Semaphore(1)

		await sem.acquire()

		let secondAcquired = false
		const second = sem.acquire().then(() => {
			secondAcquired = true
		})

		await tick()

		expect(secondAcquired).toBe(false)

		sem.setMax(2)
		await second

		expect(secondAcquired).toBe(true)
		expect(sem.count()).toBe(2)
	})

	it("purge() rejects all waiters, returns their count and resets the counter", async () => {
		const sem = new Semaphore(1)

		await sem.acquire()

		const first = sem.acquire()
		const second = sem.acquire()
		const firstRejection = expect(first).rejects.toBe("Task has been purged")
		const secondRejection = expect(second).rejects.toBe("Task has been purged")

		const purged = sem.purge()

		expect(purged).toBe(2)
		expect(sem.count()).toBe(0)

		await firstRejection
		await secondRejection
	})

	it("purge() with no waiters returns 0 but still resets the counter", async () => {
		const sem = new Semaphore(1)

		await sem.acquire()

		expect(sem.count()).toBe(1)
		expect(sem.purge()).toBe(0)
		expect(sem.count()).toBe(0)
	})
})

describe("Category N — Logger (disabled)", () => {
	it("constructs and init()s without creating a stream or throwing", async () => {
		const logger = new Logger(true)
		const internal = logger as unknown as { logger: unknown; dest: unknown }

		// The disabled branch short-circuits before touching the filesystem.
		expect(internal.logger).toBeNull()
		expect(internal.dest).toBeNull()

		await expect(logger.init()).resolves.toBeUndefined()

		expect(internal.logger).toBeNull()
		expect(internal.dest).toBeNull()
	})

	it("treats every log() call as a no-op that never throws", () => {
		const logger = new Logger(true)

		expect(() => {
			logger.log("info", "a string")
			logger.log("debug", { nested: { value: 1 } })
			logger.log("warn", 42, "where")
			logger.log("error", new Error("ignored"))
			logger.log("trace")
			logger.log("fatal", "boom")
		}).not.toThrow()
	})
})
