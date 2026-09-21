/**
 * Clipboard text writing — M16 `/copy`. Ported from pi
 * `coding-agent/src/utils/clipboard.ts` (copyToClipboard), with imp's
 * divergence D8: no native bindings, commands only, plus pi's OSC 52
 * escape as the last resort (what makes /copy work over SSH).
 *
 * The write seam is injectable so tests never spawn pbcopy.
 */

import { runClipboardCommand } from "./clipboard-command.js";

/** pi's cap: terminals reject giant OSC 52 payloads. */
const MAX_OSC52_ENCODED_LENGTH = 100_000;

export interface CopyToClipboardOptions {
	/** Where the OSC 52 escape goes (default: process.stdout). */
	write?: (data: string) => void;
	/** Env for platform detection (default: process.env). */
	env?: NodeJS.ProcessEnv;
}

function emitOsc52(text: string, write: (data: string) => void): boolean {
	const encoded = Buffer.from(text, "utf8").toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
	write(`\x1B]52;c;${encoded}\x07`);
	return true;
}

/** Copy text to the system clipboard. Throws when every writer failed. */
export async function copyToClipboard(text: string, options: CopyToClipboardOptions = {}): Promise<void> {
	const write = options.write ?? ((data: string) => process.stdout.write(data));
	const env = options.env ?? process.env;
	const platform = process.platform;

	const commands: [string, string[]][] = [];
	if (platform === "darwin") commands.push(["pbcopy", []]);
	else if (platform === "win32") commands.push(["clip", []]);
	else {
		if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
		if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
		if (env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
		}
	}
	for (const [command, args] of commands) {
		if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 })) !== undefined) {
			return;
		}
	}
	// No command worked (or none existed — headless linux without X): the
	// OSC 52 escape lets the USER's terminal set its own clipboard, which
	// is the only path that works over SSH (pi parity).
	// TUI safety (M16 review P2-6): this writes to fd 1, the same stream
	// pi-tui frames go through — Node serializes same-stream writes, and
	// the sequence is non-printing and consumed atomically up to BEL, so
	// it cannot corrupt a differential-rendered frame. That holds only
	// while the TUI keeps using fd 1; a future frame-sink change must
	// revisit this seam.
	if (!emitOsc52(text, write)) {
		throw new Error(
			"no clipboard writer available (text too long for OSC 52 and no clipboard command succeeded)",
		);
	}
}
