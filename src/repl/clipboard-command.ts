/**
 * Clipboard command runner — ported from pi
 * `coding-agent/src/utils/clipboard-command.ts`. Spawns a clipboard helper
 * with a hard timeout and byte cap; clipboard binaries can daemonize, so
 * they get no output pipes to retain.
 */

import { spawn } from "node:child_process";

/** Undefined means the command failed; a buffer is a successful result. */
export function runClipboardCommand(
	command: string,
	args: readonly string[],
	options?: { input?: string; timeoutMs?: number; maxBufferBytes?: number },
): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			// stderr ignored: a child writing >64KB to an undrained pipe would
			// block until the timeout kill (review P2-6; pi uses "ignore").
			stdio: ["pipe", options?.input === undefined ? "pipe" : "ignore", "ignore"],
			windowsHide: true,
		});
		child.stdin?.on("error", () => undefined); // EPIPE when the child exits early
		const chunks: Buffer[] = [];
		let length = 0;
		let settled = false;
		const finish = (result: Buffer | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const abort = (): void => {
			child.kill("SIGKILL");
			child.stdout?.destroy();
			child.stdin?.destroy();
			finish(undefined);
		};
		const timer = setTimeout(abort, options?.timeoutMs ?? 3000);
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			if (!settled) finish(code === 0 ? Buffer.concat(chunks, length) : undefined);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			length += chunk.length;
			if (length > (options?.maxBufferBytes ?? 50 * 1024 * 1024)) abort();
			else chunks.push(chunk);
		});
		if (options?.input !== undefined) {
			child.stdin?.end(options.input);
		} else {
			child.stdin?.end();
		}
	});
}
