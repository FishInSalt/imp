/**
 * Clipboard image reading — M13 batch 2. pi reads the clipboard through
 * pi-tui native bindings (prebuilt .node) with xclip/wl-paste fallbacks;
 * imp has no native bindings, so this port is command-based on every
 * platform (design §14.5, divergence D8):
 *
 *   darwin  — osascript JXA ObjC bridge: NSPasteboard PNG, TIFF→PNG via
 *             NSBitmapImageRep; emits base64 on stdout (no permission
 *             prompt, no native module).
 *   linux   — wl-paste --type image/png (Wayland/WSL-g) or
 *             xclip -selection clipboard -t image/png -o (X11).
 *   win32   — PowerShell Get-Clipboard -Format Image → PNG base64.
 *
 * Unsupported-but-decodable formats convert to PNG through photon before
 * returning. The result is bytes on disk + a path, never an inline block:
 * the tmp file keeps the message layer untouched (pi: same shape).
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertImageBytesToPng } from "../core/image/image-convert.js";
import { detectSupportedImageMimeType } from "../core/tools/image-sniff.js";
import { runClipboardCommand } from "./clipboard-command.js";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function isSupportedImageMimeType(mimeType: string): boolean {
	switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
		case "image/png":
		case "image/jpeg":
		case "image/jpg":
		case "image/webp":
		case "image/gif":
			return true;
		default:
			return false;
	}
}

/** macOS: NSPasteboard PNG first, TIFF converted to PNG. Emits base64. */
const DARWIN_JXA = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
let out = '';
const png = pb.dataForType($.NSPasteboardTypePNG);
if (!png.isNil()) {
  out = png.base64EncodedStringWithOptions(0).js;
} else {
  const tiff = pb.dataForType($.NSPasteboardTypeTIFF);
  if (!tiff.isNil()) {
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (!rep.isNil()) {
      const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
      if (!pngData.isNil()) out = pngData.base64EncodedStringWithOptions(0).js;
    }
  }
}
out;`;

const WIN32_PS = `
Add-Type -AssemblyName System.Windows.Forms;
$img = [System.Windows.Forms.Clipboard]::GetImage();
if ($null -ne $img) {
  $ms = New-Object System.IO.MemoryStream;
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
  [Convert]::ToBase64String($ms.ToArray())
}`;

export interface ReadClipboardImageOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Test seam: replace the process spawner. */
	run?: typeof runClipboardCommand;
	/** Test seam: replace the PNG converter. */
	convert?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
}

async function readViaDarwin(run: typeof runClipboardCommand): Promise<ClipboardImage | null | undefined> {
	const out = await run("osascript", ["-l", "JavaScript", "-e", DARWIN_JXA]);
	if (out === undefined) return undefined; // osascript missing/failed
	const base64 = out.toString("utf-8").trim();
	if (base64 === "") return null; // ran fine, no image on the pasteboard
	const bytes = new Uint8Array(Buffer.from(base64, "base64"));
	if (bytes.length === 0) return null;
	return { bytes, mimeType: detectSupportedImageMimeType(bytes) ?? "application/octet-stream" };
}

async function readViaWlPaste(run: typeof runClipboardCommand): Promise<ClipboardImage | null | undefined> {
	const out = await run("wl-paste", ["--type", "image/png"]);
	if (out === undefined) return undefined; // not installed or no Wayland
	if (out.length === 0) return null;
	return { bytes: new Uint8Array(out), mimeType: "image/png" };
}

async function readViaXclip(run: typeof runClipboardCommand): Promise<ClipboardImage | null | undefined> {
	const out = await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
	if (out === undefined) return undefined;
	if (out.length === 0) return null;
	return { bytes: new Uint8Array(out), mimeType: "image/png" };
}

async function readViaPowerShell(
	run: typeof runClipboardCommand,
): Promise<ClipboardImage | null | undefined> {
	const out = await run("powershell", ["-NoProfile", "-STA", "-Command", WIN32_PS], {
		timeoutMs: 5000,
	});
	if (out === undefined) return undefined;
	const base64 = out.toString("utf-8").trim();
	if (base64 === "") return null;
	const bytes = new Uint8Array(Buffer.from(base64, "base64"));
	if (bytes.length === 0) return null;
	return { bytes, mimeType: "image/png" };
}

/**
 * Read an image from the system clipboard. Null = no image (or unusable);
 * undefined = the platform reader itself is unavailable.
 */
export async function readClipboardImage(
	options?: ReadClipboardImageOptions,
): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;
	const run = options?.run ?? runClipboardCommand;
	const convert = options?.convert ?? convertImageBytesToPng;

	if (env.TERMUX_VERSION) {
		return null; // pi parity: Termux has no image clipboard
	}

	let image: ClipboardImage | null | undefined;

	if (platform === "darwin") {
		image = await readViaDarwin(run);
	} else if (platform === "linux") {
		const wayland = isWaylandSession(env);
		if (wayland) {
			image = await readViaWlPaste(run);
			if (image === undefined) image = await readViaXclip(run);
		} else {
			image = await readViaXclip(run);
			if (image === undefined) image = await readViaWlPaste(run);
		}
		if (image === undefined || image === null) image = (await readViaPowerShell(run)) ?? image;
	} else if (platform === "win32") {
		image = await readViaPowerShell(run);
	} else {
		return null;
	}

	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g. Windows DIB wrapped as BMP) to PNG.
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convert(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}

/**
 * Persist a clipboard image to a tmp file and return its path — the Ctrl+V
 * flow inserts the path into the editor; the model reads the file like any
 * other attachment (the message layer never sees clipboard bytes).
 */
export function writeClipboardImageToTmp(image: ClipboardImage): string {
	const ext = extensionForImageMimeType(image.mimeType) ?? "png";
	const filePath = join(tmpdir(), `imp-clipboard-${randomUUID()}.${ext}`);
	writeFileSync(filePath, Buffer.from(image.bytes));
	return filePath;
}
