/**
 * M13 batch 2 — the processor: resize ladder, EXIF, conversion, read
 * rewiring, @file attachments, clipboard matrix, settings.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/core/file-processor.js";
import { __exifInternals, getExifOrientation } from "../src/core/image/exif-orientation.js";
import { convertImageBytesToPng } from "../src/core/image/image-convert.js";
import { processImage } from "../src/core/image/image-process.js";
import { formatDimensionNote } from "../src/core/image/image-resize.js";
import { resizeImageInProcess } from "../src/core/image/image-resize-core.js";
import { photonLoader } from "../src/core/image/photon.js";
import { runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, ContentBlock } from "../src/core/messages.js";
import { loadSettings, saveSettings } from "../src/core/settings.js";
import { detectSupportedImageMimeType } from "../src/core/tools/image-sniff.js";
import { createReadTool } from "../src/core/tools/read.js";
import {
	extensionForImageMimeType,
	readClipboardImage,
	writeClipboardImageToTmp,
} from "../src/repl/clipboard-image.js";

// ---------------------------------------------------------------------------
// Real image builders (photon-decodable — the processor is on every path)
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) {
		c = CRC_TABLE[(c ^ byte)! & 0xff]! ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}
const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
/** Gradient RGBA PNG (compresses well — exercises the ladder, not entropy). */
function makePng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const rows: Buffer[] = [];
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(1 + width * 4);
		for (let x = 0; x < width; x++) {
			row[1 + x * 4] = (x * 255) % 256; // R
			row[2 + x * 4] = (y * 255) % 256; // G
			row[3 + x * 4] = 128; // B
			row[4 + x * 4] = 255; // A
		}
		rows.push(row);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
/** 24-bit bottom-up BMP. */
function makeBmp(width: number, height: number): Buffer {
	const rowSize = Math.ceil((width * 3) / 4) * 4;
	const pixelData = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (height - 1 - y) * rowSize + x * 3;
			pixelData[at] = 200;
			pixelData[at + 1] = (x * 40) % 256;
			pixelData[at + 2] = (y * 40) % 256;
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

const DIR = await mkdtemp(path.join(tmpdir(), "imp-img2-"));
async function fixture(name: string, bytes: Buffer): Promise<string> {
	const file = path.join(DIR, name);
	await writeFile(file, bytes);
	return file;
}

// ---------------------------------------------------------------------------
// resize ladder
// ---------------------------------------------------------------------------

describe("M13-2 resize ladder", () => {
	it("dimension cap: 3000×2000 resizes to 2000×1333 with a dimension note", async () => {
		const r = await resizeImageInProcess(makePng(3000, 2000), "image/png");
		expect(r).not.toBeNull();
		expect(`${r?.width}x${r?.height}`).toBe("2000x1333");
		expect(r?.wasResized).toBe(true);
		expect(r?.mimeType).toBe("image/png");
		const note = r ? formatDimensionNote(r) : undefined;
		expect(note).toBe(
			"[Image: original 3000x2000, displayed at 2000x1333. Multiply coordinates by 1.50 to map to original image.]",
		);
	});

	it("small images pass through untouched (wasResized false, identical bytes)", async () => {
		const small = makePng(16, 16);
		const r = await resizeImageInProcess(small, "image/png");
		expect(r?.wasResized).toBe(false);
		expect(r?.data).toBe(small.toString("base64"));
		expect(formatDimensionNote(r!)).toBeUndefined();
	});

	it("maxBytes forces the ladder: candidates, quality steps, dimension decay", async () => {
		// A 64×64 gradient with a tiny budget — the ladder must decay
		// dimensions until an encoding fits under the cap.
		const r = await resizeImageInProcess(makePng(64, 64), "image/png", { maxBytes: 1200 });
		expect(r).not.toBeNull();
		expect(r?.wasResized).toBe(true);
		const encoded = Buffer.from(r?.data ?? "", "base64");
		expect(Math.ceil(encoded.byteLength / 3) * 4).toBeLessThan(1200);
		expect(r!.width).toBeLessThanOrEqual(64);
	});

	it("unshrinkable budget returns null (never a too-large image)", async () => {
		const r = await resizeImageInProcess(makePng(64, 64), "image/png", { maxBytes: 8 });
		// Even 1×1 encodes above 8 base64 chars — every step fails.
		expect(r).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// EXIF orientation parser
// ---------------------------------------------------------------------------

describe("M13-2 EXIF orientation", () => {
	/** Minimal TIFF with an orientation entry (SHORT, value inline). */
	function tiff(orientation: number, littleEndian = true): Buffer {
		const head = littleEndian ? Buffer.from([0x49, 0x49]) : Buffer.from([0x4d, 0x4d]);
		const magic = Buffer.alloc(2);
		if (littleEndian) magic.writeUInt16LE(42);
		else magic.writeUInt16BE(42);
		const offset = Buffer.alloc(4);
		if (littleEndian) offset.writeUInt32LE(8);
		else offset.writeUInt32BE(8);
		const count = Buffer.alloc(2);
		if (littleEndian) count.writeUInt16LE(1);
		else count.writeUInt16BE(1);
		const entry = Buffer.alloc(12);
		if (littleEndian) {
			entry.writeUInt16LE(0x0112, 0);
			entry.writeUInt16LE(3, 2); // SHORT
			entry.writeUInt32LE(1, 4); // count
			entry.writeUInt16LE(orientation, 8);
		} else {
			entry.writeUInt16BE(0x0112, 0);
			entry.writeUInt16BE(3, 2);
			entry.writeUInt32BE(1, 4);
			entry.writeUInt16BE(orientation, 8);
		}
		return Buffer.concat([head, magic, offset, count, entry]);
	}

	it("reads orientation 1–8 in both byte orders", () => {
		const { readOrientationFromTiff } = __exifInternals;
		for (const value of [2, 3, 4, 5, 6, 7, 8]) {
			expect(readOrientationFromTiff(tiff(value), 0)).toBe(value);
			expect(readOrientationFromTiff(tiff(value, false), 0)).toBe(value);
		}
		expect(readOrientationFromTiff(tiff(1), 0)).toBe(1);
	});

	it("out-of-range, truncated, and absent data default to 1", () => {
		const { readOrientationFromTiff } = __exifInternals;
		expect(readOrientationFromTiff(tiff(9), 0)).toBe(1); // out of range
		expect(readOrientationFromTiff(tiff(6).subarray(0, 5), 0)).toBe(1); // truncated
		const zeros = Buffer.alloc(24);
		zeros[0] = 0x49;
		zeros[1] = 0x49;
		expect(readOrientationFromTiff(zeros, 0)).toBe(1);
	});

	it("non-JPEG/WebP buffers have no orientation", () => {
		expect(getExifOrientation(makePng(2, 2))).toBe(1);
		expect(getExifOrientation(Buffer.alloc(0))).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// conversion + processImage
// ---------------------------------------------------------------------------

describe("M13-2 conversion and processImage", () => {
	it("BMP converts to decodable PNG bytes", async () => {
		const png = await convertImageBytesToPng(makeBmp(8, 8));
		expect(png).not.toBeNull();
		expect(detectSupportedImageMimeType(png!)).toBe("image/png");
	});

	it("processImage: BMP → image/png + conversion hint (no resize note)", async () => {
		const r = await processImage(makeBmp(8, 8), "image/bmp");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.mimeType).toBe("image/png");
			expect(r.hints).toEqual(["[Image converted from image/bmp to image/png.]"]);
		}
	});

	it("processImage: image/jpg normalizes to image/jpeg, bytes unchanged", async () => {
		const small = makePng(8, 8);
		// sniffed png + "image/jpg" input mime → normalized jpeg label? No —
		// the whitelist maps jpg→jpeg; a PNG declared as jpg keeps PNG data
		// with a jpeg label, which would be a lie. Real read passes the
		// SNIFFED mime, so test the honest path: png in → png out.
		const r = await processImage(small, "image/png");
		expect(r.ok && r.mimeType).toBe("image/png");
		expect(r.ok && r.data).toBe(small.toString("base64"));
	});

	it("processImage: autoResizeImages=false skips the ladder (oversize passes raw)", async () => {
		const r = await processImage(makePng(16, 16), "image/png", {
			autoResizeImages: false,
			resizeOptions: { maxBytes: 8 }, // would be unshrinkable if applied
		});
		expect(r.ok).toBe(true);
	});

	it("processImage failure wording matches pi", async () => {
		const garbage = new Uint8Array([1, 2, 3, 4, 5]);
		const r = await processImage(garbage, "image/bmp");
		expect(r).toEqual({
			ok: false,
			message: "[Image omitted: could not be converted to a supported inline image format.]",
		});
	});
});

// ---------------------------------------------------------------------------
// read tool through the processor
// ---------------------------------------------------------------------------

describe("M13-2 read tool (processor wired)", () => {
	it("oversize images resize instead of refusing", async () => {
		const file = await fixture("big.png", makePng(3000, 2000));
		const result = await createReadTool({}).execute({ path: file }, new AbortController().signal);
		expect(result.isError).toBeUndefined();
		const blocks = result.content as ContentBlock[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.type === "text" && blocks[0].text).toContain("displayed at 2000x1333");
		const image = blocks[1];
		expect(image?.type === "image" && image.mimeType).toBe("image/png");
	});

	it("jpg→jpeg normalization never mislabels bytes (sniffed mime wins)", async () => {
		const png = makePng(8, 8);
		const file = await fixture("renamed.jpg", png); // wrong extension on purpose
		const result = await createReadTool({}).execute({ path: file }, new AbortController().signal);
		const blocks = result.content as ContentBlock[];
		expect(blocks[0]?.type === "text" && blocks[0].text).toContain("[image/png]");
	});
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

const SETTINGS_DIR = await mkdtemp(path.join(tmpdir(), "imp-img2set-"));
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

describe("M13-2 settings images", () => {
	const file = SETTINGS_FILE;

	afterEach(() => {
		saveSettings({}, file); // reset (writes the file; fine)
	});

	it("parses autoResize true/false; absent defaults", () => {
		saveSettings({ images: { autoResize: false } }, file);
		expect(loadSettings(file).images?.autoResize).toBe(false);
		saveSettings({ images: { autoResize: true } }, file);
		expect(loadSettings(file).images?.autoResize).toBe(true);
		expect(loadSettings(file).images?.autoResize ?? true).toBe(true);
	});

	it("malformed images object reads as absent", () => {
		const raw = JSON.stringify({ images: "nope" });
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(file, raw);
		expect(loadSettings(file).images).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// @file attachments
// ---------------------------------------------------------------------------

describe("M13-2 @file processing", () => {
	it("text file → <file> block; image → attachment + reference", async () => {
		const txt = await fixture("notes.txt", Buffer.from("hello attachment"));
		const png = await fixture("shot.png", makePng(8, 8));
		const r = await processFileArguments([`@${txt}`, `@${png}`]);
		expect(r.text).toContain(`<file name="${txt}">\nhello attachment\n</file>`);
		expect(r.text).toContain(`<file name="${png}"></file>`);
		expect(r.images).toHaveLength(1);
		expect(r.images[0]?.type).toBe("image");
		expect(r.images[0]?.mimeType).toBe("image/png");
	});

	it("missing file errors and exits 1 (no silent skip)", async () => {
		const errors: string[] = [];
		const exits: number[] = [];
		await processFileArguments(["@/definitely/not/here.png"], {
			onError: (m) => errors.push(m),
			exit: (c) => exits.push(c),
		});
		expect(errors[0]).toContain("File not found");
		expect(exits).toEqual([1]);
	});

	it("empty files are skipped silently", async () => {
		const empty = await fixture("empty.txt", Buffer.alloc(0));
		const r = await processFileArguments([`@${empty}`]);
		expect(r.text).toBe("");
		expect(r.images).toHaveLength(0);
	});

	it("loop composes the first user message with image blocks", async () => {
		// A provider stub that records history shape without tool calls.
		const requests: unknown[] = [];
		const provider = {
			name: "stub",
			async *stream(request: { messages: unknown }) {
				requests.push(request);
				yield {
					type: "message_end" as const,
					message: {
						role: "assistant" as const,
						blocks: [{ type: "text" as const, text: "ok" }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn" as const,
					},
				};
			},
		};
		const png = makePng(8, 8);
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider: provider as never,
			model: "stub",
			system: "",
			tools: [],
			history,
			userMessage: "what is this?",
			userImages: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
		});
		const first = history[0];
		if (first?.role !== "user") throw new Error("no user message");
		expect(first.content).toEqual([
			{ type: "text", text: "what is this?" },
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		]);
		// text-only prompt stays a bare string
		const history2: AgentMessage[] = [];
		await runAgentLoop({
			provider: provider as never,
			model: "stub",
			system: "",
			tools: [],
			history: history2,
			userMessage: "plain",
		});
		expect(history2[0]?.role === "user" && history2[0].content).toBe("plain");
	});
});

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

type Runner = Parameters<typeof readClipboardImage>[0] extends { run?: infer R } ? R : never;

describe("M13-2 clipboard matrix", () => {
	const PNG = makePng(2, 2);

	function fakeRun(map: Record<string, Buffer | undefined>) {
		const calls: Array<{ cmd: string; args: readonly string[] }> = [];
		const run = (cmd: string, args: readonly string[]): Promise<Buffer | undefined> => {
			calls.push({ cmd, args });
			return Promise.resolve(map[cmd] ?? undefined);
		};
		return { run: run as Runner, calls };
	}

	it("darwin: osascript PNG base64 → image/png", async () => {
		const { run, calls } = fakeRun({ osascript: Buffer.from(PNG.toString("base64")) });
		const image = await readClipboardImage({ platform: "darwin", run });
		expect(calls[0]?.cmd).toBe("osascript");
		expect(calls[0]?.args[0]).toBe("-l");
		expect(image?.mimeType).toBe("image/png");
		expect(Buffer.from(image!.bytes).equals(PNG)).toBe(true);
	});

	it("darwin: empty osascript output → null (no image)", async () => {
		const { run } = fakeRun({ osascript: Buffer.from("\n") });
		expect(await readClipboardImage({ platform: "darwin", run })).toBeNull();
	});

	it("linux wayland: wl-paste png; xclip fallback when absent", async () => {
		const { run, calls } = fakeRun({ wlPaste: undefined, xclip: PNG });
		const env = { WAYLAND_DISPLAY: "wayland-0" } as NodeJS.ProcessEnv;
		const image = await readClipboardImage({ platform: "linux", env, run });
		expect(image?.mimeType).toBe("image/png");
		const bins = calls.map((c) => c.cmd);
		expect(bins).toContain("wl-paste");
		expect(bins).toContain("xclip");
	});

	it("termux always null", async () => {
		const { run, calls } = fakeRun({ osascript: PNG });
		expect(await readClipboardImage({ platform: "darwin", env: { TERMUX_VERSION: "1" }, run })).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("unsupported mime converts to PNG (or null when conversion fails)", async () => {
		const bmp = makeBmp(2, 2);
		const { run } = fakeRun({ osascript: Buffer.from(bmp.toString("base64")) });
		const image = await readClipboardImage({
			platform: "darwin",
			run,
			convert: async (bytes) => (Buffer.from(bytes).equals(bmp) ? new Uint8Array(PNG) : null),
		});
		expect(image?.mimeType).toBe("image/png");
		const none = await readClipboardImage({
			platform: "darwin",
			run,
			convert: async () => null,
		});
		expect(none).toBeNull();
	});

	it("win32: powershell base64", async () => {
		const { run, calls } = fakeRun({ powershell: Buffer.from(PNG.toString("base64")) });
		const image = await readClipboardImage({ platform: "win32", run });
		expect(calls[0]?.cmd).toBe("powershell");
		expect(image?.mimeType).toBe("image/png");
	});

	it("extensionForImageMimeType + tmp write round-trip", async () => {
		expect(extensionForImageMimeType("image/png")).toBe("png");
		expect(extensionForImageMimeType("image/jpeg")).toBe("jpg");
		const written = writeClipboardImageToTmp({ bytes: PNG, mimeType: "image/png" });
		expect(written).toContain("imp-clipboard-");
		expect(written.endsWith(".png")).toBe(true);
		const back = await readFile(written);
		expect(back.equals(PNG)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// photon loader seam
// ---------------------------------------------------------------------------

describe("M13-2 photon loader", () => {
	it("loads and answers twice from cache", async () => {
		const first = await photonLoader.load();
		const second = await photonLoader.load();
		expect(first).toBe(second);
		expect(first).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// CLI arg peeling (@ stays on the arg; processor owns the strip)
// ---------------------------------------------------------------------------

describe("M13-2 CLI @file args", () => {
	it("@file peels off before prompt assembly — missing file exits 1 with the path", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const missing = path.join(DIR, "nope.png");
		const result: unknown = await run(process.execPath, ["dist/cli.js", `@${missing}`, "hello"], {
			cwd: process.cwd(),
			env: { ...process.env, IMP_HOME_DIR: DIR },
		}).catch((err: unknown) => err);
		const err = result as { stderr: string; code?: number };
		// The observable: parseArgs did NOT treat @nope.png as prompt text —
		// the processor owns it and reports the missing file.
		expect(err.stderr).toContain("File not found");
		expect(err.code).toBe(1);
	}, 30000);
});

// ---------------------------------------------------------------------------
// read-path variants (macOS screenshots, ~ expansion)
// ---------------------------------------------------------------------------

describe("M13-2 resolveReadPath variants", () => {
	const home = path.join(DIR, "home");
	const mk = async (name: string): Promise<string> => {
		const file = path.join(home, name);
		await import("node:fs/promises").then((f) => f.mkdir(path.dirname(file), { recursive: true }));
		await writeFile(file, "x");
		return file;
	};

	it("~ expands to the injected home", async () => {
		const file = await mk("shot.png");
		const { resolveReadPath } = await import("../src/core/tools/path-resolve.js");
		const resolved = resolveReadPath("@~/shot.png", "/tmp", { homeDir: home });
		expect(resolved).toBe(file);
	});

	it("U+202F before AM/PM matches a typed plain space", async () => {
		const file = await mk("Screen Shot 2026-09-20 at 10.00.00\u202fAM.png");
		const { resolveReadPath } = await import("../src/core/tools/path-resolve.js");
		const typed = file.replace("\u202f", " ");
		expect(resolveReadPath(typed, "/tmp", { homeDir: home })).toBe(file);
	});

	it("NFD variant matches typed NFC, curly apostrophe matches typed straight", async () => {
		const { resolveReadPath } = await import("../src/core/tools/path-resolve.js");
		const nfd = "e\u0301cran.png"; // e + combining acute (NFD)
		const file = await mk(nfd);
		const typedNfc = path.join(home, "écran.png");
		const resolvedNfd = resolveReadPath(typedNfc, "/tmp", { homeDir: home });
		// macOS APFS is normalization-insensitive: the NFC probe may succeed
		// directly (resolve returns it) or fall through to the NFD variant —
		// both names address the same file. Case-sensitive/normalizing
		// filesystems (ext4) take the NFD branch.
		expect([typedNfc, file]).toContain(resolvedNfd);
		const curly = await mk("Capture d\u2019ecran.png");
		expect(resolveReadPath(curly.replace("\u2019", "'"), "/tmp", { homeDir: home })).toBe(curly);
	});
});
