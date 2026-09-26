import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The api-key side of imp's credential store (#login-repl, pi's /login).
 *
 * One file, ~/.imp/auth.json (0600), shared with the Codex OAuth tokens:
 *
 *   { "version": 1,
 *     "codex":   { "provider": "openai-codex", "accessToken": ..., ... },
 *     "apiKeys": { "zai": "...", "openai": "...", "anthropic": "..." } }
 *
 * Files written before this batch hold the codex object FLAT at the top
 * level — readCompat treats that shape as { codex: <whole file> }, and the
 * first write migrates it into the sectioned layout (nothing is lost).
 *
 * Resolution order is pi's (packages/ai/src/auth/helpers.ts,
 * envApiKeyAuth.resolve): a STORED credential wins over the environment
 * variable; env is the fallback when nothing was stored. Deviation from pi,
 * documented: pi keeps credentials in the OS keychain; imp uses this plain
 * 0600 file — the same trust model as the codex tokens beside it.
 */

/** Families that take a plain api key via /login. Codex is OAuth-only. */
export type ApiKeyFamily = "anthropic" | "openai" | "zai" | "deepseek" | "moonshotai" | "moonshotai-cn";

interface AuthFile {
	version?: 1;
	provider?: string;
	codex?: Record<string, unknown>;
	apiKeys?: Partial<Record<ApiKeyFamily, string>>;
}

/** Where a resolved key came from — /login's status rows and error hints. */
export interface ResolvedApiKey {
	key: string;
	source: "stored" | "env";
	/** The env var name when source is "env". */
	envVar?: string;
}

export function authFilePath(authPath?: string): string {
	// IMP_AUTH_PATH redirects the store (sandboxing / hermetic tests — family
	// checks must not depend on the host login). Same rule as codex-auth.
	return authPath ?? process.env.IMP_AUTH_PATH ?? path.join(homedir(), ".imp", "auth.json");
}

/** Read the whole store, or null when absent/corrupt (behaves as empty). */
function readCompat(authPath?: string): AuthFile {
	const file = authFilePath(authPath);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as AuthFile;
		// Legacy flat codex file: the whole object IS the credential.
		if (parsed.provider === "openai-codex" && parsed.codex === undefined) {
			return { version: 1, codex: parsed as Record<string, unknown> };
		}
		return parsed;
	} catch {
		return {}; // corrupt file behaves like "not logged in"
	}
}

function writeStore(store: AuthFile, authPath?: string): void {
	const file = authFilePath(authPath);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ version: 1, ...store }, undefined, "\t")}\n`, { mode: 0o600 }); // 0600 from creation — no brief world-readable window (review P3)
	try {
		chmodSync(file, 0o600); // best-effort alongside the write mode below
	} catch {
		// chmod can fail on exotic filesystems; the write mode still applied
	}
}

/** The stored key for a family, or null when none was saved. */
export function loadApiKey(family: ApiKeyFamily, authPath?: string): string | null {
	const key = readCompat(authPath).apiKeys?.[family];
	return typeof key === "string" && key !== "" ? key : null;
}

/** Store a key for a family, preserving the codex section and other keys. */
export function saveApiKey(family: ApiKeyFamily, key: string, authPath?: string): void {
	const store = readCompat(authPath);
	store.apiKeys = { ...store.apiKeys, [family]: key };
	writeStore(store, authPath);
}

/** Remove one family's stored key (logout); missing file/key is a no-op. */
export function clearApiKey(family: ApiKeyFamily, authPath?: string): void {
	const store = readCompat(authPath);
	if (store.apiKeys?.[family] === undefined) return;
	delete store.apiKeys[family];
	if (store.apiKeys !== undefined && Object.keys(store.apiKeys).length === 0) delete store.apiKeys; // all-empty ≠ content
	writeStore(store, authPath);
}

/** Families with a stored key — /logout's row list. */
export function storedApiKeyFamilies(authPath?: string): ApiKeyFamily[] {
	const keys = readCompat(authPath).apiKeys ?? {};
	return (Object.keys(keys) as ApiKeyFamily[]).filter((family) => typeof keys[family] === "string");
}

/** pi's resolution order for the api-key families: stored credential first,
 *  then the env var; null when neither is present. */
export function resolveApiKey(
	family: ApiKeyFamily,
	envVar: string,
	authPath?: string,
): ResolvedApiKey | null {
	const stored = loadApiKey(family, authPath);
	if (stored !== null) return { key: stored, source: "stored" };
	const fromEnv = process.env[envVar];
	if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, source: "env", envVar };
	return null;
}
