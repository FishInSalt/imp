import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { MAX_BYTES } from "../constants.js";
import { logicalLines, tailStart } from "./output-text.js";
import { bashPresentation } from "./presentation.js";
import type { Tool, ToolExecuteResult } from "./types.js";

const MAX_LINES = 500;
const TAIL_KEEP_BYTES = 262144;
const FULL_KEEP_BYTES = 10485760;
const KILL_GRACE_MS = 2000;
const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds; the command is killed when it expires (optional)" }),
	),
});
export interface BashToolOptions {
	cwd?: string;
}

class StreamState {
	// Fixed stores avoid retaining views of large incoming chunks or unbounded chunk lists.
	full = Buffer.alloc(FULL_KEEP_BYTES);
	data = Buffer.alloc(TAIL_KEEP_BYTES);
	used = 0;
	fullUsed = 0;
	totalBytes = 0;
	partial = false;
	append(chunk: Buffer): void {
		this.totalBytes += chunk.length;
		this.fullUsed += chunk.copy(
			this.full,
			this.fullUsed,
			0,
			Math.min(chunk.length, FULL_KEEP_BYTES - this.fullUsed),
		);
		const drop = Math.max(0, this.used + chunk.length - TAIL_KEEP_BYTES);
		if (drop > 0) {
			const previous = drop <= this.used ? this.data[drop - 1] : chunk[drop - this.used - 1];
			this.partial = previous !== 10;
		}
		if (chunk.length >= TAIL_KEEP_BYTES) {
			chunk.copy(this.data, 0, chunk.length - TAIL_KEEP_BYTES);
			this.used = TAIL_KEEP_BYTES;
		} else {
			if (drop > 0) {
				this.data.copyWithin(0, drop, this.used);
				this.used -= drop;
			}
			this.used += chunk.copy(this.data, this.used);
		}
	}
	get capped(): boolean {
		return this.totalBytes > this.fullUsed;
	}
}

function preview(state: StreamState) {
	const raw = state.data.subarray(0, state.used);
	const start = state.totalBytes > state.used ? tailStart(raw, 0) : 0;
	let text = raw.subarray(start).toString("utf8");
	let truncated = state.totalBytes > state.used || start > 0;
	let partial = state.partial;
	const lines = logicalLines(text);
	if (lines.length > MAX_LINES) {
		text = lines.slice(-MAX_LINES).join("\n") + (text.endsWith("\n") ? "\n" : "");
		truncated = true;
		partial = false;
	}
	const bytes = Buffer.from(text);
	if (bytes.length > MAX_BYTES) {
		const cut = tailStart(bytes, bytes.length - MAX_BYTES);
		partial = cut < bytes.length && bytes[cut - 1] !== 10;
		text = bytes.subarray(cut).toString("utf8");
		truncated = true;
	}
	return { text, truncated, partial: partial && text !== "" };
}

export function createBashTool(options: BashToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "bash",
		presentation: bashPresentation,
		promptSnippet:
			"run shell commands — builds, tests, git; anything without a dedicated tool. Never interactive.",
		description: `Execute a bash command in the working directory (${cwd}) and return stdout/stderr. Output is truncated per stream to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever hits first). Set a timeout in seconds for long-running commands. Avoid interactive commands (they hang until timeout).`,
		parameters: bashSchema,
		async execute(args, signal): Promise<ToolExecuteResult> {
			const command = String(args.command ?? "");
			if (command.trim() === "") return { output: "Error: empty command", isError: true };
			const timeoutSec = args.timeout as number | undefined;
			if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0))
				return {
					output: `Error: invalid timeout ${timeoutSec}; must be a positive number of seconds`,
					isError: true,
				};
			if (signal.aborted)
				return { output: "Error: command aborted by user. Partial output:\n(no output)", isError: true };
			return new Promise((resolve) => {
				const child = spawn("/bin/bash", ["-c", command], { cwd, env: { ...process.env, IMP: "1" } });
				const stdout = new StreamState(),
					stderr = new StreamState();
				let timedOut = false,
					aborted = false,
					settled = false,
					stopping = false;
				let escalation: ReturnType<typeof setTimeout> | undefined;
				const stop = () => {
					if (settled || stopping) return;
					stopping = true;
					child.kill("SIGTERM");
					escalation = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
					escalation.unref();
				};
				const timer =
					timeoutSec === undefined
						? undefined
						: setTimeout(() => {
								timedOut = true;
								stop();
							}, timeoutSec * 1000);
				const onAbort = () => {
					aborted = true;
					stop();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				const settle = () => {
					if (settled) return false;
					settled = true;
					clearTimeout(timer);
					clearTimeout(escalation);
					signal.removeEventListener("abort", onAbort);
					return true;
				};
				child.stdout.on("data", (chunk: Buffer) => {
					if (!settled) stdout.append(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => {
					if (!settled) stderr.append(chunk);
				});
				child.on("error", (err) => {
					if (settle()) resolve({ output: `Error: failed to spawn command: ${err.message}`, isError: true });
				});
				child.on("close", async (code, closeSignal) => {
					if (!settle()) return;
					const error = timedOut
						? `command timed out after ${timeoutSec}s and was killed`
						: aborted
							? "command aborted by user"
							: closeSignal
								? `command terminated by signal ${closeSignal}`
								: code === null
									? "command ended without an exit status"
									: undefined;
					const output = await formatOutput(stdout, stderr, command, error, code ?? undefined);
					resolve(
						error
							? { output: `Error: ${error}. Partial output:\n${output}`, isError: true }
							: { output, isError: false, exitCode: code ?? undefined },
					);
				});
			});
		},
	};
}

async function formatOutput(
	stdout: StreamState,
	stderr: StreamState,
	command: string,
	interruption?: string,
	exitCode?: number,
): Promise<string> {
	const sections: string[] = [];
	const out = preview(stdout),
		err = preview(stderr);
	for (const [name, state, shown] of [
		["stdout", stdout, out],
		["stderr", stderr, err],
	] as const) {
		if (state.totalBytes > 0) sections.push(`${name}:\n${shown.text}`);
		if (shown.partial) sections.push(`[${name} preview starts within a line.]`);
	}
	if (stdout.totalBytes === 0 && stderr.totalBytes === 0) sections.push("(no output)");
	if (!interruption && exitCode !== undefined && exitCode !== 0) sections.push(`Exit code: ${exitCode}`);
	if (out.truncated || err.truncated) {
		const file = path.join(tmpdir(), `imp-output-${randomUUID()}.log`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let owned = false;
		try {
			handle = await open(file, "wx");
			owned = true;
			await handle.writeFile(`$ ${command}\n[stdout]\n`);
			await handle.writeFile(stdout.full.subarray(0, stdout.fullUsed));
			await handle.writeFile("\n[stderr]\n");
			await handle.writeFile(stderr.full.subarray(0, stderr.fullUsed));
			await handle.writeFile("\n");
			for (const [name, state] of [
				["stdout", stdout],
				["stderr", stderr],
			] as const) {
				if (state.capped)
					await handle.writeFile(
						`[${name} artifact incomplete: retained first ${state.fullUsed} of ${state.totalBytes} observed bytes (10485760-byte per-stream limit).]\n`,
					);
			}
			if (interruption) await handle.writeFile(`[command interrupted: ${interruption}.]\n`);
			await handle.close();
			handle = undefined;
			const capped = stdout.capped || stderr.capped;
			const qualifier = capped
				? `${interruption ? "command interrupted; " : ""}artifact prefix capped; per-stream limit 10485760 bytes`
				: "command interrupted; all observed bytes retained";
			const middle =
				capped || interruption
					? `Partial output saved to ${file} (${qualifier})`
					: `Full output saved to ${file}`;
			sections.push(
				`[output truncated: only the tail is shown above. ${middle} — read it with the read tool if you need more (tip: pipe through head/tail or narrow the grep to keep output small)]`,
			);
		} catch {
			await handle?.close().catch(() => {});
			if (owned) await unlink(file).catch(() => {});
			sections.push(
				"[output truncated: only the tail is shown; saving the output artifact failed (tip: pipe through head/tail or narrow the grep to keep output small)]",
			);
		}
	}
	return sections.join("\n\n");
}
