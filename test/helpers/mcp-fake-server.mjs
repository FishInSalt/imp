#!/usr/bin/env node
// Fake MCP stdio server for imp's M18 tests (docs/m18-mcp-design.md §7).
// NDJSON JSON-RPC on stdin/stdout. Behavior modes via argv[2]:
//   ok        — handshake + one echo tool + one slow tool
//   two       — handshake + two tools (schema passthrough pin)
//   paginate  — tools/list returns a cursor once, then the full page
//   badline   — prints a non-JSON line BEFORE the initialize response
//   neverinit — accepts initialize but never responds (connect-timeout pin)
//   die       — answers initialize, then exits after the initialized note
//   liarcursor— tools/list ALWAYS returns one tool + a cursor (page-cap pin)
//   utf8split — every tools/list response is written as two stdout chunks
//               split mid-multi-byte-char (chunk-boundary decode pin)
//   blocks    — one tool list containing the "blocks" tool
// Tool-call behaviors keyed by tool NAME:
//   slow       — replies after 30s (call-timeout / abort pins)
//   boom       — replies isError with a message
//   blocks     — replies with 1 text + 2 image blocks (non-text omission pin)
//   echo (or anything else) — replies with the serialized arguments
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
const mode = process.argv[2] ?? "ok";
const protocolVersion = process.env.FAKE_MCP_VERSION ?? "2025-06-18";
if (process.env.FAKE_MCP_PIDFILE) {
	writeFileSync(process.env.FAKE_MCP_PIDFILE, String(process.pid));
}
const rl = createInterface({ input: process.stdin });
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

if (mode === "badline") process.stdout.write("this line is not json at all\n");

const TOOLS = {
	ok: [
		{ name: "echo", description: "echo the arguments back", inputSchema: { type: "object" } },
		{ name: "dieonce", description: "exits the server on first call", inputSchema: { type: "object" } },
	],
	two: [
		{
			name: "echo",
			description: "echo the arguments back",
			inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
		},
		{ name: "slow", description: "slow tool", inputSchema: { type: "object" } },
	],
	paginate: [
		{ name: "page1tool", inputSchema: { type: "object" } },
		{ name: "page2tool", inputSchema: { type: "object" } },
	],
	badline: [{ name: "echo", inputSchema: { type: "object" } }],
	neverinit: [{ name: "echo", inputSchema: { type: "object" } }],
	die: [{ name: "echo", inputSchema: { type: "object" } }],
	liarcursor: [{ name: "echo", inputSchema: { type: "object" } }],
	utf8split: [{ name: "echo", description: "回显参数 — chunk 边界测试", inputSchema: { type: "object" } }],
	blocks: [{ name: "blocks", inputSchema: { type: "object" } }],
};

let paginatedOnce = false;

rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.id === undefined) {
		if (msg.method === "notifications/cancelled") {
			if (process.env.FAKE_MCP_CANCEL_FILE) {
				try { writeFileSync(process.env.FAKE_MCP_CANCEL_FILE, String(msg.params?.requestId ?? "?")); } catch {}
			}
			return;
		}
		if (msg.method === "notifications/initialized" && mode === "die") {
			out({ jsonrpc: "2.0", method: "notifications/echo", params: { note: "dying now" } });
			process.exit(1);
		}
		return;
	}
	switch (msg.method) {
		case "initialize":
			if (mode === "neverinit") return; // swallow: never answer
			out({
				jsonrpc: "2.0",
				id: msg.id,
				result: { protocolVersion, capabilities: {}, serverInfo: { name: "fake" } },
			});
			break;
		case "tools/list":
			if (mode === "liarcursor") {
				// Lying server: a cursor that never ends. The client must stop at
				// the page cap and report the truncation (review P2-5 pin).
				out({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS.liarcursor, nextCursor: "again" } });
				break;
			}
			if (mode === "utf8split") {
				// Write the response as two chunks split INSIDE a multi-byte UTF-8
				// char: per-chunk toString("utf-8") would corrupt both halves and
				// the line would be dropped as stray non-JSON (review P2-4 pin).
				const payload = `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS.utf8split } })}\n`;
				const bytes = Buffer.from(payload, "utf-8");
				const splitAt = bytes.indexOf(Buffer.from("回", "utf-8")) + 1; // inside the char
				process.stdout.write(bytes.subarray(0, splitAt));
				setTimeout(() => process.stdout.write(bytes.subarray(splitAt)), 5);
				break;
			}
			if (mode === "paginate" && !paginatedOnce) {
				paginatedOnce = true;
				out({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS.paginate.slice(0, 1), nextCursor: "c2" } });
			} else if (mode === "paginate") {
				// page 2 only — pages are disjoint (server-side contract)
				out({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS.paginate.slice(1) } });
			} else {
				out({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS[mode] } });
			}
			break;
		case "tools/call": {
			const name = msg.params?.name ?? "";
			const args = msg.params?.arguments ?? {};
			if (name === "dieonce") {
				// Mid-session death pin: die WITHOUT answering — but only ONCE across
				// reconnects (each fresh process reads the same latch file, so the
				// manager's transparent retry meets a healthy server).
				const latch = process.env.FAKE_MCP_DIEONCE_FILE;
				if (latch) {
					if (!existsSync(latch)) {
						writeFileSync(latch, "1");
						process.exit(1);
					}
				} else {
					process.exit(1);
				}
			}
			if (name === "slow") {
				// never answer by tool-call path: timeout/abort pins. But record the
				// client's notifications/cancelled (ack witness, review P2-7 pin).
				return;
			}
			if (name === "boom") {
				out({
					jsonrpc: "2.0",
					id: msg.id,
					result: { content: [{ type: "text", text: "the server says no" }], isError: true },
				});
				break;
			}
			if (name === "blocks") {
				out({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						content: [
							{ type: "text", text: "text part" },
							{ type: "image", data: "aaaa", mimeType: "image/png" },
							{ type: "audio", data: "bbbb", mimeType: "audio/wav" },
						],
					},
				});
				break;
			}
			out({
				jsonrpc: "2.0",
				id: msg.id,
				result: { content: [{ type: "text", text: JSON.stringify(args) }], isError: false },
			});
			break;
		}
		default:
			out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
	}
});
