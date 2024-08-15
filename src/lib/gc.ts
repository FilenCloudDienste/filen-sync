import { setFlagsFromString } from "v8"
import { runInNewContext } from "vm"

let gcFn: (() => void) | undefined = undefined

export function createGCFn(): (() => void) | undefined {
	try {
		if (global && typeof global.gc === "function") {
			return global.gc
		}

		setFlagsFromString("--expose-gc")

		return runInNewContext("gc") as () => void
	} catch {
		// Noop
	}
}

export function runGC(): void {
	try {
		if (!gcFn) {
			gcFn = createGCFn()
		}

		if (gcFn) {
			gcFn()
		}
	} catch {
		// Noop
	}
}
