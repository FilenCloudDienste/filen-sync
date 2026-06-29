/**
 * Orphaned-artifact cleanup for the live e2e account.
 *
 * Each e2e world creates a remote `/<runId>` directory and removes it in its `afterAll`. When a CI run is
 * CANCELLED (a newer commit supersedes it via the workflow's concurrency group) the `afterAll` never runs,
 * so that `/<runId>` is left behind. This script purges such orphans and empties the trash.
 *
 * It is AGE-BASED on purpose: the matrix runs three platform jobs against ONE shared account in parallel,
 * and a cross-ref manual run could overlap too, so deleting everything would clobber a run still in flight.
 * Instead it only removes items OLDER than the maximum possible run lifetime (well above the 90-minute job
 * timeout), which can only be leftovers from a finished/cancelled run — never an active one. Best-effort
 * throughout: cleanup is housekeeping and must never fail the build.
 *
 * Run as a dedicated CI job after the matrix, and locally via `npm run test:e2e:cleanup`.
 */
// MUST precede the account import: it reads the credentials from .env.e2e into process.env before
// account.ts computes E2E_ENABLED at load time (a no-op in CI, where the secrets are already set).
import "./harness/load-env"
import { loginTestSDK, teardownTestSDK, E2E_ENABLED } from "./harness/account"

// Older than this ⇒ no in-flight run can still own it (90-min job timeout + generous queue/slack).
const MAX_RUN_AGE_MS = 3 * 60 * 60 * 1000

async function main(): Promise<void> {
	if (!E2E_ENABLED) {
		console.log("[e2e cleanup] no credentials present — nothing to do")

		return
	}

	const sdk = await loginTestSDK()
	const baseFolderUUID = sdk.config.baseFolderUUID

	if (!baseFolderUUID || baseFolderUUID.length === 0) {
		console.log("[e2e cleanup] SDK has no baseFolderUUID — skipping")

		return
	}

	const cutoff = Date.now() - MAX_RUN_AGE_MS
	const items = await sdk.cloud().listDirectory({ uuid: baseFolderUUID })

	let removed = 0
	let kept = 0

	for (const item of items) {
		// `timestamp` is the server-side creation time (ms). Keep anything recent — it may belong to a run
		// still executing on a sibling matrix runner (the matrix shares this one account).
		if (item.timestamp > cutoff) {
			kept++

			continue
		}

		try {
			if (item.type === "directory") {
				await sdk.cloud().deleteDirectory({ uuid: item.uuid })
			} else {
				await sdk.cloud().deleteFile({ uuid: item.uuid })
			}

			removed++
		} catch (error) {
			console.warn(`[e2e cleanup] could not delete ${item.type} "${item.name}":`, error instanceof Error ? error.message : error)
		}
	}

	try {
		await sdk.cloud().emptyTrash()
	} catch (error) {
		console.warn("[e2e cleanup] emptyTrash failed:", error instanceof Error ? error.message : error)
	}

	console.log(`[e2e cleanup] removed ${removed} orphaned item(s) older than ${MAX_RUN_AGE_MS / 3_600_000}h; kept ${kept} recent`)

	await teardownTestSDK()
}

main().catch(error => {
	// Never fail CI on cleanup — it is best-effort housekeeping.
	console.error("[e2e cleanup] unexpected error:", error)
})
