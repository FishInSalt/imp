import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Structured run log — the debugging lifeline. One JSONL file per run under
 * ~/.imp/logs/, one JSON object per line:
 *
 *   { t: ISO timestamp, type: "llm_request" | "message_end" | "tool_start" | ... , ...payload }
 *
 * Disabled with IMP_LOG=0. Streams/deltas are not recorded (too noisy); full
 * tool outputs and final assistant messages are.
 */
export interface RunLogger {
	enabled: boolean;
	log(type: string, data?: Record<string, unknown>): void;
	close(): void;
}

const noopLogger: RunLogger = {
	enabled: false,
	log() {},
	close() {},
};

export function timestampedName(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
		`-${process.pid}`
	);
}

export async function createRunLogger(options: {
	cwd: string;
	argv: string[];
	home?: string;
}): Promise<RunLogger> {
	if (process.env.IMP_LOG === "0") return noopLogger;

	const home = options.home ?? os.homedir();
	const dir = path.join(home, ".imp", "logs");
	const file = path.join(dir, `${timestampedName()}.jsonl`);

	try {
		await mkdir(dir, { recursive: true });
	} catch {
		return noopLogger; // can't create the log dir — degrade silently
	}

	const write = (line: string) => {
		void appendFile(file, line).catch(() => {});
	};

	write(
		JSON.stringify({ t: new Date().toISOString(), type: "run_start", cwd: options.cwd, argv: options.argv }) + "\n",
	);

	return {
		enabled: true,
		log(type, data = {}) {
			write(JSON.stringify({ t: new Date().toISOString(), type, ...data }) + "\n");
		},
		close() {
			// appendFile is already queued; nothing to flush explicitly.
		},
	};
}
