import { describe, it, expect, vi } from "vitest"
import { pack } from "msgpackr"
import { fetchDirTreeMsgpack, DIR_TREE_GATEWAY_URLS, type DirTreeSDK } from "../../src/lib/filesystems/dirTree"

/**
 * Direct unit coverage for the production msgpack reimplementation of `/v3/dir/tree`. Every sync
 * scenario routes the fetch through the fake cloud's SDK, so this is the ONLY place the real transport
 * (JSON body, msgpack response decode, envelope handling, gateway failover, backoff, abort) is
 * exercised — Phase 3 then validates it end-to-end against the live API.
 */
function makeSDK(post: (...args: unknown[]) => unknown, apiKey: string | undefined = "test-key"): DirTreeSDK {
	return { axiosInstance: { post }, config: { apiKey } } as unknown as DirTreeSDK
}

// A 200 response carrying the standard { status, data } envelope, msgpack-encoded as the server sends it.
function ok(data: unknown): { status: number; data: Buffer } {
	return { status: 200, data: pack({ status: true, data }) }
}

// Deterministic transport: no real waits, fixed gateway start index (0), no jitter.
const deterministic = { sleep: async (): Promise<void> => {}, random: (): number => 0, baseRetryDelayMs: 0, maxRetryDelayMs: 0 }

const sampleTree = {
	files: [["fuuid", "bucket", "region", 1, "puuid", "fmeta", 2, 0]],
	folders: [["root", "rmeta", "base"]]
}

describe("fetchDirTreeMsgpack", () => {
	it("POSTs a JSON body and decodes the msgpack response into the same shape the SDK returns", async () => {
		const post = vi.fn().mockResolvedValue(ok(sampleTree))
		const sdk = makeSDK(post)

		const result = await fetchDirTreeMsgpack(sdk, { uuid: "parent-uuid", deviceId: "dev-1", skipCache: false }, deterministic)

		expect(result.files).toEqual(sampleTree.files)
		expect(result.folders).toEqual(sampleTree.folders)

		const [url, body, config] = post.mock.calls[0]!

		expect(url).toBe(`${DIR_TREE_GATEWAY_URLS[0]}/v3/dir/tree`)
		// Body stays JSON; skipCache encoded as 0/1 exactly like the SDK.
		expect(body).toEqual({ uuid: "parent-uuid", deviceId: "dev-1", skipCache: 0 })
		expect(config.responseType).toBe("arraybuffer")
		expect(config.headers.Authorization).toBe("Bearer test-key")
		expect(config.headers.Accept).toBe("application/msgpack")
		expect(config.headers["Content-Type"]).toBe("application/json")
		// The response transform must be a pure passthrough so the binary body is never copied/parsed.
		const raw = Buffer.from([1, 2, 3])
		expect(config.transformResponse(raw)).toBe(raw)
	})

	it("encodes skipCache:true as 1", async () => {
		const post = vi.fn().mockResolvedValue(ok(sampleTree))

		await fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: true }, deterministic)

		expect(post.mock.calls[0]![1]).toEqual({ uuid: "u", deviceId: "d", skipCache: 1 })
	})

	it("falls back to the anonymous API key when none is configured", async () => {
		const post = vi.fn().mockResolvedValue(ok(sampleTree))
		// Build the SDK with no apiKey at all (a default param can't model "explicitly absent").
		const sdk = { axiosInstance: { post }, config: {} } as unknown as DirTreeSDK

		await fetchDirTreeMsgpack(sdk, { uuid: "u", deviceId: "d", skipCache: false }, deterministic)

		expect(post.mock.calls[0]![2].headers.Authorization).toBe("Bearer anonymous")
	})

	it("preserves the deviceId-cache contract: an unchanged tree (empty arrays) passes straight through", async () => {
		// The server returns empty files/folders when nothing changed for this deviceId; the fetcher must
		// surface that verbatim so remote.ts can read it as "reuse my cache".
		const post = vi.fn().mockResolvedValue(ok({ files: [], folders: [] }))

		const result = await fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: false }, deterministic)

		expect(result.files).toEqual([])
		expect(result.folders).toEqual([])
	})

	it("accepts a bare (un-enveloped) decoded object", async () => {
		const post = vi.fn().mockResolvedValue({ status: 200, data: pack(sampleTree) })

		const result = await fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: false }, deterministic)

		expect(result.folders).toEqual(sampleTree.folders)
	})

	it("normalizes ArrayBuffer and Uint8Array response payloads", async () => {
		const packed = pack({ status: true, data: sampleTree })
		const asArrayBuffer = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength)

		const postAB = vi.fn().mockResolvedValue({ status: 200, data: asArrayBuffer })
		const resultAB = await fetchDirTreeMsgpack(makeSDK(postAB), { uuid: "u", deviceId: "d", skipCache: false }, deterministic)
		expect(resultAB.folders).toEqual(sampleTree.folders)

		const postU8 = vi.fn().mockResolvedValue({ status: 200, data: new Uint8Array(packed) })
		const resultU8 = await fetchDirTreeMsgpack(makeSDK(postU8), { uuid: "u", deviceId: "d", skipCache: false }, deterministic)
		expect(resultU8.folders).toEqual(sampleTree.folders)
	})

	it("throws a DirTreeAPIError WITHOUT retrying on a status:false envelope", async () => {
		const post = vi.fn().mockResolvedValue({ status: 200, data: pack({ status: false, code: "folder_not_found", message: "gone" }) })

		await expect(fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: false }, deterministic)).rejects.toMatchObject({
			name: "DirTreeAPIError",
			code: "folder_not_found"
		})
		// Definitive error => exactly one attempt.
		expect(post).toHaveBeenCalledTimes(1)
	})

	it("retries a transient failure on the NEXT gateway and succeeds", async () => {
		const post = vi
			.fn()
			.mockRejectedValueOnce(new Error("ECONNRESET"))
			.mockResolvedValueOnce(ok(sampleTree))

		const result = await fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: false }, deterministic)

		expect(result.folders).toEqual(sampleTree.folders)
		expect(post).toHaveBeenCalledTimes(2)
		// Gateway rotation: the retry must target a different host than the failed attempt.
		expect(post.mock.calls[0]![0]).toBe(`${DIR_TREE_GATEWAY_URLS[0]}/v3/dir/tree`)
		expect(post.mock.calls[1]![0]).toBe(`${DIR_TREE_GATEWAY_URLS[1]}/v3/dir/tree`)
	})

	it("treats a non-200 status as retryable", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce({ status: 503, data: null })
			.mockResolvedValueOnce(ok(sampleTree))

		const result = await fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: false }, deterministic)

		expect(result.folders).toEqual(sampleTree.folders)
		expect(post).toHaveBeenCalledTimes(2)
	})

	it("gives up after maxTries and throws the last error", async () => {
		const post = vi.fn().mockRejectedValue(new Error("network down"))

		await expect(
			fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: false }, { ...deterministic, maxTries: 3 })
		).rejects.toThrow("network down")
		expect(post).toHaveBeenCalledTimes(3)
	})

	it("aborts immediately without making a request when the signal is already aborted", async () => {
		const post = vi.fn().mockResolvedValue(ok(sampleTree))
		const controller = new AbortController()
		controller.abort()

		await expect(
			fetchDirTreeMsgpack(makeSDK(post), { uuid: "u", deviceId: "d", skipCache: false }, { ...deterministic, abortSignal: controller.signal })
		).rejects.toThrow("Aborted")
		expect(post).not.toHaveBeenCalled()
	})
})
