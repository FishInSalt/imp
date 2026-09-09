import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * OpenAI Codex (ChatGPT subscription credential) authentication — device-code
 * OAuth flow against auth.openai.com, modeled on the reference implementation
 * (pi's packages/ai/src/auth/oauth/openai-codex.ts) and the official Codex
 * CLI's public client id.
 *
 * Flow: request a user code → the user confirms at
 * auth.openai.com/codex/device → poll until the server returns an
 * authorization_code + code_verifier pair → exchange for access/refresh
 * tokens → decode the chatgpt_account_id JWT claim (required by the
 * backend-api headers).
 *
 * Credentials live in ~/.imp/auth.json (0600), next to logs/ and trust.json.
 * The auth base URL is injectable so tests run against a local fake server —
 * the production constants never touch the network in the test suite.
 */

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // OpenAI Codex CLI's public client id
export const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
const DEVICE_VERIFICATION_URI = `${DEFAULT_AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${DEFAULT_AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
/** Refresh this early so a turn never starts on the edge of expiry. */
const REFRESH_MARGIN_MS = 60_000;

export interface CodexCredential {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms when accessToken stops working. */
	expiresAt: number;
	/** The chatgpt-account-id header value. */
	accountId: string;
}

interface StoredCredential extends CodexCredential {
	provider: "openai-codex";
}

export interface DeviceCodePrompt {
	verificationUri: string;
	userCode: string;
	intervalSeconds: number;
}

export interface CodexAuthOptions {
	authBaseUrl?: string;
	/** Override for tests; defaults to ~/.imp/auth.json. */
	authPath?: string;
	/** Progress callback for the login UX (CLI print / REPL note). */
	onDeviceCode?: (prompt: DeviceCodePrompt) => void;
	signal?: AbortSignal;
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwtAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Codex token is not a JWT");
	try {
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		const claims = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
		if (typeof claims?.chatgpt_account_id !== "string" || claims.chatgpt_account_id === "") {
			throw new Error("Codex token JWT has no chatgpt_account_id claim");
		}
		return claims.chatgpt_account_id;
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Codex token")) throw err;
		throw new Error("Codex token JWT payload is not valid JSON");
	}
}

function authFilePath(authPath?: string): string {
	return authPath ?? path.join(homedir(), ".imp", "auth.json");
}

/** Read the stored credential; null when absent, foreign-provider, or corrupt. */
export function loadCodexCredential(authPath?: string): CodexCredential | null {
	const file = authFilePath(authPath);
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredCredential>;
		if (
			parsed.provider !== "openai-codex" ||
			typeof parsed.accessToken !== "string" ||
			typeof parsed.refreshToken !== "string" ||
			typeof parsed.expiresAt !== "number" ||
			typeof parsed.accountId !== "string"
		) {
			return null;
		}
		return {
			accessToken: parsed.accessToken,
			refreshToken: parsed.refreshToken,
			expiresAt: parsed.expiresAt,
			accountId: parsed.accountId,
		};
	} catch {
		return null; // corrupt file behaves like "not logged in"
	}
}

function persistCredential(credential: CodexCredential, authPath?: string): void {
	const file = authFilePath(authPath);
	mkdirSync(path.dirname(file), { recursive: true });
	const stored: StoredCredential = { provider: "openai-codex", ...credential };
	writeFileSync(file, `${JSON.stringify(stored, undefined, "\t")}\n`, { mode: 0o600 });
}

/** Remove the stored credential (logout). Missing file is a no-op. */
export function logoutCodex(authPath?: string): void {
	rmSync(authFilePath(authPath), { force: true });
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

async function readTokenResponse(response: Response, operation: string): Promise<CodexCredential> {
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Codex token ${operation} failed (${response.status}): ${text || response.statusText}`);
	}
	const json = (await response.json()) as TokenResponse | null;
	if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error(`Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiresAt: Date.now() + json.expires_in * 1000,
		accountId: decodeJwtAccountId(json.access_token),
	};
}

async function exchangeCode(
	code: string,
	codeVerifier: string,
	authBaseUrl: string,
	signal?: AbortSignal,
): Promise<CodexCredential> {
	const response = await fetch(`${authBaseUrl}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: codeVerifier,
			redirect_uri: DEVICE_REDIRECT_URI,
		}),
		signal,
	});
	return readTokenResponse(response, "exchange");
}

async function refreshTokens(credential: CodexCredential, authBaseUrl: string): Promise<CodexCredential> {
	const response = await fetch(`${authBaseUrl}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credential.refreshToken,
		}),
	});
	return readTokenResponse(response, "refresh");
}

/**
 * The device-code login. Resolves when the credential is persisted.
 * `onDeviceCode` fires once with the URL + user code to show the user.
 */
export async function loginCodex(options: CodexAuthOptions = {}): Promise<CodexCredential> {
	const authBaseUrl = options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL;
	const signal = options.signal;

	const start = await fetch(`${authBaseUrl}/api/accounts/deviceauth/usercode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal,
	});
	if (!start.ok) {
		const text = await start.text().catch(() => "");
		throw new Error(`Codex device-code request failed (${start.status}): ${text || start.statusText}`);
	}
	const device = (await start.json()) as { device_auth_id?: string; user_code?: string; interval?: number };
	const rawInterval: unknown = device.interval;
	const intervalSeconds = typeof rawInterval === "string" ? Number(rawInterval.trim()) : rawInterval;
	if (!device.device_auth_id || !device.user_code || typeof intervalSeconds !== "number") {
		throw new Error(`Codex device-code response missing fields: ${JSON.stringify(device)}`);
	}
	options.onDeviceCode?.({
		verificationUri: DEVICE_VERIFICATION_URI,
		userCode: device.user_code,
		intervalSeconds,
	});

	const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000;
	let pollIntervalMs = Math.max(intervalSeconds, 1) * 1000;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, pollIntervalMs);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve(); // without this the poll loop would hang past the abort
				},
				{ once: true },
			);
		});
		if (signal?.aborted) throw new Error("Login cancelled");

		const poll = await fetch(`${authBaseUrl}/api/accounts/deviceauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
			signal,
		});
		if (poll.ok) {
			const json = (await poll.json()) as { authorization_code?: string; code_verifier?: string };
			if (!json.authorization_code || !json.code_verifier) {
				throw new Error(`Codex device token response missing fields: ${JSON.stringify(json)}`);
			}
			// the server generated and returned the PKCE verifier for this flow
			const credential = await exchangeCode(json.authorization_code, json.code_verifier, authBaseUrl, signal);
			persistCredential(credential, options.authPath);
			return credential;
		}
		if (poll.status === 403 || poll.status === 404) {
			// pending (pi-observed) — but DRAIN first: an unread response body
			// poisons the keep-alive socket and the next same-origin request
			// (the token exchange) queues behind it forever (same lesson as
			// postJsonWithRetry's drain-before-retry).
			await poll.text().catch(() => "");
			continue;
		}
		const body = await poll.text().catch(() => "");
		let errorCode = "";
		try {
			const json = JSON.parse(body) as { error?: string | { code?: string } };
			const error = json?.error;
			errorCode = typeof error === "object" ? (error?.code ?? "") : (error ?? "");
		} catch {
			// non-JSON error body falls through to the generic failure below
		}
		if (errorCode === "deviceauth_authorization_pending") continue;
		if (errorCode === "slow_down") {
			pollIntervalMs = Math.min(pollIntervalMs * 2, 10_000);
			continue;
		}
		throw new Error(`Codex device auth failed (${poll.status}): ${body}`);
	}
	throw new Error("Codex device login timed out — run imp login again");
}

// Single-flight refresh: concurrent turns must not race two refreshes (the
// second would use an already-rotated refresh token and log itself out).
let refreshInFlight: Promise<CodexCredential> | null = null;

/**
 * A valid access token for the Codex backend — refreshing first when the
 * stored one is inside the expiry margin. Throws when not logged in.
 */
export async function getCodexAccessToken(options: CodexAuthOptions = {}): Promise<CodexCredential> {
	const authBaseUrl = options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL;
	const stored = loadCodexCredential(options.authPath);
	if (stored === null) {
		throw new Error("Not logged in to OpenAI (ChatGPT plan). Run:\n  imp login\nthen try again.");
	}
	if (stored.expiresAt - REFRESH_MARGIN_MS > Date.now()) return stored;
	if (refreshInFlight === null) {
		refreshInFlight = refreshTokens(stored, authBaseUrl)
			.then((credential) => {
				persistCredential(credential, options.authPath);
				return credential;
			})
			.finally(() => {
				refreshInFlight = null;
			});
	}
	try {
		return await refreshInFlight;
	} catch (err) {
		// A failed refresh (rotated/revoked token) must not silently retry forever.
		throw new Error(
			`Codex login expired — run imp login again (${err instanceof Error ? err.message : String(err)})`,
		);
	}
}
