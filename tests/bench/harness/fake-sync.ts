import type Sync from "../../../src/lib/sync"
import Deltas from "../../../src/lib/deltas"
import { type SyncMode } from "../../../src/types"

/**
 * The minimal slice of `Sync` that `Deltas.process` actually reads: mode, removed, the cached upload
 * hashes, a `createFileHash` (only hit on a same-size-mtime-touch modify), the ignorer, and the
 * dot-file flag. Building this directly avoids constructing a whole memfs world + fake cloud + timers
 * for what is a pure in-memory CPU benchmark, so tree construction (the thing we are NOT measuring) is
 * the only setup cost.
 */
export function makeDeltaSync(
	mode: SyncMode,
	overrides?: { localFileHashes?: Record<string, string>; createFileHash?: () => Promise<string>; ignores?: (path: string) => boolean }
): Sync {
	return {
		mode,
		removed: false,
		excludeDotFiles: false,
		localFileHashes: overrides?.localFileHashes ?? {},
		localFileSystem: {
			createFileHash: overrides?.createFileHash ?? (async (): Promise<string> => "benchhash")
		},
		ignorer: {
			ignores: overrides?.ignores ?? ((): boolean => false)
		}
	} as unknown as Sync
}

export function makeDeltas(mode: SyncMode, overrides?: Parameters<typeof makeDeltaSync>[1]): Deltas {
	return new Deltas(makeDeltaSync(mode, overrides))
}
