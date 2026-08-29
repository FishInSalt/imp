/**
 * Shared output helpers — plain string formatting plus minimal ANSI wrappers.
 * Extracted from cli.ts so the runner, the REPL, and print mode format
 * identically.
 */

export const VERSION = "0.1.0";

export function dim(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[2m${text}\x1b[0m` : text;
}

export function red(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[31m${text}\x1b[0m` : text;
}

/** First non-empty line of `text`, truncated to `max` chars with an ellipsis. */
export function firstLine(text: string, max = 160): string {
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** One-line tool argument summary: bash renders `$ <command>`, others compact JSON. */
export function summarizeArgs(name: string, args: unknown): string {
	if (name === "bash") {
		const cmd = (args as { command?: string })?.command;
		return cmd !== undefined ? `$ ${cmd}` : JSON.stringify(args);
	}
	const json = JSON.stringify(args) ?? "";
	return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/** 1234 -> "1.2k"; 567 -> "567". */
export function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
