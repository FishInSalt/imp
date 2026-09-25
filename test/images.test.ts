import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction.js";
import {
	type AgentMessage,
	type AssistantMessage,
	type ContentBlock,
	contentText,
} from "../src/core/messages.js";
import { detectSupportedImageMimeType } from "../src/core/tools/image-sniff.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createAnthropicProvider } from "../src/provider/anthropic.js";
import { createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import { createOpenAICompletionsProvider } from "../src/provider/openai-completions.js";
import { downgradeUnsupportedImages } from "../src/provider/shared.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { modelSupportsVision } from "../src/provider/vision.js";

// ---------------------------------------------------------------------------
// Synthetic image fixtures (magic bytes only — the sniffer never reads past
// the header structure it validates).
// ---------------------------------------------------------------------------

/** Real, photon-decodable PNG (batch 2: read runs the processor). */
function realPng(width = 4, height = 4): Buffer {
	const zlib = require("node:zlib") as typeof import("node:zlib");
	const crcTable: number[] = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c >>> 0;
	}
	const crc32 = (buf: Buffer): number => {
		let c = 0xffffffff;
		for (const byte of buf) c = crcTable[(c ^ byte)! & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer): Buffer => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.concat(
		Array.from({ length: height }, (_, y) =>
			Buffer.concat([
				Buffer.from([0]), // filter: none
				Buffer.concat(
					Array.from({ length: width }, (_, x) => Buffer.from([(x * 40) % 256, (y * 40) % 256, 128, 255])),
				),
			]),
		),
	);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** Real 24-bit BMP (bottom-up rows, no palette). */
function realBmp(width = 4, height = 4): Buffer {
	const rowSize = Math.ceil((width * 3) / 4) * 4; // rows pad to 4 bytes
	const pixelData = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (height - 1 - y) * rowSize + x * 3; // bottom-up
			pixelData[at] = 200; // B
			pixelData[at + 1] = (x * 40) % 256; // G
			pixelData[at + 2] = (y * 40) % 256; // R
		}
	}
	const dib = Buffer.alloc(40);
	dib.writeUInt32LE(40, 0);
	dib.writeInt32LE(width, 4);
	dib.writeInt32LE(height, 8);
	dib.writeUInt16LE(1, 12);
	dib.writeUInt16LE(24, 14);
	const header = Buffer.alloc(14);
	header.write("BM", 0, "ascii");
	header.writeUInt32LE(14 + dib.length + pixelData.length, 2);
	header.writeUInt32LE(14 + dib.length, 10);
	return Buffer.concat([header, dib, pixelData]);
}

function pngBytes(animated = false): Buffer {
	const buf = Buffer.alloc(64);
	PNG_SIG.copy(buf, 0);
	buf.writeUInt32BE(13, 8); // IHDR length
	buf.write(animated ? "acTL" : "IHDR", 12, "ascii");
	// 13 bytes of IHDR data + CRC live at 16..32
	buf.writeUInt32BE(2, 33); // second chunk length
	buf.write("IDAT", 37, "ascii");
	return buf;
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jpegBytes(xr = false): Buffer {
	const buf = Buffer.alloc(32);
	buf[0] = 0xff;
	buf[1] = 0xd8;
	buf[2] = 0xff;
	buf[3] = xr ? 0xf7 : 0xe0;
	return buf;
}

function gifBytes(): Buffer {
	const buf = Buffer.alloc(32);
	buf.write("GIF89a", 0, "ascii");
	return buf;
}

function webpBytes(): Buffer {
	const buf = Buffer.alloc(32);
	buf.write("RIFF", 0, "ascii");
	buf.write("WEBP", 8, "ascii");
	return buf;
}

function bmpBytes(): Buffer {
	const buf = Buffer.alloc(70);
	buf.write("BM", 0, "ascii");
	buf.writeUInt32LE(70, 2); // declared file size
	buf.writeUInt32LE(54, 10); // pixel data offset
	buf.writeUInt32LE(40, 14); // DIB header size (BITMAPINFOHEADER)
	buf.writeUInt16LE(1, 26); // color planes
	buf.writeUInt16LE(24, 28); // bits per pixel
	return buf;
}

describe("M13 magic-byte sniffing (pi image.ts parity)", () => {
	it("classifies each supported family by content", () => {
		expect(detectSupportedImageMimeType(pngBytes())).toBe("image/png");
		expect(detectSupportedImageMimeType(jpegBytes())).toBe("image/jpeg");
		expect(detectSupportedImageMimeType(gifBytes())).toBe("image/gif");
		expect(detectSupportedImageMimeType(webpBytes())).toBe("image/webp");
		expect(detectSupportedImageMimeType(bmpBytes())).toBe("image/bmp");
	});

	it("rejects JPEG-XR (0xf7), animated PNG (acTL), text, and truncated buffers", () => {
		expect(detectSupportedImageMimeType(jpegBytes(true))).toBeUndefined();
		expect(detectSupportedImageMimeType(pngBytes(true))).toBeUndefined();
		expect(detectSupportedImageMimeType(Buffer.from("hello text file", "utf8"))).toBeUndefined();
		expect(detectSupportedImageMimeType(PNG_SIG.subarray(0, 6))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// read tool
// ---------------------------------------------------------------------------

async function tmpFixture(name: string, bytes: Buffer): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "imp-img-"));
	const file = path.join(dir, name);
	await writeFile(file, bytes);
	return file;
}

describe("M13 read tool image path", () => {
	it("returns text note + image blocks for a PNG", async () => {
		const png = realPng(4, 4);
		const file = await tmpFixture("shot.png", png);
		const tool = createReadTool({});
		const result = await tool.execute({ path: file }, new AbortController().signal);
		expect(result.isError).toBeUndefined();
		const blocks = result.content ?? [];
		expect(blocks).toHaveLength(2);
		const [note, image] = blocks as ContentBlock[];
		expect(note).toEqual({ type: "text", text: "Read image file [image/png]" });
		// 4×4 is under every limit — passthrough keeps the original bytes
		expect(image).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
	});

	it("BMP converts to PNG with the conversion hint (batch 2 processor)", async () => {
		const file = await tmpFixture("x.bmp", realBmp(4, 4));
		const result = await createReadTool({}).execute({ path: file }, new AbortController().signal);
		expect(result.content).toBeDefined();
		const [note, image] = result.content as ContentBlock[];
		if (note?.type !== "text" || image?.type !== "image") throw new Error("unexpected blocks");
		expect(note.text).toContain("Read image file [image/png]");
		expect(note.text).toContain("[Image converted from image/bmp to image/png.]");
		expect(image.mimeType).toBe("image/png");
	});

	it("undecodable image bytes get the resize-failure note, never an error", async () => {
		// A header-only buffer passes sniffing but photon cannot decode it —
		// the processor's failure wording (batch 2), still not an error.
		const big = Buffer.alloc(4.6 * 1024 * 1024);
		PNG_SIG.copy(big, 0);
		big.writeUInt32BE(13, 8);
		big.write("IHDR", 12, "ascii");
		big.writeUInt32BE(2, 33);
		big.write("IDAT", 37, "ascii");
		const file = await tmpFixture("big.png", big);
		const result = await createReadTool({}).execute({ path: file }, new AbortController().signal);
		expect(result.content).toBeUndefined();
		expect(result.output).toContain("Read image file [image/png]");
		expect(result.output).toContain(
			"[Image omitted: could not be resized below the inline image size limit.]",
		);
		expect(result.isError).toBeUndefined();
	});

	it("autoResize=false: oversize keeps the batch-1 teaching error (encoded cap)", async () => {
		const raw = Buffer.alloc(3.4 * 1024 * 1024); // 4.5MB+ encoded
		PNG_SIG.copy(raw, 0);
		raw.writeUInt32BE(13, 8);
		raw.write("IHDR", 12, "ascii");
		raw.writeUInt32BE(2, 33);
		raw.write("IDAT", 37, "ascii");
		const file = await tmpFixture("enc.png", raw);
		const result = await createReadTool({ imageProcessing: { autoResize: false } }).execute(
			{ path: file },
			new AbortController().signal,
		);
		expect(result.content).toBeUndefined();
		expect(result.output).toContain("encoded exceeds the 4.5 MB inline limit");
	});

	it("non-vision model appends the omission note; the read still succeeds", async () => {
		const file = await tmpFixture("a.png", realPng(4, 4));
		const result = await createReadTool({ modelSupportsVision: () => false }).execute(
			{ path: file },
			new AbortController().signal,
		);
		expect(result.content).toBeDefined();
		expect(result.output).toContain("Current model does not support images");
	});

	it("text files: logical line contents, no content blocks", async () => {
		const file = await tmpFixture("notes.txt", Buffer.from("line1\nline2\n", "utf8"));
		const result = await createReadTool({}).execute({ path: file }, new AbortController().signal);
		expect(result.content).toBeUndefined();
		expect(result.output).toBe("line1\nline2");
	});
});

// ---------------------------------------------------------------------------
// downgrade
// ---------------------------------------------------------------------------

const IMAGE: ContentBlock = { type: "image", data: "AAAA", mimeType: "image/png" };

describe("M13 downgradeUnsupportedImages (pi transform-messages parity)", () => {
	it("vision model → identity", () => {
		const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "look" }, IMAGE] }];
		expect(downgradeUnsupportedImages(messages, true)).toBe(messages);
	});

	it("non-vision: user images become one collapsed placeholder", () => {
		const [down] = downgradeUnsupportedImages(
			[{ role: "user", content: [{ type: "text", text: "a" }, IMAGE, IMAGE] }],
			false,
		);
		expect(down).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "(image omitted: model does not support images)" },
			],
		});
	});

	it("non-vision: tool images use the tool placeholder; strings untouched", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "plain" },
			{
				role: "toolResult",
				results: [
					{
						toolCallId: "t1",
						toolName: "read",
						content: [{ type: "text", text: "note" }, IMAGE],
						isError: false,
					},
					{ toolCallId: "t2", toolName: "bash", content: "stdout", isError: false },
				],
			},
		];
		const down = downgradeUnsupportedImages(messages, false);
		expect(down[0]).toBe(messages[0]); // string content: same reference
		const tr = down[1];
		if (tr?.role !== "toolResult") throw new Error("unreachable");
		expect(tr.results[0]?.content).toEqual([
			{ type: "text", text: "note" },
			{ type: "text", text: "(tool image omitted: model does not support images)" },
		]);
		expect(tr.results[1]?.content).toBe("stdout");
	});
});

// ---------------------------------------------------------------------------
// vision rules
// ---------------------------------------------------------------------------

describe("M13 vision prefix rules", () => {
	it("zai: 5.3-flash/flashx and 5v are vision; 5.3/5.2/4.7 are not; unknown defaults false", () => {
		expect(modelSupportsVision("zai", "glm-5.3-flash")).toBe(true);
		expect(modelSupportsVision("zai", "glm-5.3-flashx")).toBe(true);
		expect(modelSupportsVision("zai", "glm-5v-turbo")).toBe(true);
		expect(modelSupportsVision("zai", "glm-4.6v-flash")).toBe(true);
		expect(modelSupportsVision("zai", "glm-5.3")).toBe(false);
		expect(modelSupportsVision("zai", "glm-5.2-highspeed")).toBe(false);
		expect(modelSupportsVision("zai", "glm-4.7")).toBe(false);
	});

	it("anthropic/openai/codex families; unknown → false (fail-safe)", () => {
		expect(modelSupportsVision("anthropic", "claude-fable-5")).toBe(true);
		expect(modelSupportsVision("openai", "gpt-4o-mini")).toBe(true);
		expect(modelSupportsVision("openai", "o3-mini")).toBe(true);
		expect(modelSupportsVision("openai-codex", "gpt-5-codex")).toBe(true);
		expect(modelSupportsVision("openai-codex", "gpt-5.5")).toBe(true);
		expect(modelSupportsVision("codex", "gpt-5-codex")).toBe(false); // review P1: the runner name is openai-codex
		expect(modelSupportsVision("openai", "gpt-3.5-turbo")).toBe(false);
		expect(modelSupportsVision("deepseek", "deepseek-v4")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// compaction
// ---------------------------------------------------------------------------

describe("M13 compaction estimate", () => {
	it("an image block costs 4800 chars (~1200 tokens), never its data length", () => {
		const huge: ContentBlock = { type: "image", data: "A".repeat(40000), mimeType: "image/png" };
		const tokens = estimateTokens({
			role: "toolResult",
			results: [
				{
					toolCallId: "t",
					toolName: "read",
					content: [{ type: "text", text: "note" }, huge],
					isError: false,
				},
			],
		});
		// text(4) + 4800 = 4804 chars → ceil/4 = 1201
		expect(tokens).toBe(1201);
	});
});

// ---------------------------------------------------------------------------
// contentText
// ---------------------------------------------------------------------------

describe("M13 contentText", () => {
	it("joins text blocks; images contribute nothing", () => {
		expect(contentText("plain")).toBe("plain");
		expect(contentText([{ type: "text", text: "a" }, IMAGE, { type: "text", text: "b" }])).toBe("a\nb");
	});
});

// ---------------------------------------------------------------------------
// Provider wire goldens — one local server, scripted minimal SSE streams.
// ---------------------------------------------------------------------------

interface Captured {
	method: string;
	body: Record<string, unknown>;
}

function minimalAssistant(): AssistantMessage {
	return {
		role: "assistant",
		blocks: [{ type: "text", text: "ok" }],
		usage: { inputTokens: 1, outputTokens: 1 },
		stopReason: "end_turn",
	};
}

/** A provider whose fetch goes to the local server; SSE stream ends after one
 *  keep-alive-ish chunk set sufficient for each adapter to finish. */
async function drive(provider: LLMProvider, request: LLMRequest): Promise<Captured> {
	const events: unknown[] = [];
	for await (const e of provider.stream(request)) events.push(e);
	return captured[0] ?? { method: "", body: {} };
}

let server: Server;
let baseUrl = "";
const captured: Captured[] = [];
let script = { status: 200, chunks: "" };

beforeAll(async () => {
	server = createServer((req, res) => {
		const parts: Buffer[] = [];
		req.on("data", (c) => parts.push(c as Buffer));
		req.on("end", () => {
			captured.push({
				method: req.method ?? "",
				body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>,
			});
			res.writeHead(script.status, { "content-type": "text/event-stream" });
			res.end(script.chunks);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (addr === null || typeof addr === "string") throw new Error("no address");
	baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
	server.close();
});

function anthropicChunks(): string {
	const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
	return (
		sse("message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }) +
		sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }) +
		sse("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "ok" },
		}) +
		sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }) +
		sse("message_stop", { type: "message_stop" })
	);
}

function openaiChunks(): string {
	return (
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n` +
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
		"data: [DONE]\n\n"
	);
}

function codexChunks(): string {
	const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
	return (
		sse("response.output_text.delta", { output_index: 0, delta: "ok" }) +
		sse("response.completed", {
			type: "response.completed",
			response: { id: "r1", usage: { input_tokens: 1, output_tokens: 1 } },
		})
	);
}

const imageTurn = (): AgentMessage[] => [
	{ role: "user", content: "what is in this picture?" },
	{
		role: "assistant",
		blocks: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "shot.png" } }],
		usage: { inputTokens: 1, outputTokens: 1 },
		stopReason: "tool_use",
	},
	{
		role: "toolResult",
		results: [
			{
				toolCallId: "t1",
				toolName: "read",
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: "QUJD", mimeType: "image/png" },
				],
				isError: false,
			},
		],
	},
];

describe("M13 anthropic wire", () => {
	it("embeds image blocks inside tool_result.content (golden)", async () => {
		captured.length = 0;
		script = { status: 200, chunks: anthropicChunks() };
		const provider = createAnthropicProvider({ baseUrl, apiKey: "k" });
		await drive(provider, {
			system: "s",
			model: "claude-test",
			messages: imageTurn(),
			tools: [],
			maxTokens: 16,
		});
		const body = captured[0]?.body;
		const messages = body?.messages as Array<{ role: string; content: unknown }>;
		const userTurn = messages?.find((m) => m.role === "user" && Array.isArray(m.content));
		const toolResult = (userTurn?.content as Array<Record<string, unknown>>)?.find(
			(c) => c.type === "tool_result",
		);
		expect(toolResult?.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
		]);
	});

	it("non-vision model never carries base64: placeholders instead", async () => {
		captured.length = 0;
		script = { status: 200, chunks: anthropicChunks() };
		const provider = createAnthropicProvider({ baseUrl, apiKey: "k" });
		await drive(provider, {
			system: "s",
			// every real claude-* is vision-capable; a non-matching id exercises
			// the fail-safe default and the downgrade wiring
			model: "text-only-hypothetical",
			messages: imageTurn(),
			tools: [],
			maxTokens: 16,
		});
		const raw = JSON.stringify(captured[0]?.body);
		expect(raw).not.toContain("QUJD");
		expect(raw).toContain("(tool image omitted: model does not support images)");
	});
});

describe("M13 openai-completions wire", () => {
	it("hoists tool images into a following user message as data URLs (golden)", async () => {
		captured.length = 0;
		script = { status: 200, chunks: openaiChunks() };
		const provider = createOpenAICompletionsProvider({ baseUrl, apiKey: "k" });
		await drive(provider, {
			system: "s",
			model: "gpt-4o",
			messages: imageTurn(),
			tools: [],
			maxTokens: 16,
		});
		const messages =
			(captured[0]?.body?.messages as Array<{ role: string; content: unknown }> | undefined) ?? [];
		const toolMsg = messages.find((m) => m.role === "tool");
		if (toolMsg === undefined) throw new Error("no tool message");
		expect(toolMsg.content).toBe("Read image file [image/png]");
		const after = messages[messages.indexOf(toolMsg) + 1];
		expect(after).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "Attached image(s) from tool result:" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
			],
		});
	});

	it("non-vision model: tool text only, no image_url anywhere", async () => {
		captured.length = 0;
		script = { status: 200, chunks: openaiChunks() };
		const provider = createOpenAICompletionsProvider({ baseUrl, apiKey: "k" });
		await drive(provider, {
			system: "s",
			model: "gpt-3.5-turbo",
			messages: imageTurn(),
			tools: [],
			maxTokens: 16,
		});
		const raw = JSON.stringify(captured[0]?.body);
		expect(raw).not.toContain("image_url");
		expect(raw).toContain("(tool image omitted: model does not support images)");
	});
});

describe("M13 codex-responses wire", () => {
	it("function_call_output carries input_image parts (golden)", async () => {
		captured.length = 0;
		script = { status: 200, chunks: codexChunks() };
		const provider = createCodexResponsesProvider({
			baseUrl,
			auth: async () => ({ accessToken: "t", accountId: "a" }),
		});
		await drive(provider, {
			system: "s",
			model: "gpt-5-codex",
			messages: imageTurn(),
			tools: [],
			maxTokens: 16,
		});
		const input = captured[0]?.body?.input as Array<Record<string, unknown>>;
		const outputItem = input?.find((i) => i.type === "function_call_output");
		expect(outputItem?.output).toEqual([
			{ type: "input_text", text: "Read image file [image/png]" },
			{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,QUJD" },
		]);
	});
});

// ---------------------------------------------------------------------------
// e2e: the read tool produces blocks through the real loop
// ---------------------------------------------------------------------------

describe("M13 e2e — image read through the loop", () => {
	it("the toolResult history entry carries the blocks; the provider sees them", async () => {
		const file = await tmpFixture("e2e.png", realPng(4, 4));
		const requests: LLMRequest[] = [];
		const scripts: AssistantMessage[] = [
			{
				role: "assistant",
				blocks: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: file } }],
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "tool_use",
			},
			minimalAssistant(),
		];
		let call = 0;
		const provider: LLMProvider = {
			name: "mock",
			async *stream(request) {
				requests.push(request);
				const message = scripts[Math.min(call, scripts.length - 1)]!;
				call++;
				yield { type: "message_end", message };
			},
		};
		const { runAgentLoop } = await import("../src/core/loop.js");
		const history: AgentMessage[] = [{ role: "user", content: "what is this?" }];
		const result = await runAgentLoop({
			provider,
			model: "mock",
			system: "",
			tools: [createReadTool({})],
			history,
			userMessage: "what is this?",
		});
		expect(result.stopReason).toBe("completed");
		const tr = history.find((m) => m.role === "toolResult");
		if (tr?.role !== "toolResult") throw new Error("no toolResult");
		expect(tr.results[0]?.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: realPng(4, 4).toString("base64"), mimeType: "image/png" },
		]);
		expect(requests[1]?.messages.some((m) => m.role === "toolResult")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Session round-trip: blocks survive JSONL storage and render as notes
// ---------------------------------------------------------------------------

describe("M13 session round-trip", () => {
	it("blocks serialize to JSONL and parse back losslessly", async () => {
		const { createSession } = await import("../src/core/session/manager.js");
		const dir = await mkdtemp(path.join(tmpdir(), "imp-imgsess-"));
		const store = createSession(dir, dir);
		store.appendMessage({
			role: "toolResult",
			results: [
				{
					toolCallId: "t1",
					toolName: "read",
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "QUJD", mimeType: "image/png" },
					],
					isError: false,
				},
			],
		});
		const parsed: AgentMessage[] = [];
		for (const entry of store.getEntries()) {
			if (entry.type === "message") parsed.push(entry.message);
		}
		const tr = parsed.find((m) => m.role === "toolResult");
		if (tr?.role !== "toolResult") throw new Error("no toolResult round-trip");
		expect(tr.results[0]?.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "QUJD", mimeType: "image/png" },
		]);
	});
});

// ---------------------------------------------------------------------------
// Render note
// ---------------------------------------------------------------------------

describe("M13 render note", () => {
	it("tool_end appends the ▪ image suffix (one-line style)", async () => {
		const { Renderer } = await import("../src/render.js");
		const out: string[] = [];
		const renderer = new Renderer({
			write: (t) => out.push(t),
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
		});
		renderer.event({ type: "tool_start", toolCallId: "t1", name: "read", args: { path: "shot.png" } });
		renderer.event({
			type: "tool_end",
			result: {
				toolCallId: "t1",
				toolName: "read",
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: "QUJD", mimeType: "image/png" },
				],
				isError: false,
			},
		});
		const text = out.join("");
		expect(text).toContain("▪ image [image/png, 3 B]");
	});
});

// ---------------------------------------------------------------------------
// zai wrapper rides the same wire (review finding 4)
// ---------------------------------------------------------------------------

describe("M13 zai wire (wrapper)", () => {
	it("glm-5.3-flash: hoisted with the text part; glm-5.3: placeholders", async () => {
		captured.length = 0;
		script = { status: 200, chunks: openaiChunks() };
		// zai.ts wraps this exact factory (name: "zai", zaiToolStream) — driving
		// it here pins the wrapper's vision path without its credential gate.
		const zai = createOpenAICompletionsProvider({ baseUrl, apiKey: "k", name: "zai", zaiToolStream: true });
		await drive(zai, {
			system: "s",
			model: "glm-5.3-flash",
			messages: imageTurn(),
			tools: [],
			maxTokens: 16,
		});
		const messages =
			(captured[0]?.body?.messages as Array<{ role: string; content: unknown }> | undefined) ?? [];
		const hoisted = messages.find((m) => m.role === "user" && Array.isArray(m.content));
		expect(JSON.stringify(hoisted)).toContain("data:image/png;base64,QUJD");
		expect(JSON.stringify(hoisted)).toContain("Attached image(s) from tool result:");

		captured.length = 0;
		script = { status: 200, chunks: openaiChunks() };
		await drive(zai, { system: "s", model: "glm-5.3", messages: imageTurn(), tools: [], maxTokens: 16 });
		const raw = JSON.stringify(captured[0]?.body);
		expect(raw).not.toContain("QUJD");
		expect(raw).toContain("(tool image omitted: model does not support images)");
	});
});

// ---------------------------------------------------------------------------
// compaction: the summarize request never carries image bytes (design §11.8)
// ---------------------------------------------------------------------------

describe("M13 compaction summarizer exclusion", () => {
	it("serializeForSummary renders text only — no base64 leaks", async () => {
		const { serializeForSummary } = await import("../src/core/compaction.js");
		const text = serializeForSummary([
			{
				role: "toolResult",
				results: [
					{
						toolCallId: "t1",
						toolName: "read",
						content: [
							{ type: "text", text: "Read image file [image/png]" },
							{ type: "image", data: "QUJD", mimeType: "image/png" },
						],
						isError: false,
					},
				],
			},
		]);
		expect(text).toContain("Read image file [image/png]");
		expect(text).not.toContain("QUJD");
	});
});
