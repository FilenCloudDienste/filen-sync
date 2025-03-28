export const SYNC_INTERVAL = 5000
export const LOCAL_TRASH_NAME: string = ".filen.trash.local"
export const DEFAULT_IGNORED = {
	names: [
		".ds_store",
		"$recycle.bin",
		"system volume information",
		"._.ds_store",
		"desktop.ini",
		"thumbs.db",
		"ntuser.dat",
		".filen.trash.local",
		"AUX",
		"PRN",
		"NUL",
		"CON",
		"LPT1",
		"LPT2",
		"LPT3",
		"LPT4",
		"LPT5",
		"LPT6",
		"LPT7",
		"LPT8",
		"LPT9",
		"COM1",
		"COM2",
		"COM3",
		"COM4",
		"COM5",
		"COM6",
		"COM7",
		"COM8",
		"COM9"
	],
	extensions: [".tmp", ".temp", ".ffs_tmp", ".temporary", ".crdownload", ".~cr", ".thumbdata", ".crswap"],
	absoluteGlobs: [
		"*:/$WINDOWS.~BT/**/*",
		"*:/$RECYCLE.BIN/**/*",
		"*:/$Windows.~WS/**/*",
		"*:/$WinREAgent/**/*",
		"*:/OneDriveTemp/**/*",
		"*:/Program Files/**/*",
		"*:/Program Files (x86)/**/*",
		"*:/System Volume Information/**/*"
	],
	relativeGlobs: [".filen.trash.local/**/*", "$RECYCLE.BIN/**/*", "System Volume Information/**/*"]
}
