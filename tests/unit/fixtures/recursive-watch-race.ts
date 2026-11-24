// Run in its own process by watcher-recursive-race.test.ts: an uncaught error ends this process, which the test
// reads from the exit code (vitest's own uncaughtException listener would report it in-process either way).
import fs from "fs"
import os from "os"
import pathModule from "path"
import { defaultEnvironment } from "../../../src/lib/environment"
import { LOCAL_TRASH_NAME } from "../../../src/constants"

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// The watcher sees the directory first, then it is replaced by a file of the same name in one synchronous step,
// so the directory's own late event finds a file where it looked for a directory.
async function replaceDirectoryWithFile(directory: string, withChild: boolean): Promise<void> {
	fs.mkdirSync(directory, { recursive: true })

	if (withChild) {
		await settle(200)

		fs.writeFileSync(pathModule.join(directory, "child"), "x")
	}

	await settle(200)

	fs.rmSync(directory, { recursive: true, force: true })
	fs.writeFileSync(directory, "data")

	await settle(500)
}

async function main(): Promise<void> {
	const root = fs.mkdtempSync(pathModule.join(os.tmpdir(), "filen-sync-watch-"))
	let changes = 0

	fs.mkdirSync(pathModule.join(root, LOCAL_TRASH_NAME))

	const watcher = await defaultEnvironment().createWatcher(root, () => {
		changes++
	})

	await settle(200)

	try {
		// A download's staging path (the SDK's downloadFileToLocal), inside the trash.
		await replaceDirectoryWithFile(pathModule.join(root, LOCAL_TRASH_NAME, "staged"), false)

		const afterTrash = changes

		// The user's own directories, outside the trash.
		await replaceDirectoryWithFile(pathModule.join(root, "empty"), false)
		await replaceDirectoryWithFile(pathModule.join(root, "full"), true)

		process.stdout.write(JSON.stringify({ trashChanges: afterTrash, userChanges: changes - afterTrash }))
	} finally {
		await watcher.close()

		fs.rmSync(root, { recursive: true, force: true })
	}
}

main().catch(error => {
	process.stderr.write(String(error instanceof Error ? error.stack : error))
	process.exit(2)
})
