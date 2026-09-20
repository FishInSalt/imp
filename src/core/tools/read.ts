import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { processImage } from "../image/image-process.js";
import type { ContentBlock } from "../messages.js";
import { detectSupportedImageMimeType } from "./image-sniff.js";
import { resolveReadPath } from "./path-resolve.js";
import type { Tool } from "./types.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB
/** Inline image size cap (M13 §3), on the BASE64-ENCODED payload (pi
 *  parity — image-resize-core computes ceil(n/3)*4): Anthropic rejects
 *  images over 5 MB encoded; 4.5 MB leaves headroom. Without a resizer
 *  (batch 2), oversized images become a teaching note — never a rejected
 *  request. */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export interface ReadToolOptions {
	cwd?: string;
	/** Live vision capability of the ACTIVE model (runner getter — /model
	 *  can switch mid-session). Absent → no non-vision note (the request-
	 *  assembly downgrade still protects the wire). */
	modelSupportsVision?: () => boolean;
	/** M13 batch 2: image pipeline switches (settings.images.autoResize). */
	imageProcessing?: { autoResize?: boolean };
}

export function createReadTool(options: ReadToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "read",
		description:
			"Read the contents of a text file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. " +
			`For text files, output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB ` +
			`(whichever hits first); the truncation note tells you how to continue reading. Use offset/limit for large files.`,
		parameters: readSchema,
		async execute(args, signal) {
			const requested = String(args.path ?? "");
			if (requested.trim() === "") {
				return { output: "Error: no path given", isError: true };
			}
			// pi resolveReadPath parity (review P1-1): ~ expansion, Unicode-space
			// normalization, and the macOS screenshot name variants — the read
			// tool is the flagship consumer of hand-typed image paths.
			const absolute = resolveReadPath(requested, cwd);

			let bytes: Buffer;
			try {
				bytes = await readFile(absolute, { signal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { output: `Error reading ${requested}: ${message}`, isError: true };
			}

			// Image path (M13 §3): magic bytes decide — never the extension.
			const mimeType = detectSupportedImageMimeType(bytes);
			if (mimeType !== undefined) {
				const nonVisionNote =
					options.modelSupportsVision !== undefined && !options.modelSupportsVision()
						? "\n[Current model does not support images. The image will be omitted from this request.]"
						: "";
				// Batch 2: the processor owns everything (pi coding-agent
				// read.ts:112 parity) — normalization (jpg→jpeg, BMP→PNG, EXIF
				// baked in), then the resize ladder. With autoResize off the
				// original bytes ship (conversion still happens), but oversize
				// files still refuse (the batch-1 teaching error) so a request
				// is never rejected upstream.
				const autoResize = options.imageProcessing?.autoResize ?? true;
				const processed = await processImage(bytes, mimeType, { autoResizeImages: autoResize });
				if (!processed.ok) {
					return {
						output: `Read image file [${mimeType}]\n${processed.message}${nonVisionNote}`,
					};
				}
				if (!autoResize) {
					// The wire carries base64 (4/3 inflation) — cap the encoded
					// size, not the raw bytes (review: raw-4.5MB encodes to 6MB
					// > the 5MB API limit).
					const encodedBytes = Buffer.byteLength(processed.data, "utf-8");
					if (encodedBytes > MAX_IMAGE_BYTES) {
						const mb = (encodedBytes / (1024 * 1024)).toFixed(1);
						return {
							output:
								`Read image file [${mimeType}]\n` +
								`[Image omitted: ${mb} MB encoded exceeds the 4.5 MB inline limit. Resize it ` +
								"(e.g. `sips -Z 2000 <file>` on macOS, `magick <file> -resize 2000x2000` via ImageMagick) " +
								"and read again, or enable images.autoResize.]" +
								nonVisionNote,
						};
					}
				}
				const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
				const content: ContentBlock[] = [
					{ type: "text", text: `Read image file [${processed.mimeType}]${hints}${nonVisionNote}` },
					{ type: "image", data: processed.data, mimeType: processed.mimeType },
				];
				return {
					output: `Read image file [${processed.mimeType}]${hints}${nonVisionNote}`,
					content,
				};
			}

			// Cheap binary detection: NUL byte in the first 8KB.
			const probe = bytes.subarray(0, 8192);
			if (probe.includes(0)) {
				return {
					output: `Error: ${requested} looks like a binary file; the read tool only supports text.`,
					isError: true,
				};
			}

			const allLines = new TextDecoder().decode(bytes).split("\n");
			const totalFileLines = allLines.length;

			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && (!Number.isFinite(offset) || offset < 1)) {
				return { output: `Error: offset must be a 1-indexed line number, got ${offset}`, isError: true };
			}
			if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
				return { output: `Error: limit must be a positive number of lines, got ${limit}`, isError: true };
			}

			const startIdx = offset !== undefined ? offset - 1 : 0;
			if (startIdx >= allLines.length) {
				return {
					output: `Error: offset ${offset} is beyond the end of the file (${totalFileLines} lines total)`,
					isError: true,
				};
			}

			const startDisplay = startIdx + 1;
			const endIdx = limit !== undefined ? Math.min(startIdx + limit, allLines.length) : allLines.length;

			// Apply hard truncation, then explain exactly how to continue.
			let lines = allLines.slice(startIdx, endIdx);
			if (lines.length > MAX_LINES) {
				lines = lines.slice(0, MAX_LINES);
			}
			let selected = lines.join("\n");
			let truncatedByBytes = false;
			if (Buffer.byteLength(selected) > MAX_BYTES) {
				selected = Buffer.from(selected).subarray(0, MAX_BYTES).toString("utf8");
				truncatedByBytes = true;
			}

			const shownLines = selected.split("\n").length;
			const endDisplay = startDisplay + shownLines - 1;
			const notes: string[] = [];
			if (shownLines < endIdx - startIdx) {
				notes.push(
					truncatedByBytes
						? `[Showing lines ${startDisplay}-${endDisplay} of ${totalFileLines} (${MAX_BYTES / 1024}KB limit). Use offset=${endDisplay + 1} to continue.]`
						: `[Showing lines ${startDisplay}-${endDisplay} of ${totalFileLines} (${MAX_LINES} line limit). Use offset=${endDisplay + 1} to continue.]`,
				);
			} else if (endIdx < allLines.length) {
				const remaining = allLines.length - endIdx;
				notes.push(`[${remaining} more lines in file. Use offset=${endIdx + 1} to continue.]`);
			}

			const output = notes.length > 0 ? `${selected}\n\n${notes.join("\n")}` : selected;
			return { output, isError: false };
		},
	};
}
