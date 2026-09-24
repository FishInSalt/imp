import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_BYTES = 16 * 1024;
const guidance = " Set TAVILY_API_KEY or fix the private web-search config file (only a nonblank apiKey string).";

function failure(message) {
	return new Error(`Web search configuration: ${message}.${guidance}`);
}

function checkFile(stat) {
	if (!stat.isFile()) throw failure("config must be a regular file, not a symlink or special file");
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		throw failure("config permissions must deny group and other access; use chmod 600");
	}
}

/**
 * Resolve on every call; null means the file is absent and no environment key exists.
 * Only the final path component is protected against symlinks. Parent directories
 * must be trusted and user-controlled; this is not a filesystem sandbox.
 */
export function resolveApiKey() {
	const envKey = process.env.TAVILY_API_KEY?.trim();
	if (envKey) return envKey;

	const override = process.env.IMP_WEB_SEARCH_CONFIG;
	if (override !== undefined && (!isAbsolute(override) || override.includes("\0"))) {
		throw failure("IMP_WEB_SEARCH_CONFIG must be an absolute file path without shell expansion");
	}
	const path = override ?? join(homedir(), ".imp", "web-search", "config.json");
	if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
		throw failure("safe config-file access is unavailable on this platform; use TAVILY_API_KEY");
	}

	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw failure("cannot inspect config file");
	}
	// Early rejection only: the opened descriptor is checked again below.
	checkFile(stat);
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw failure("cannot safely open config file; remove final-component symlinks and check access");
	}

	let bytes;
	try {
		let opened;
		try {
			opened = fstatSync(fd);
		} catch {
			throw failure("cannot inspect opened config file");
		}
		checkFile(opened);
		if (opened.size > MAX_BYTES) throw failure("config exceeds the 16 KiB limit");
		bytes = Buffer.alloc(MAX_BYTES + 1);
		let used = 0;
		try {
			while (used < bytes.length) {
				const count = readSync(fd, bytes, used, bytes.length - used, null);
				if (count === 0) break;
				used += count;
			}
		} catch {
			throw failure("cannot read config file");
		}
		if (used > MAX_BYTES) throw failure("config exceeds the 16 KiB limit");
		bytes = bytes.subarray(0, used);
	} finally {
		try {
			closeSync(fd);
		} catch {
			throw failure("cannot close config file");
		}
	}

	let config;
	try {
		config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw failure("config must contain valid UTF-8 JSON");
	}
	if (
		config === null ||
		typeof config !== "object" ||
		Array.isArray(config) ||
		Object.getPrototypeOf(config) !== Object.prototype ||
		Object.keys(config).length !== 1 ||
		!Object.hasOwn(config, "apiKey") ||
		typeof config.apiKey !== "string" ||
		!config.apiKey.trim()
	) {
		throw failure("config must be an object containing only a nonblank apiKey string");
	}
	return config.apiKey.trim();
}
