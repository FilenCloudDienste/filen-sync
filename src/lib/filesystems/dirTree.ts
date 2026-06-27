import { unpack } from "msgpackr"
import type FilenSDK from "@filen/sdk"

/**
 * The exact dir-tree response shape the SDK's public `api(3).dir().tree()` returns, derived from the
 * SDK's own types so this reimplementation can never drift from what `remote.ts` consumes (the tuple
 * element types — uuid/metadata/parent, file encryption version, etc. — come along for free).
 */
export type DirTreeResponse = Awaited<ReturnType<ReturnType<ReturnType<FilenSDK["api"]>["dir"]>["tree"]>>

/**
 * The minimal slice of a FilenSDK instance the fetcher needs: its already-configured axios instance
 * (reused so we inherit the consumer's proxy/agent/interceptor setup and add no new HTTP surface) and
 * its config for the API key. The real `FilenSDK` satisfies this structurally.
 */
export type DirTreeSDK = Pick<FilenSDK, "axiosInstance" | "config">

export type DirTreeRequest = {
	uuid: string
	deviceId: string
	skipCache: boolean
}

/**
 * The swappable remote tree-fetch seam (lives on {@link SyncEnvironment}). Production wires
 * {@link fetchDirTreeMsgpack}; tests inject a fetcher that delegates to the fake cloud's
 * `api(3).dir().tree()` so every scenario keeps exercising the real engine logic without HTTP.
 */
export type SyncDirTreeFetcher = (sdk: DirTreeSDK, request: DirTreeRequest) => Promise<DirTreeResponse>

/**
 * The same gateway pool the SDK uses, mirrored here so this one reimplemented call does not reach into
 * SDK internals. Requests rotate through these on failure for deterministic failover.
 */
export const DIR_TREE_GATEWAY_URLS: readonly string[] = [
	"https://gateway.filen.io",
	"https://gateway.filen.net",
	"https://gateway.filen-1.net",
	"https://gateway.filen-2.net",
	"https://gateway.filen-3.net",
	"https://gateway.filen-4.net",
	"https://gateway.filen-5.net",
	"https://gateway.filen-6.net"
]

/**
 * A definitive API-level error: the response envelope reported `status: false` (e.g. `folder_not_found`).
 * Thrown WITHOUT retry — retrying a definitive rejection is pointless and would only mask the real cause.
 */
export class DirTreeAPIError extends Error {
	public readonly code: string

	public constructor(code: string, message: string) {
		super(message)

		this.name = "DirTreeAPIError"
		this.code = code
	}
}

export type FetchDirTreeOptions = {
	maxTries?: number
	baseRetryDelayMs?: number
	maxRetryDelayMs?: number
	timeoutMs?: number
	gatewayURLs?: readonly string[]
	abortSignal?: AbortSignal
	/** Injectable for deterministic tests; defaults to `Math.random`. */
	random?: () => number
	/** Injectable for deterministic tests; defaults to a real timer. */
	sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Identity transform: keep axios's hands off the binary response body (no copy, no parse attempt).
const passthroughResponse = (data: unknown): unknown => data

/**
 * Reimplements the single `/v3/dir/tree` API call the sync engine depends on, requesting a **msgpack**
 * response (decoded with msgpackr) instead of JSON — far cheaper to transfer and parse for very large
 * trees. The request BODY stays JSON; only the server's response is msgpack.
 *
 * Memory: this is the hottest allocation in a sync cycle (the entire remote tree lands here), so the
 * path is kept lean. msgpack decodes raw bytes straight to objects — unlike JSON, which must first
 * materialise the whole response as one giant UTF-8 string before parsing (peak = bytes + string +
 * objects vs bytes + objects). The arraybuffer Buffer is reused without copying ({@link toBuffer}), the
 * decoded `files`/`folders` arrays are returned by reference (never cloned), and axios response
 * transforms are disabled so it never tries to stringify/parse the binary body. Peak memory is then
 * just the response bytes plus the decoded tree — irreducible for a tree of that size.
 *
 * Behaviour mirrors the SDK's call 1:1 — identical body, identical `{ status, code, message, data }`
 * envelope, and the same deviceId-cache contract the engine relies on (an unchanged tree comes back
 * with empty `files`/`folders`, which `remote.ts` reads as "reuse my cache"). Transport is sturdier
 * than the SDK's: it rotates through every gateway on failure (the SDK picks a random one each try and
 * can hit the same dead host twice) and backs off with full-jitter exponential delay instead of a flat
 * interval. Definitive API errors and aborts short-circuit without retrying.
 */
export async function fetchDirTreeMsgpack(
	sdk: DirTreeSDK,
	request: DirTreeRequest,
	options: FetchDirTreeOptions = {}
): Promise<DirTreeResponse> {
	const gateways = options.gatewayURLs && options.gatewayURLs.length > 0 ? options.gatewayURLs : DIR_TREE_GATEWAY_URLS
	const maxTries = options.maxTries ?? 32
	const baseDelay = options.baseRetryDelayMs ?? 1000
	const maxDelay = options.maxRetryDelayMs ?? 15000
	const timeout = options.timeoutMs ?? 300000
	const random = options.random ?? Math.random
	const sleep = options.sleep ?? defaultSleep
	const apiKey = sdk.config.apiKey && sdk.config.apiKey.length > 0 ? sdk.config.apiKey : "anonymous"

	// Body is JSON and identical to the SDK's (skipCache encoded as 1/0).
	const body = {
		uuid: request.uuid,
		deviceId: request.deviceId,
		skipCache: request.skipCache ? 1 : 0
	}

	// Spread the initial gateway choice across the pool so many clients do not all hammer gateway[0].
	const startIndex = Math.floor(random() * gateways.length)
	let lastError: unknown

	for (let attempt = 0; attempt < maxTries; attempt++) {
		if (options.abortSignal?.aborted) {
			throw new Error("Aborted")
		}

		const url = gateways[(startIndex + attempt) % gateways.length]!

		try {
			const response = await sdk.axiosInstance.post(`${url}/v3/dir/tree`, body, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/msgpack",
					"Content-Type": "application/json",
					"User-Agent": "filen-sync",
					msgpack: "1"
				},
				responseType: "arraybuffer",
				// Hand back the raw binary untouched — skip axios's default transform (which would try to
				// stringify/JSON-parse) so the large response is never copied or materialised as a string.
				transformResponse: passthroughResponse,
				timeout,
				maxRedirects: 0,
				maxBodyLength: Infinity,
				maxContentLength: Infinity,
				// Only set when present: axios's `signal` is non-optional under exactOptionalPropertyTypes.
				...(options.abortSignal ? { signal: options.abortSignal } : {})
			})

			if (!response || response.status !== 200) {
				throw new Error(`Invalid HTTP status code: ${response ? response.status : "no response"}`)
			}

			const decoded = unpack(toBuffer(response.data))

			// Envelope error (e.g. folder_not_found): definitive — surface it, do not retry.
			if (isFailedEnvelope(decoded)) {
				throw new DirTreeAPIError(decoded.code ?? "unknown", decoded.message ?? "Request failed.")
			}

			const data = unwrapEnvelope(decoded)

			return {
				files: Array.isArray(data.files) ? data.files : [],
				folders: Array.isArray(data.folders) ? data.folders : [],
				raw: ""
			} as DirTreeResponse
		} catch (e) {
			// Definitive API errors and aborts are not retried.
			if (e instanceof DirTreeAPIError || options.abortSignal?.aborted) {
				throw e
			}

			lastError = e

			if (attempt === maxTries - 1) {
				break
			}

			// Full jitter: a random point in [0, exponential cap] spreads retries and avoids thundering herds.
			const expDelay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt))

			await sleep(Math.floor(random() * expDelay))
		}
	}

	throw lastError instanceof Error ? lastError : new Error("Failed to fetch directory tree after all retries.")
}

/**
 * Normalises whatever axios hands back for an arraybuffer response (Buffer, ArrayBuffer, or a typed-array
 * view) into a Buffer msgpackr can decode.
 */
function toBuffer(payload: unknown): Buffer {
	if (Buffer.isBuffer(payload)) {
		return payload
	}

	if (payload instanceof ArrayBuffer) {
		return Buffer.from(payload)
	}

	if (ArrayBuffer.isView(payload)) {
		return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
	}

	throw new Error("Unexpected dir tree response payload type.")
}

function isFailedEnvelope(decoded: unknown): decoded is { status: false; code?: string; message?: string } {
	return (
		typeof decoded === "object" &&
		decoded !== null &&
		typeof (decoded as { status?: unknown }).status === "boolean" &&
		(decoded as { status: boolean }).status === false
	)
}

/**
 * The API wraps results in `{ status, data }`; msgpack mirrors that. Unwrap `data` when present, else
 * treat the decoded object as the bare `{ files, folders }` result.
 */
function unwrapEnvelope(decoded: unknown): { files?: unknown; folders?: unknown } {
	if (typeof decoded === "object" && decoded !== null) {
		const envelope = decoded as { data?: unknown; files?: unknown; folders?: unknown }

		if (typeof envelope.data === "object" && envelope.data !== null) {
			return envelope.data as { files?: unknown; folders?: unknown }
		}

		return envelope
	}

	return {}
}
