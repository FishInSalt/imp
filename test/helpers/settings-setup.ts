/** Test-only isolation. Production installation-root dotenv loading is unchanged. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
import { NETWORK_PRELOAD } from "./cli-fixture.js";

const require = createRequire(import.meta.url);
const { takeBlockedAttempts } = require(NETWORK_PRELOAD) as { takeBlockedAttempts(): string[] };

// Clear inherited harness configuration (including obsolete IMP_*), provider
// credentials/endpoints and proxy settings before importing runtime modules.
// IMP_LEASE_* are test-only IPC markers, not production configuration aliases.
for (const key of Object.keys(process.env)) {
	if (
		key === "INK" ||
		key === "IMP" ||
		key.startsWith("INK_") ||
		(key.startsWith("IMP_") && key !== "IMP_LEASE_WORKER" && key !== "IMP_LEASE_SCRIPT") ||
		/^(ANTHROPIC|OPENAI(?:_CODEX)?|ZAI|DEEPSEEK|MOONSHOT(?:_CN)?)_(API_KEY|AUTH_TOKEN|BASE_URL)$/.test(key) ||
		/^(https?|all|no)_proxy$/i.test(key)
	)
		delete process.env[key];
}
const root = mkdtempSync(join(tmpdir(), "ink-tests-"));
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME);
process.env.INK_SETTINGS_PATH = join(root, "settings.json");
process.env.INK_AUTH_PATH = join(root, "auth.json");
process.env.INK_CATALOG_PATH = join(root, "models-catalog.json");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.NODE_OPTIONS = `--require ${JSON.stringify(NETWORK_PRELOAD)}`;
const networkLog = join(root, "blocked-network.log");
process.env.INK_TEST_NETWORK_LOG = networkLog;
function blockedAttempts(): string[] {
	const attempts = takeBlockedAttempts();
	if (existsSync(networkLog)) {
		const logged = readFileSync(networkLog, "utf8").trim();
		if (logged !== "") attempts.push(logged);
		writeFileSync(networkLog, "");
	}
	return [...new Set(attempts)];
}

// No catalog for any family: exercise the frozen offline metadata without
// reaching pi.dev. Catalog-specific tests can supply their own local server
// or injected fetcher; subprocesses receive this explicit loopback URL too.
const catalog = createServer((request, response) => {
	request.resume();
	response.writeHead(404, { "content-type": "application/json" });
	response.end("{}");
});
await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
const address = catalog.address();
if (address === null || typeof address === "string") throw new Error("Missing local catalog address");
process.env.INK_CATALOG_BASE_URL = `http://127.0.0.1:${address.port}`;

// A swallowed provider/catalog error must still fail the test that attempted
// the request. In CLI children the preload also forces a failing exit code.
afterEach(() => {
	const blocked = blockedAttempts();
	if (blocked.length > 0) throw new Error(blocked.join("\n"));
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		catalog.close((error) => (error ? reject(error) : resolve()));
		catalog.closeAllConnections();
	});
	const blocked = blockedAttempts();
	rmSync(root, { recursive: true, force: true });
	if (blocked.length > 0) throw new Error(blocked.join("\n"));
});
