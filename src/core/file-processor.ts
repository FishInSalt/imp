/**
 * @file CLI argument processing — M13 batch 2, ported from pi
 * `cli/file-processor.ts`. `imp @shot.png what is this` turns `@…`
 * positionals into prompt text (`<file name="…">` blocks) plus image
 * attachments for the first user message. Images run through the same
 * processor the read tool uses; text files embed inline (BOM-stripped).
 */

import { access, readFile, stat } from "node:fs/promises";
import { processImage } from "./image/image-process.js";
import type { ImageBlock } from "./messages.js";
import { resolveReadPath } from "./tools/path-resolve.js";
import { detectSupportedImageMimeType } from "./tools/image-sniff.js";

export interface ProcessedFiles {
	text: string;
	images: ImageBlock[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Hermetic tests / custom messaging. */
	onError?: (message: string) => void;
	/** Hermetic tests: skip the exit. */
	exit?: (code: number) => void;
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Process @file arguments into text content and image attachments. */
export async function processFileArguments(
	fileArgs: string[],
	options?: ProcessFileOptions,
): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const error = options?.onError ?? ((message: string) => console.error(message));
	const exit = options?.exit ?? ((code: number) => process.exit(code));
	let text = "";
	const images: ImageBlock[] = [];

	for (const fileArg of fileArgs) {
		// pi resolveReadPath parity: ~ expansion, Unicode-space normalization,
		// and the macOS screenshot variants (U+202F AM/PM, NFD, U+2019).
		const absolutePath = resolveReadPath(fileArg, process.cwd());

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			error(`Error: File not found: ${absolutePath}`);
			exit(1);
			continue;
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const bytes = await readFile(absolutePath);
		const mimeType = detectSupportedImageMimeType(bytes);

		if (mimeType) {
			// Handle image file
			const processed = await processImage(bytes, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			images.push({ type: "image", data: processed.data, mimeType: processed.mimeType });

			// Add text reference to image with optional processing hints
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				const content = stripBom(bytes.toString("utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				error(`Error: Could not read file ${absolutePath}: ${message}`);
				exit(1);
			}
		}
	}

	return { text, images };
}
