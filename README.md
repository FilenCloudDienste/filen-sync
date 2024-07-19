<br/>
<p align="center">
  <h3 align="center">Filen Sync</h3>

  <p align="center">
    A package to sync local and remote directories.
    <br/>
    <br/>
  </p>
</p>

![Contributors](https://img.shields.io/github/contributors/FilenCloudDienste/filen-sync?color=dark-green) ![Forks](https://img.shields.io/github/forks/FilenCloudDienste/filen-sync?style=social) ![Stargazers](https://img.shields.io/github/stars/FilenCloudDienste/filen-sync?style=social) ![Issues](https://img.shields.io/github/issues/FilenCloudDienste/filen-sync) ![License](https://img.shields.io/github/license/FilenCloudDienste/filen-sync)

# Attention

The package is still a work in progress. DO NOT USE IT IN PRODUCTION YET. Class names, function names, types, definitions, constants etc. are subject to change until we release a fully tested and stable version.

### Installation

1. Install using NPM

```sh
npm install @filen/sync@latest
```

2. Initialize sync pairs

```typescript
import Sync from "@filen/sync"

const sync = new Sync({
	syncPairs: [
		{
			uuid: "UUIDV4", // Only used locally to identify the sync pair
			localPath: pathModule.join(__dirname, "sync"), // Local absolute path
			remotePath: "/sync", // Remote absolute path (UNIX style)
			remoteParentUUID: "UUIDV4", // UUIDv4 of the remote parent directory
			mode: "twoWay", // Sync mode
			paused: false,
			excludeDotFiles: true,
			name: "Sync" // Only used locally to identify the sync pair
		}
	],
	sdk: new FilenSDK(), // You can either directly pass a configured FilenSDK instance or instantiate a new SDK instance when passing `sdkConfig` (optional)
	sdkConfig, // FilenSDK config object (omit when SDK instance is passed, needed when no SDK instance is passed)
	dbPath: pathModule.join(__dirname, "db"), // Used to store sync state and other data
	runOnce: false, // Run the sync once
	onMessage(message) {
		console.log(message.type)
	}
})

// Start the sync
await server.initialize()
```

## License

Distributed under the AGPL-3.0 License. See [LICENSE](https://github.com/FilenCloudDienste/filen-sync/blob/main/LICENSE.md) for more information.
