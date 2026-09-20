/**
 * Read-path resolution with macOS screenshot fallbacks — M13 batch 2,
 * ported from pi `coding-agent/src/core/tools/path-utils.ts` +
 * `utils/paths.ts` (the subset @file attachments need):
 *
 *  - ~ expansion and Unicode-space normalization (filenames pasted from
 *    rich text may carry U+00A0/U+2007/… where a plain space belongs)
 *  - macOS screenshot variants, tried in order when the exact path misses:
 *    narrow no-break space before AM/PM (U+202F), NFD decomposition,
 *    U+2019 curly apostrophe ("Capture d'écran"), then NFD + curly.
 */

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";

const NARROW_NO_BREAK_SPACE = "\u202F";

// pi's UNICODE_SPACES class: every space-like codepoint terminals may
// substitute for U+0020.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface NormalizePathOptions {
	normalizeUnicodeSpaces?: boolean;
	stripAtPrefix?: boolean;
	expandTilde?: boolean;
	homeDir?: string;
}

export function normalizePath(input: string, options: NormalizePathOptions = {}): string {
	let normalized = input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/")) {
			return join(home, normalized.slice(2));
		}
	}
	return normalized;
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 in screenshot names like "Capture d'écran";
	// users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "’");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve a path relative to cwd, with ~ expansion and space normalization. */
export function resolveToCwd(filePath: string, cwd: string, options?: NormalizePathOptions): string {
	const normalized = normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true, ...options });
	const normalizedBase = normalizePath(cwd, { expandTilde: options?.expandTilde ?? true });
	return isAbsolute(normalized) ? nodeResolve(normalized) : nodeResolve(normalizedBase, normalized);
}

/** resolveToCwd plus the macOS screenshot variants when the exact miss. */
export function resolveReadPath(filePath: string, cwd: string, options?: NormalizePathOptions): string {
	const resolved = resolveToCwd(filePath, cwd, options);
	if (fileExists(resolved)) return resolved;

	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) return amPmVariant;

	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) return nfdVariant;

	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) return curlyVariant;

	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) return nfdCurlyVariant;

	return resolved; // caller reports the original miss
}
