import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	authFilePath,
	clearApiKey,
	loadApiKey,
	resolveApiKey,
	saveApiKey,
	storedApiKeyFamilies,
} from "../src/provider/auth-store.js";
import { loadCodexCredential, logoutCodex } from "../src/provider/codex-auth.js";

// The store redirects through IMP_AUTH_PATH so tests never touch the host's
// real ~/.imp/auth.json (same sandboxing rule as codex-auth's tests).
let dir = "";
let file = "";
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "imp-auth-"));
	file = path.join(dir, "auth.json");
	savedEnv.IMP_AUTH_PATH = process.env.IMP_AUTH_PATH;
	process.env.IMP_AUTH_PATH = file;
});

afterEach(() => {
	if (savedEnv.IMP_AUTH_PATH === undefined) delete process.env.IMP_AUTH_PATH;
	else process.env.IMP_AUTH_PATH = savedEnv.IMP_AUTH_PATH;
});

describe("auth-store (the api-key side of ~/.imp/auth.json)", () => {
	it("save/load/clear one family; clear is a no-op on a missing key", () => {
		expect(loadApiKey("zai")).toBeNull();
		saveApiKey("zai", "sk-1");
		expect(loadApiKey("zai")).toBe("sk-1");
		expect(loadApiKey("openai")).toBeNull();
		clearApiKey("zai");
		expect(loadApiKey("zai")).toBeNull();
		expect(existsSync(file)).toBe(true); // the file itself survives
		clearApiKey("zai"); // idempotent
	});

	it("saving a second family preserves the first (shared file, sections)", () => {
		saveApiKey("zai", "sk-z");
		saveApiKey("openai", "sk-o");
		expect(loadApiKey("zai")).toBe("sk-z");
		expect(loadApiKey("openai")).toBe("sk-o");
		expect(storedApiKeyFamilies()).toEqual(["zai", "openai"]);
		clearApiKey("zai");
		expect(storedApiKeyFamilies()).toEqual(["openai"]);
	});

	it("the file is written 0600 beside logs/ and trust.json", () => {
		saveApiKey("zai", "sk-1");
		const mode = statSync(file).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("resolveApiKey is pi's order: stored beats env; env is the fallback", () => {
		expect(resolveApiKey("zai", "ZAI_API_KEY")).toBeNull();
		process.env.ZAI_API_KEY = "sk-env";
		try {
			expect(resolveApiKey("zai", "ZAI_API_KEY")).toEqual({
				key: "sk-env",
				source: "env",
				envVar: "ZAI_API_KEY",
			});
			saveApiKey("zai", "sk-stored");
			expect(resolveApiKey("zai", "ZAI_API_KEY")).toEqual({ key: "sk-stored", source: "stored" });
		} finally {
			delete process.env.ZAI_API_KEY;
		}
	});

	it("a corrupt auth.json behaves like an empty store, not a crash", () => {
		writeFileSync(file, "{not json");
		expect(loadApiKey("zai")).toBeNull();
		saveApiKey("zai", "sk-1"); // writes over the corrupt file
		expect(loadApiKey("zai")).toBe("sk-1");
	});

	it("an empty-string key counts as absent", () => {
		writeFileSync(file, JSON.stringify({ version: 1, apiKeys: { zai: "" } }));
		expect(loadApiKey("zai")).toBeNull();
	});
});

describe("auth-store × codex section (legacy migration)", () => {
	it("a pre-#login-repl FLAT codex file still loads", () => {
		writeFileSync(
			file,
			JSON.stringify({
				provider: "openai-codex",
				accessToken: "at",
				refreshToken: "rt",
				expiresAt: 9999999999999,
				accountId: "acc",
			}),
		);
		expect(loadCodexCredential()?.accessToken).toBe("at");
	});

	it("saving an api key MIGRATES the flat codex file without losing it", () => {
		writeFileSync(
			file,
			JSON.stringify({
				provider: "openai-codex",
				accessToken: "at",
				refreshToken: "rt",
				expiresAt: 9999999999999,
				accountId: "acc",
			}),
		);
		saveApiKey("zai", "sk-z");
		const raw = JSON.parse(readFileSync(file, "utf8")) as { codex?: { accessToken?: string } };
		expect(raw.codex?.accessToken).toBe("at");
		expect(loadCodexCredential()?.accessToken).toBe("at");
		expect(loadApiKey("zai")).toBe("sk-z");
	});

	it("a codex token refresh PRESERVES the stored api keys (and vice versa)", () => {
		saveApiKey("zai", "sk-z");
		// persistCredential's shape, via a fresh save path: simulate by writing
		// through the public codex API — logout+login is heavier than needed;
		// the roundtrip through loadCodexCredential is pinned in codex-auth's
		// own tests. Here: write the sectioned file and verify both sides load.
		const store = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		store.codex = {
			provider: "openai-codex",
			accessToken: "at2",
			refreshToken: "rt",
			expiresAt: 1,
			accountId: "a",
		};
		writeFileSync(file, JSON.stringify(store));
		chmodSync(file, 0o600);
		expect(loadCodexCredential()?.accessToken).toBe("at2");
		expect(loadApiKey("zai")).toBe("sk-z");
	});

	it("logoutCodex removes only the codex section — stored api keys survive", () => {
		saveApiKey("openai", "sk-o");
		const store = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		store.codex = {
			provider: "openai-codex",
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: 1,
			accountId: "a",
		};
		writeFileSync(file, JSON.stringify(store));
		logoutCodex();
		expect(loadCodexCredential()).toBeNull();
		expect(loadApiKey("openai")).toBe("sk-o");
		expect(existsSync(file)).toBe(true);
		// and with NOTHING else in the file, logout removes it entirely
		clearApiKey("openai");
		const only = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		only.codex = {
			provider: "openai-codex",
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: 1,
			accountId: "a",
		};
		writeFileSync(file, JSON.stringify(only));
		logoutCodex();
		expect(existsSync(file)).toBe(false);
	});

	it("authFilePath honors explicit paths over IMP_AUTH_PATH", () => {
		expect(authFilePath()).toBe(file);
		expect(authFilePath("/explicit.json")).toBe("/explicit.json");
	});
});
