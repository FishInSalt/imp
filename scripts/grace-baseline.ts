// §6c.1 re-baseline harness (direct lineage, design §6c.0 item 4 / §6c.1).
// Builds the same hermetic fixture as the e2e test, then runs the EXACT
// RUNNER probe extracted from test/cli-abort-grace.test.ts (single source:
// a drift check fails loudly) via an `sh -c` hop, and prints the raw
// verdict JSON. The hangtool fixture is re-created here as an identical
// literal (asserted equal against the test file's rendered output).
// Usage: npx tsx scripts/grace-baseline.ts
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createCliFixture } from "../test/helpers/cli-fixture.js";

const run = promisify(execFile);

const testSource = readFileSync("test/cli-abort-grace.test.ts", "utf8");
const testLines = testSource.split("\n");
function lineOf(marker: string): number {
	const index = testLines.findIndex((line) => line.includes(marker));
	if (index === -1) throw new Error(`marker not found: ${marker}`);
	return index;
}
function slice(startMarker: string, endMarker: string): string {
	return testLines.slice(lineOf(startMarker) + 1, lineOf(endMarker)).join("\n");
}
function lineAfter(startIndex: number, marker: string): number {
	for (let i = startIndex; i < testLines.length; i++) if (testLines[i].includes(marker)) return i;
	throw new Error(`marker after ${startIndex} not found: ${marker}`);
}
const RUNNER_START = lineOf("const RUNNER = `");
const RUNNER = testLines.slice(RUNNER_START + 1, lineAfter(RUNNER_START, "`;")).join("\n");
// Drift check: the test renders hangtool via its HANGTOOL(markerPath) helper.
// Render it the same way here by evaluating the (small, pure) template.
const HANGTOOL_START = lineOf("const HANGTOOL = (markerPath: string): string =>");
const HANGTOOL_END = lineAfter(HANGTOOL_START, "].join(");
const HANGTOOL_BODY = testLines.slice(HANGTOOL_START + 2, HANGTOOL_END).join("\n"); // +2: skip the lone "[" line
const markerPathPlaceholder = "__MARKER_PATH__";
const hangtoolTemplate = new Function(
	"markerPath",
	`return [\n${HANGTOOL_BODY}\n].join("\\n");`,
)(markerPathPlaceholder) as string;
if (!hangtoolTemplate.includes(markerPathPlaceholder)) throw new Error("hangtool template lost its marker");
if (!hangtoolTemplate.includes('addEventListener("abort"')) throw new Error("hangtool drift: no abort-released keep-alive");

// Local loopback provider serving the tool_use SSE response, no keep-alive
// (mirrors the e2e's beforeAll; connection: close keeps the child free of
// socket handles during the grace window — §6c.0 item 1).
const SSE_START = lineOf("const TOOL_USE_SSE = [");
const SSE_END = lineAfter(SSE_START, '].join("");');
const TOOL_USE_SSE_BODY = testLines.slice(SSE_START + 1, SSE_END).join("\n");
const requests: string[] = [];
const server = createServer((request, response) => {
	requests.push(request.url ?? "");
	request.resume();
	response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
	response.end(TOOL_USE_SSE);
});
const TOOL_USE_SSE = new Function(`return [\n${TOOL_USE_SSE_BODY}\n].join("");`)() as string;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("missing provider address");
const providerUrl = `http://127.0.0.1:${address.port}`;
// Catalog stub (outside vitest there is no settings-setup server; the
// fixture allowlist demands a loopback INK_CATALOG_BASE_URL).
const catalog = createServer((request, response) => {
	request.resume();
	response.writeHead(404, { "content-type": "application/json" });
	response.end("{}");
});
await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
const catalogAddress = catalog.address();
if (catalogAddress === null || typeof catalogAddress === "string") throw new Error("missing catalog address");
process.env.INK_CATALOG_BASE_URL = `http://127.0.0.1:${catalogAddress.port}`;
const fixture = createCliFixture();
const dir = mkdtempSync(path.join(tmpdir(), "ink-grace-base-"));
let exitCode = 0;
try {
	const markerPath = path.join(fixture.cwd, "claimed.marker");
	writeFileSync(path.join(fixture.cwd, "hangtool.mjs"), hangtoolTemplate.replaceAll(markerPathPlaceholder, markerPath));
	writeFileSync(
		path.join(dir, "env.json"),
		JSON.stringify(
			fixture.env({
				ANTHROPIC_API_KEY: "fixture-key",
				ANTHROPIC_BASE_URL: providerUrl,
				INK_MCP: "0",
			}),
		),
	);
	writeFileSync(path.join(dir, "runner.cjs"), RUNNER);
	const resultPath = path.join(dir, "result.json");
	await run(
		"sh",
		[
			"-c",
			`node ${JSON.stringify(path.join(dir, "runner.cjs"))} ${JSON.stringify(resultPath)} ${JSON.stringify(fixture.bin)} ${JSON.stringify(
				fixture.cwd,
			)} ${JSON.stringify(markerPath)} ${JSON.stringify(path.join(dir, "env.json"))}`,
		],
		{ timeout: 90_000, maxBuffer: 1024 * 1024 },
	);
	process.stdout.write(`${await readFile(resultPath, "utf8")}\n`);
} catch (error) {
	exitCode = 1;
	process.stdout.write(`{"harnessError":${JSON.stringify(String(error))}}\n`);
} finally {
	try {
		fixture.cleanup();
	} finally {
		catalog.close();
		server.close();
		server.closeAllConnections();
		rmSync(dir, { recursive: true, force: true });
	}
	process.exit(exitCode);
}
