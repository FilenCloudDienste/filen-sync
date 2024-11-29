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
		".trash",
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
		"*:/Windows/**/*",
		"*:/OneDriveTemp/**/*",
		"*:/PerfLogs/**/*",
		"*:/ProgramData/**/*",
		"*:/Program Files/**/*",
		"*:/Program Files (x86)/**/*",
		"/share/Trash/**/*",
		"*:/System Volume Information/**/*"
	],
	relativeGlobs: [
		".filen.trash.local/**/*",
		"$RECYCLE.BIN/**/*",
		".Trash/**/*",
		".local/share/Trash/**/*",
		"local/share/Trash/**/*",
		"System Volume Information/**/*"
	]
}
