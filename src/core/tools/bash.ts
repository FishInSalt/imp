import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { Tool, ToolExecuteResult } from "./types.js";

const MAX_LINES = 500;
const MAX_BYTES = 50 * 1024; // 50KB
/** Rolling tail cap per stream so runaway output (`yes`, fork bombs) can't eat memory. */
const TAIL_KEEP_BYTES = 256 * 1024;
/** Hard cap on the full-output buffer written to the truncation temp file. */
const FULL_KEEP_BYTES = 10 * 1024 * 1024;
/** Grace period after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds; the command is killed when it expires (optional)" }),
	),
});

export interface BashToolOptions {
	cwd?: string;
}

interface StreamState {
	data: string;
	totalBytes: number;
	/** Full output (up to FULL_KEEP_BYTES) kept for the truncation temp file. */
	full: string;
	fullCapped: boolean;
}

function newState(): StreamState {
	return { data: "", totalBytes: 0, full: "", fullCapped: false };
}

function appendChunk(state: StreamState, chunk: string): void {
	state.totalBytes += chunk.length;
	state.data += chunk;
	if (state.data.length > TAIL_KEEP_BYTES) {
		state.data = state.data.slice(-TAIL_KEEP_BYTES);
	}
	if (state.full.length < FULL_KEEP_BYTES) {
		state.full += chunk;
		if (state.full.length > FULL_KEEP_BYTES) {
			state.full = state.full.slice(0, FULL_KEEP_BYTES);
			state.fullCapped = true;
		}
	}
}

/** Keep the tail (errors usually live at the end) and note what was dropped. */
function truncateOutput(text: string): { text: string; truncated: boolean } {
	let lines = text.split("\n");
	let truncated = false;
	if (lines.length > MAX_LINES) {
		lines = lines.slice(-MAX_LINES);
		truncated = true;
	}
	let out = lines.join("\n");
	if (Buffer.byteLength(out) > MAX_BYTES) {
		const slice = Buffer.from(out);
		out = slice.subarray(slice.length - MAX_BYTES).toString("utf8");
		truncated = true;
	}
	return { text: out, truncated };
}

export function createBashTool(options: BashToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "bash",
		description:
			`Execute a bash command in the working directory (${cwd}) and return stdout/stderr. ` +
			`Output is truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever hits first). ` +
			`Set a timeout in seconds for long-running commands. Avoid interactive commands (they hang until timeout).`,
		parameters: bashSchema,
		async execute(args, signal): Promise<ToolExecuteResult> {
			const command = String(args.command ?? "");
			if (command.trim() === "") {
				return { output: "Error: empty command", isError: true };
			}
			const timeoutSec = args.timeout as number | undefined;
			if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
				return {
					output: `Error: invalid timeout ${timeoutSec}; must be a positive number of seconds`,
					isError: true,
				};
			}

			return new Promise<ToolExecuteResult>((resolve) => {
				const child = spawn("/bin/bash", ["-c", command], {
					cwd,
					env: { ...process.env, IMP: "1" },
				});

				const stdout = newState();
				const stderr = newState();
				let timedOut = false;
				let aborted = false;
				let settled = false;

				const timer =
					timeoutSec !== undefined
						? setTimeout(() => {
								timedOut = true;
								child.kill("SIGTERM");
								setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
							}, timeoutSec * 1000)
						: undefined;

				const onAbort = () => {
					aborted = true;
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
				};
				signal.addEventListener("abort", onAbort, { once: true });

				const finish = async (result: ToolExecuteResult): Promise<void> => {
					if (settled) return;
					settled = true;
					if (timer !== undefined) clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					resolve(result);
				};

				child.stdout.on("data", (chunk: Buffer) => appendChunk(stdout, chunk.toString("utf8")));
				child.stderr.on("data", (chunk: Buffer) => appendChunk(stderr, chunk.toString("utf8")));
				child.on("error", (err) => {
					finish({ output: `Error: failed to spawn command: ${err.message}`, isError: true });
				});
				child.on("close", async (code) => {
					if (timedOut) {
						finish({
							output: `Error: command timed out after ${timeoutSec}s and was killed. Partial output:\n${await formatOutput(stdout, stderr, command)}`,
							isError: true,
						});
						return;
					}
					if (aborted) {
						finish({
							output: `Error: command aborted by user. Partial output:\n${await formatOutput(stdout, stderr, command)}`,
							isError: true,
						});
						return;
					}
					const output = await formatOutput(stdout, stderr, command, code ?? undefined);
					finish({ output, isError: false });
				});
			});
		},
	};
}

async function formatOutput(
	stdout: StreamState,
	stderr: StreamState,
	command: string,
	exitCode?: number,
): Promise<string> {
	const sections: string[] = [];
	const out = truncateOutput(stdout.data);
	if (out.text.trim() !== "") {
		sections.push(`stdout:\n${out.text.trimEnd()}`);
	}
	const err = truncateOutput(stderr.data);
	if (err.text.trim() !== "") {
		sections.push(`stderr:\n${err.text.trimEnd()}`);
	}
	if (sections.length === 0) {
		sections.push("(no output)");
	}
	if (exitCode !== undefined && exitCode !== 0) {
		sections.push(`Exit code: ${exitCode}`);
	}
	if (
		out.truncated ||
		err.truncated ||
		stdout.totalBytes > TAIL_KEEP_BYTES ||
		stderr.totalBytes > TAIL_KEEP_BYTES
	) {
		// Park the full output in a temp file so the model can read what was cut.
		try {
			const full =
				`$ ${command}\n` +
				`[stdout]\n${stdout.full}\n[stderr]\n${stderr.full}\n` +
				(stdout.fullCapped || stderr.fullCapped ? "[full output itself capped at 10MB]\n" : "");
			const file = path.join(tmpdir(), `imp-output-${Date.now()}-${process.pid}.log`);
			await writeFile(file, full, "utf8");
			sections.push(
				`[output truncated: only the tail is shown above. Full output saved to ${file} — read it with the read tool if you need more]`,
			);
		} catch {
			sections.push("[output truncated: only the tail is shown; saving the full output failed]");
		}
	}
	return sections.join("\n\n");
}
