import FilenSDK, { type FilenSDKConfig } from "@filen/sdk"
import os from "os"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"

/**
 * Real-account login for the e2e suite.
 *
 * Credentials come from the environment so they never touch the repo, in preference order:
 *   1. FILEN_SYNC_LEGACY_E2E_SDK_CONFIG — base64(JSON) of an already-authenticated SDK config. Reusing
 *      a saved session means we DON'T hit the rate-limited login endpoint on every run. Preferred.
 *   2. FILEN_SYNC_LEGACY_E2E_EMAIL + FILEN_SYNC_LEGACY_E2E_PASSWORD — a DEDICATED throwaway test account
 *      (no 2FA). Fallback for local runs without a saved config.
 *
 * Either way the suite creates and permanently deletes data under the account and empties its trash.
 * When NEITHER is present the whole e2e suite is skipped (see {@link E2E_ENABLED}); it never fails a
 * build that simply has no secrets (local dev, fork PRs).
 */
export const E2E_ENABLED: boolean = Boolean(
	process.env["FILEN_SYNC_LEGACY_E2E_SDK_CONFIG"] ||
		(process.env["FILEN_SYNC_LEGACY_E2E_EMAIL"] && process.env["FILEN_SYNC_LEGACY_E2E_PASSWORD"])
)

/**
 * A uniquely-named tmp dir the SDK uses for its own scratch (download chunks etc.). Random per process
 * so parallel CI runners never collide; removed by {@link teardownTestSDK}.
 */
export const SDK_TMP_PATH: string = pathModule.join(os.tmpdir(), `filen-sync-e2e-sdk-${uuidv4()}`)

let sdkPromise: Promise<FilenSDK> | null = null

/**
 * Log in once per worker and reuse the instance. `connectToSocket: false` — the suite drives discrete
 * cycles and never needs the realtime socket (which would also keep the process alive past teardown).
 */
export function loginTestSDK(): Promise<FilenSDK> {
	if (!E2E_ENABLED) {
		throw new Error("e2e credentials are not set (FILEN_SYNC_LEGACY_E2E_SDK_CONFIG, or _EMAIL / _PASSWORD).")
	}

	if (!sdkPromise) {
		sdkPromise = (async (): Promise<FilenSDK> => {
			await fs.ensureDir(SDK_TMP_PATH)

			// Preferred: reuse a saved, already-authenticated SDK config (base64 of its JSON) so we never
			// touch the rate-limited login endpoint. We override only tmpPath so each worker gets its own
			// scratch dir; everything else (apiKey, master keys, baseFolderUUID, …) comes from the config.
			const configBase64 = process.env["FILEN_SYNC_LEGACY_E2E_SDK_CONFIG"]

			if (configBase64 && configBase64.length > 0) {
				const config = JSON.parse(Buffer.from(configBase64, "base64").toString("utf-8")) as FilenSDKConfig

				return new FilenSDK({
					...config,
					tmpPath: SDK_TMP_PATH
				})
			}

			// Fallback: a real login with email + password.
			const email = process.env["FILEN_SYNC_LEGACY_E2E_EMAIL"]
			const password = process.env["FILEN_SYNC_LEGACY_E2E_PASSWORD"]

			if (!email || !password) {
				throw new Error("e2e credentials are not set (FILEN_SYNC_LEGACY_E2E_SDK_CONFIG, or _EMAIL / _PASSWORD).")
			}

			const sdk = new FilenSDK({
				metadataCache: true,
				connectToSocket: false,
				tmpPath: SDK_TMP_PATH
			})

			await sdk.login({ email, password })

			return sdk
		})()
	}

	return sdkPromise
}

/**
 * Best-effort logout + scratch cleanup for the end of a run. Safe to call when login never happened.
 */
export async function teardownTestSDK(): Promise<void> {
	if (sdkPromise) {
		try {
			const sdk = await sdkPromise

			sdk.logout()
		} catch {
			// already gone / never logged in
		}

		sdkPromise = null
	}

	try {
		await fs.rm(SDK_TMP_PATH, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
	} catch {
		// best effort
	}
}
