import FilenSDK from "@filen/sdk"
import os from "os"
import pathModule from "path"
import fs from "fs-extra"
import { v4 as uuidv4 } from "uuid"

/**
 * Real-account login for the e2e suite.
 *
 * Credentials come from the environment so they never touch the repo:
 *   FILEN_TEST_EMAIL, FILEN_TEST_PASSWORD   (a DEDICATED throwaway test account — the suite creates and
 *                                            permanently deletes data under it and empties its trash)
 *   FILEN_TEST_2FA                          (optional TOTP code; normally unset — the test account has no 2FA)
 *
 * When the creds are absent the whole e2e suite is skipped (see {@link E2E_ENABLED}); it never fails a
 * build that simply has no secrets (local dev, fork PRs).
 */
export const E2E_ENABLED: boolean = Boolean(process.env["FILEN_TEST_EMAIL"] && process.env["FILEN_TEST_PASSWORD"])

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
		throw new Error("e2e credentials are not set (FILEN_TEST_EMAIL / FILEN_TEST_PASSWORD).")
	}

	if (!sdkPromise) {
		sdkPromise = (async (): Promise<FilenSDK> => {
			const email = process.env["FILEN_TEST_EMAIL"]
			const password = process.env["FILEN_TEST_PASSWORD"]
			const twoFactorCode = process.env["FILEN_TEST_2FA"]

			if (!email || !password) {
				throw new Error("e2e credentials are not set (FILEN_TEST_EMAIL / FILEN_TEST_PASSWORD).")
			}

			await fs.ensureDir(SDK_TMP_PATH)

			const sdk = new FilenSDK({
				metadataCache: true,
				connectToSocket: false,
				tmpPath: SDK_TMP_PATH
			})

			await sdk.login({
				email,
				password,
				// Only include the 2FA code when present (exactOptionalPropertyTypes forbids passing undefined).
				...(twoFactorCode && twoFactorCode.length > 0 ? { twoFactorCode } : {})
			})

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
