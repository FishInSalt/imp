import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodexCredential } from "../src/provider/codex-auth.js";
import {
	getCodexAccessToken,
	loadCodexCredential,
	loginCodex,
	logoutCodex,
} from "../src/provider/codex-auth.js";

/**
 * Hermetic tests for the Codex (ChatGPT subscription) device-code OAuth flow.
 * A local fake auth.openai.com serves every route; JWTs are minted locally —
 * the production auth endpoints are never contacted.
 */

function makeJwt(accountId: string): string {
	const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
	return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

function tokens(accountId: string) {
	return {
		access_token: makeJwt(accountId),
		refresh_token: `rt-${accountId}`,
		expires_in: 3600,
	};
}

describe("codex-auth (device-code OAuth)", () => {
	let server: Server;
	let baseUrl = "";
	let authFile = "";
	/** Scripts for the poll endpoint; each request pops the front. */
	let pollScript: Array<{ status: number; body: unknown }>;
	let refreshCount = 0;
	let exchangeCount = 0;

	beforeAll(async () => {
		authFile = path.join(tmpdir(), `imp-auth-test-${process.pid}.json`);
		if (existsSync(authFile)) unlinkSync(authFile); // stale from a previous run
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				// /oauth/token is form-encoded; the device routes are JSON
				const body = raw.startsWith("{")
					? (JSON.parse(raw) as Record<string, unknown>)
					: (Object.fromEntries(new URLSearchParams(raw)) as Record<string, unknown>);
				const json = (status: number, payload: unknown) => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(payload));
				};
				if (req.url === "/api/accounts/deviceauth/usercode") {
					expect(body.client_id).toBeTypeOf("string");
					json(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: 0 });
					return;
				}
				if (req.url === "/api/accounts/deviceauth/token") {
					const next = pollScript.shift() ?? {
						status: 200,
						body: { authorization_code: "ac", code_verifier: "cv" },
					};
					json(next.status, next.body);
					return;
				}
				if (req.url === "/oauth/token") {
					if (body.grant_type === "authorization_code") {
						exchangeCount++;
						expect(body.code_verifier).toBe("cv");
						json(200, tokens("acct-42"));
						return;
					}
					if (body.grant_type === "refresh_token") {
						refreshCount++;
						expect(body.refresh_token).toBe("rt-acct-42");
						json(200, tokens("acct-42"));
						return;
					}
				}
				json(404, {});
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		unlinkSync(authFile);
	});

	function writeStored(credential: Partial<CodexCredential>): void {
		writeFileSync(
			authFile,
			JSON.stringify({
				provider: "openai-codex",
				accessToken: credential.accessToken ?? makeJwt("acct-42"),
				refreshToken: credential.refreshToken ?? "rt-acct-42",
				expiresAt: credential.expiresAt ?? Date.now() + 3600_000,
				accountId: credential.accountId ?? "acct-42",
			}),
		);
	}

	it("full device login: usercode shown, pending poll, exchange, persisted with account id and 0600", async () => {
		pollScript = [
			{ status: 403, body: {} }, // pending (pi-observed 403 form)
			{ status: 400, body: { error: { code: "deviceauth_authorization_pending" } } },
			{ status: 200, body: { authorization_code: "ac", code_verifier: "cv" } },
		];
		const prompts: unknown[] = [];
		const credential = await loginCodex({
			authBaseUrl: baseUrl,
			authPath: authFile,
			onDeviceCode: (p) => prompts.push(p),
		});
		expect(prompts).toEqual([
			{ verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", intervalSeconds: 0 },
		]);
		expect(credential.accountId).toBe("acct-42");
		expect(credential.refreshToken).toBe("rt-acct-42");
		expect(exchangeCount).toBe(1);
		const mode = statSync(authFile).mode & 0o777;
		expect(mode).toBe(0o600);
		const stored = loadCodexCredential(authFile);
		expect(stored?.accountId).toBe("acct-42");
	});

	it("a stored valid credential returns without any network call", async () => {
		writeStored({ expiresAt: Date.now() + 600_000 });
		refreshCount = 0;
		const credential = await getCodexAccessToken({ authBaseUrl: baseUrl, authPath: authFile });
		expect(credential.accountId).toBe("acct-42");
		expect(refreshCount).toBe(0);
	});

	it("an expired credential refreshes once — concurrent callers share the single flight", async () => {
		writeStored({ expiresAt: Date.now() - 1000 });
		refreshCount = 0;
		const [a, b] = await Promise.all([
			getCodexAccessToken({ authBaseUrl: baseUrl, authPath: authFile }),
			getCodexAccessToken({ authBaseUrl: baseUrl, authPath: authFile }),
		]);
		expect(refreshCount).toBe(1); // not 2 — the refresh race would rotate out the token
		expect(a.accountId).toBe(b.accountId);
		// the refreshed pair is persisted
		const stored = JSON.parse(readFileSync(authFile, "utf8")) as { expiresAt: number };
		expect(stored.expiresAt).toBeGreaterThan(Date.now());
	});

	it("not logged in: the error teaches the fix; logout clears the file", async () => {
		unlinkSync(authFile);
		await expect(getCodexAccessToken({ authBaseUrl: baseUrl, authPath: authFile })).rejects.toThrow(
			/imp login/,
		);
		writeStored({});
		chmodSync(authFile, 0o600);
		logoutCodex(authFile);
		expect(existsSync(authFile)).toBe(false);
		logoutCodex(authFile); // idempotent
	});

	it("a corrupt auth.json behaves like not-logged-in, not a crash", async () => {
		writeFileSync(authFile, "{not json");
		expect(loadCodexCredential(authFile)).toBeNull();
	});

	it("a foreign-provider auth.json is ignored", async () => {
		writeFileSync(authFile, JSON.stringify({ provider: "someone-else", accessToken: "x" }));
		expect(loadCodexCredential(authFile)).toBeNull();
	});

	it("login honours abort: cancelled while polling throws, nothing persisted", async () => {
		pollScript = Array.from({ length: 50 }, () => ({ status: 403, body: {} })); // stays pending
		const controller = new AbortController();
		const attempt = loginCodex({ authBaseUrl: baseUrl, authPath: authFile, signal: controller.signal });
		setTimeout(() => controller.abort(), 1200); // after the first 1s poll sleep
		await expect(attempt).rejects.toThrow(/cancel/i);
		expect(loadCodexCredential(authFile)).toBeNull();
	});
});
