import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parse a .env file: KEY=VALUE lines, optional `export ` prefix, quotes trimmed.
 * Comments (#) and blank lines are ignored.
 */
export function parseDotEnv(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
		if (!match) continue;
		const key = match[1] ?? "";
		const value = (match[2] ?? "").trim().replace(/^["'](.*)["']$/, "$1");
		if (key === "") continue;
		result[key] = value;
	}
	return result;
}

/**
 * Load `.env` from the imp installation root (the directory containing
 * package.json — resolves correctly for both src/ via tsx and dist/ builds,
 * and regardless of the caller's cwd). Real environment variables win,
 * so `ANTHROPIC_API_KEY=... imp` still overrides the file.
 */
export async function loadDotEnv(): Promise<void> {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	let text: string;
	try {
		text = await readFile(path.join(root, ".env"), "utf8");
	} catch {
		return; // no .env — nothing to do
	}
	for (const [key, value] of Object.entries(parseDotEnv(text))) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}
