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
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

function baseMime(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

/** pi selectPreferredImageMimeType: preferred order first, then any image/*. */
function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMime(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
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
      const pngType = $.NSBitmapImageFileTypePNG !== undefined ? $.NSBitmapImageFileTypePNG : $.NSPNGFileType;
      const pngData = rep.representationUsingTypeProperties(pngType, $.NSDictionary.dictionary);
      if (!pngData.isNil()) out = pngData.base64EncodedStringWithOptions(0).js;
    }
  }
}
out;`;

const WIN32_PS = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
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
	const list = await run("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (list === undefined) return undefined; // wl-clipboard absent

	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) return null; // offered types carry no image at all

	// --no-newline: byte-exact even on TTY-attached clipboards (pi parity)
	const data = await run("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	return { bytes: new Uint8Array(data), mimeType: baseMime(selectedType) };
}

async function readViaXclip(run: typeof runClipboardCommand): Promise<ClipboardImage | null | undefined> {
	const targets = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets !== undefined) {
		candidateTypes = targets
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = selectPreferredImageMimeType(candidateTypes);
	if (targets !== undefined && !preferred) return null;
	const tryTypes = new Set(
		preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : SUPPORTED_IMAGE_MIME_TYPES,
	);

	for (const mimeType of tryTypes) {
		const data = await run("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data !== undefined && data.length > 0) {
			return { bytes: new Uint8Array(data), mimeType: baseMime(mimeType) };
		}
	}

	return undefined;
}

export function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}
	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

/** WSL fallback (pi parity): Windows screenshots never reach the WSL
 *  clipboard; PowerShell saves the Windows clipboard to a tmp file visible
 *  on both sides via wslpath. */
async function readViaPowerShellWsl(run: typeof runClipboardCommand): Promise<ClipboardImage | null> {
	const tmpFile = join(tmpdir(), `imp-wsl-clip-${randomUUID()}.png`);
	try {
		const winPathResult = await run("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
		if (winPathResult === undefined) return null;
		const winPath = winPathResult.toString("utf-8").trim();
		if (!winPath) return null;

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = await run("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (result === undefined) return null;
		if (result.toString("utf-8").trim() !== "ok") return null;

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) return null;
		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

/** Native Windows: Get-Clipboard → PNG base64 on stdout. */
async function readViaPowerShellNative(
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
		const wsl = isWSL(env);
		if (isWaylandSession(env) || wsl) {
			image = await readViaWlPaste(run);
		}
		if (image === undefined) image = await readViaXclip(run);
		// Only under WSL does the PowerShell fallback make sense (pi parity;
		// review P2-2 — plain Linux never spawns powershell).
		if (!image && wsl) image = (await readViaPowerShellWsl(run)) ?? image;
	} else if (platform === "win32") {
		image = await readViaPowerShellNative(run);
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
