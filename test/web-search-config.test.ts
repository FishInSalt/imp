import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Example extensions are JavaScript modules without declarations.
import { resolveApiKey } from "../examples/extensions/web-search/_lib/config.mjs";

let dir: string;
let configPath: string;
function config(content: string | Buffer) {
	writeFileSync(configPath, content, { mode: 0o600 });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "imp-web-search-config-"));
	configPath = join(dir, "config.json");
	vi.stubEnv("TAVILY_API_KEY", "");
	vi.stubEnv("IMP_WEB_SEARCH_CONFIG", configPath);
	vi.stubEnv("HOME", dir);
	vi.stubEnv("USERPROFILE", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("web search configuration", () => {
	it("returns null for missing files and ignores the legacy variable", () => {
		vi.stubEnv("IMP_TAVILY_KEY", "unused-test-value");
		expect(resolveApiKey()).toBeNull();
	});

	it("trims file credentials and uses the default home path", () => {
		vi.stubEnv("IMP_WEB_SEARCH_CONFIG", undefined);
		mkdirSync(join(dir, ".imp", "web-search"), { recursive: true });
		configPath = join(dir, ".imp", "web-search", "config.json");
		config('{"apiKey":"  test-placeholder \\n"}');
		expect(resolveApiKey()).toBe("test-placeholder");
	});

	it("nonblank environment credentials bypass malformed files and invalid paths", () => {
		config("invalid JSON");
		vi.stubEnv("TAVILY_API_KEY", " \t environment-placeholder \n");
		expect(resolveApiKey()).toBe("environment-placeholder");
		vi.stubEnv("IMP_WEB_SEARCH_CONFIG", "relative.json");
		expect(resolveApiKey()).toBe("environment-placeholder");
	});

	it("blank environment credentials fall back to the file", () => {
		vi.stubEnv("TAVILY_API_KEY", " \n\t ");
		config('{"apiKey":"file-placeholder"}');
		expect(resolveApiKey()).toBe("file-placeholder");
	});

	it.each(["", "relative.json", "~/config.json", "$HOME/config.json", "$(command)"])(
		"rejects invalid override %j without reflecting it",
		(value) => {
			vi.stubEnv("IMP_WEB_SEARCH_CONFIG", value);
			expect(() => resolveApiKey()).toThrow(/must be an absolute file path/);
		},
	);

	it.each([
		"not-json-secret-placeholder",
		"null",
		"[]",
		"true",
		"123",
		'"string"',
		"{}",
		'{"apiKey":null}',
		'{"apiKey":123}',
		'{"apiKey":""}',
		'{"apiKey":" \\n\\t"}',
		'{"apiKey":"secret-placeholder","extra":true}',
		'{"apiKey":"secret-placeholder","__proto__":{}}',
	])("rejects invalid config %s with sanitized guidance", (value) => {
		config(value);
		try {
			resolveApiKey();
			throw new Error("Expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("TAVILY_API_KEY");
			expect((error as Error).message).not.toContain("secret-placeholder");
			expect((error as Error).message).not.toContain(configPath);
		}
	});

	it("rejects invalid UTF-8", () => {
		config(Buffer.from([0xff]));
		expect(() => resolveApiKey()).toThrow(/UTF-8 JSON/);
	});

	it("accepts exactly 16 KiB but rejects one byte more", () => {
		const value = '{"apiKey":"test-placeholder"}';
		config(value.padEnd(16 * 1024, " "));
		expect(resolveApiKey()).toBe("test-placeholder");
		config(value.padEnd(16 * 1024 + 1, " "));
		expect(() => resolveApiKey()).toThrow(/16 KiB/);
	});

	it("counts UTF-8 bytes rather than characters and rejects huge files", () => {
		config(JSON.stringify({ apiKey: "é".repeat(9000) }));
		expect(() => resolveApiKey()).toThrow(/16 KiB/);
		config(" ".repeat(1024 * 1024));
		expect(() => resolveApiKey()).toThrow(/16 KiB/);
	});

	it("rejects directories", () => {
		mkdirSync(configPath, { mode: 0o700 });
		expect(() => resolveApiKey()).toThrow(/regular file/);
	});

	it.skipIf(process.platform === "win32")("rejects symlinks including dangling symlinks", () => {
		const target = join(dir, "target.json");
		symlinkSync(target, configPath);
		expect(() => resolveApiKey()).toThrow(/regular file/);
		writeFileSync(target, '{"apiKey":"test-placeholder"}', { mode: 0o600 });
		expect(() => resolveApiKey()).toThrow(/regular file/);
	});

	it.skipIf(process.platform === "win32").each([0o640, 0o604, 0o602, 0o610, 0o601])(
		"rejects POSIX mode %s",
		(mode) => {
			config('{"apiKey":"test-placeholder"}');
			chmodSync(configPath, mode);
			expect(() => resolveApiKey()).toThrow(/chmod 600/);
		},
	);

	it("rejects FIFOs without blocking when mkfifo is available", (context) => {
		const result = spawnSync("mkfifo", [configPath], { timeout: 1000 });
		if (result.error || result.status !== 0) return context.skip();
		expect(() => resolveApiKey()).toThrow(/regular file/);
	});

	it("retries fresh after missing, invalid, corrected, rotated and deleted config", () => {
		expect(resolveApiKey()).toBeNull();
		config("invalid");
		expect(() => resolveApiKey()).toThrow();
		config('{"apiKey":"first-placeholder"}');
		expect(resolveApiKey()).toBe("first-placeholder");
		config('{"apiKey":"second-placeholder"}');
		expect(resolveApiKey()).toBe("second-placeholder");
		vi.stubEnv("TAVILY_API_KEY", "environment-placeholder");
		expect(resolveApiKey()).toBe("environment-placeholder");
		vi.stubEnv("TAVILY_API_KEY", "");
		expect(resolveApiKey()).toBe("second-placeholder");
		rmSync(configPath);
		expect(resolveApiKey()).toBeNull();
	});
});
