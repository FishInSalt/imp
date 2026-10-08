// print-mode abort-grace e2e (#abort-grace design §6 test-plan item 7;
// follow-up batch plan §6c — fixture shape, design §6c.0).
//
// SHAPE NOTES.
//
// Lineage: the CLI child is spawned from a plain-node RUNNER script (itself
// started via an `sh -c` hop), NOT from the vitest worker thread. Signal
// delivery to children of a vitest worker is unreliable on macOS (§6b.3);
// the hop escapes that lineage. The runner is a dumb probe: spawn, claim
// handshake, SIGINT, collect, write the JSON verdict.
//
// Hermetic (§6c.0 item 3): the copied install, env allowlist, network
// preload and catalog pinning all come from createCliFixture() in THIS
// process; the child's env is serialized to env.json and the runner uses it
// verbatim. No allowlist logic in the runner. The provider SSE server also
// lives here (loopback only); it answers "connection: close" so the child
// holds no keep-alive socket handles during the grace window (§6c.0 item 1,
// R3: the sentinel must not be masked by a second ref'd handle).
//
// Keep-alive shape (§6c.0 item 1): the hung tool's interval is released on
// the tool's OWN abort signal, NOT on run_end (run_end fires only AFTER the
// grace window — releasing there would let an unref'd grace timer hide
// behind the interval). During the grace window the grace timer is the
// child's only ref'd handle, so the stderr "did not respond to the
// interrupt" assertion is the unref SENTINEL: re-adding .unref() to the
// grace timer ⇒ drain-exit ⇒ that assertion reds (code===0 and the stdout
// assertion stay green; only the two stderr lines carry sentinel duty).
//
// Claim handshake (§6c.0 item 2): the tool writes a marker file when its
// execute() starts; the runner polls for it (bounded, 50ms interval, 20s
// deadline) before sending the SIGINT — the signal must land while the tool
// is genuinely in flight, never in the pre-claim window (verdict-table
// row 3, §6c.1). Every wait has a deadline; nothing spins unbounded.
import { execFile } from "node:child_process";
import { mkdtempSync, readFile as readFileCb, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliFixture, createCliFixture } from "./helpers/cli-fixture.js";

const run = promisify(execFile);
const readFile = promisify(readFileCb);

// Plain-node probe. argv: resultPath bin cwd markerPath envPath.
const RUNNER = `
const fs = require("fs");
const { spawn } = require("child_process");
const [resultPath, BIN, cwd, markerPath, envPath] = process.argv.slice(2);
const childEnv = JSON.parse(fs.readFileSync(envPath, "utf8"));
const child = spawn(process.execPath, [BIN, "-p", "run the hung tool", "-e", cwd + "/hangtool.mjs"], {
  cwd: cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
});
// BOTH streams captured: the interrupt hint goes to stdout (cli.ts) and the
// abandoning line to stderr — asserting each on its real channel separates
// "handler ran" from "exit was impossible" (round-2 review MAJOR-1).
let stderr = "";
let stdout = "";
child.stderr.on("data", function (d) { stderr += d.toString(); });
child.stdout.on("data", function (d) { stdout += d.toString(); });
const finish = function (code, note) {
  fs.writeFileSync(resultPath, JSON.stringify({ code: code, note: note || "", stderr: stderr, stdout: stdout }));
  try { child.kill("SIGKILL"); } catch {}
  process.exit(0);
};
// Claim handshake (§6c.0 item 2): bounded poll for the tool's marker, then
// SIGINT. Every wait below has a deadline — no unbounded spinning.
const start = Date.now();
const waitClaim = setInterval(function () {
  if (!fs.existsSync(markerPath)) {
    if (Date.now() - start > 20000) { clearInterval(waitClaim); finish(-3, "no claim"); }
    return;
  }
  clearInterval(waitClaim);
  child.kill("SIGINT");
  const t0 = Date.now();
  child.on("exit", function (c) { finish(c, "dt=" + (Date.now() - t0)); });
  setTimeout(function () { finish(-1, "timeout dt=" + (Date.now() - t0)); }, 30000);
}, 50);
`;

const HANGTOOL = (markerPath: string): string =>
	[
		'import { writeFileSync as w } from "node:fs";',
		"let io = null;",
		`const writeMarker = () => w(${JSON.stringify(markerPath)}, "claimed");`,
		"export default function (api) {",
		"  api.registerTool({",
		'    name: "hangtool",',
		'    description: "never settles, ignores the signal",',
		'    parameters: { type: "object", additionalProperties: true },',
		"    async execute(_args, signal) {",
		"      io = setInterval(() => {}, 1 << 30);",
		'      signal.addEventListener("abort", () => clearInterval(io));',
		"      writeMarker();",
		"      await new Promise(() => {});",
		'      return { output: "never" };',
		"    },",
		"  });",
		"}",
		"",
	].join("\n");

const TOOL_USE_SSE = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"hang1","name":"hangtool"}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	"",
].join("");

describe("print-mode abort grace e2e (#abort-grace design §6 test-plan item 7)", () => {
	let fixture: CliFixture;
	let provider: { url: string; close(): Promise<void> };

	beforeAll(async () => {
		fixture = createCliFixture();
		// Local loopback provider serving one tool_use response, no keep-alive
		// (see file-head SHAPE NOTES: no second ref'd handle in the child).
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(request.url ?? "");
			request.resume();
			response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
			response.end(TOOL_USE_SSE);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("missing provider address");
		provider = {
			url: `http://127.0.0.1:${address.port}`,
			close: () =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				}),
		};
	}, 20_000);

	afterAll(() => {
		try {
			fixture?.cleanup();
		} finally {
			void provider?.close();
		}
	});

	it("a SIGINT with a signal-ignoring tool exits bounded (code 0), abandon line on stderr", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "ink-grace-out-"));
		const markerPath = path.join(fixture.cwd, "claimed.marker");
		writeFileSync(path.join(fixture.cwd, "hangtool.mjs"), HANGTOOL(markerPath));
		writeFileSync(path.join(dir, "runner.cjs"), RUNNER);
		writeFileSync(
			path.join(dir, "env.json"),
			JSON.stringify(
				fixture.env({
					ANTHROPIC_API_KEY: "fixture-key",
					ANTHROPIC_BASE_URL: provider.url,
					INK_MCP: "0",
				}),
			),
		);
		const resultPath = path.join(dir, "result.json");
		try {
			// The sh hop matters: the CLI child must not descend from the
			// vitest worker's (unreliable) signal lineage — see the file note.
			await run(
				"sh",
				[
					"-c",
					`node ${JSON.stringify(path.join(dir, "runner.cjs"))} ${JSON.stringify(resultPath)} ${JSON.stringify(
						fixture.bin,
					)} ${JSON.stringify(fixture.cwd)} ${JSON.stringify(markerPath)} ${JSON.stringify(path.join(dir, "env.json"))}`,
				],
				{ timeout: 60_000, maxBuffer: 1024 * 1024 },
			);
			const raw = await readFile(resultPath, "utf8");
			const result = JSON.parse(raw) as { code: number; note: string; stderr: string; stdout: string };
			// Instrument must not destroy its own evidence (round-1 MINOR-3):
			// full verdict to stderr before any assertion can fail.
			console.error(`[grace-e2e] code=${result.code} note=${result.note}`);
			console.error(`[grace-e2e] stdout tail: ${JSON.stringify(result.stdout.slice(-200))}`);
			console.error(`[grace-e2e] stderr tail: ${JSON.stringify(result.stderr.slice(-300))}`);
			expect(result.note).not.toBe("no claim");
			expect(result.code).toBe(0); // single SIGINT resolves aborted → 0 (design §2.3)
			expect(result.stdout).toContain("interrupt"); // the hint line — the handler ran
			expect(result.stderr).toContain("did not respond to the interrupt"); // unref SENTINEL (§6c.0 item 1)
			expect(result.stderr).toContain("abandoning its result");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 70_000);
});
