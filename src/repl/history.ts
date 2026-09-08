/**
 * Cross-session input history (M11 #4) — the bash `~/.zsh_history` analog.
 *
 * One global JSONL file under the imp home: every accepted input line is
 * appended (consecutive duplicates collapse), and the shell seeds the
 * editor's up-arrow recall from its tail on start. Sessions already persist
 * everything they receive; this file only makes RECALL survive restarts.
 *
 * Failure discipline: history is a convenience — every fs operation is
 * best-effort and silent. A broken or unwritable store must never take the
 * REPL down with it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Compact the file once it passes 2× the recall horizon, keeping the newest half. */
const MAX_LINES = 2000;
/** How many lines the shell seeds into the editor (matches the in-memory cap of 100 plus headroom). */
const RECALL_LIMIT = 100;

export function historyFilePath(home: string): string {
	return `${home}/.imp/history.jsonl`;
}

/** Newest-last, JSON lines, consecutive duplicates collapsed, corrupt lines skipped. */
export function loadInputHistory(path: string, limit = RECALL_LIMIT): string[] {
	try {
		if (!existsSync(path)) return [];
		const lines = readFileSync(path, "utf8").split("\n");
		const out: string[] = [];
		for (const line of lines) {
			if (line.trim() === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // a torn final write or foreign content — skip, keep the rest
			}
			if (typeof parsed !== "string" || parsed === "") continue;
			if (out[out.length - 1] === parsed) continue;
			out.push(parsed);
		}
		return out.slice(-limit);
	} catch {
		return [];
	}
}

/** Append one accepted line. Best-effort: create the directory on demand,
 *  skip consecutive duplicates, and compact past MAX_LINES. */
export function appendInputHistory(path: string, text: string): void {
	if (text === "") return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const existing = loadInputHistory(path, MAX_LINES);
		if (existing[existing.length - 1] === text) return; // consecutive duplicate
		// Fast path: a single append — the concurrent-session race window is
		// one line, not the whole file (review P2; trust.json's lock remains
		// the stricter precedent for data that must not lose records).
		if (existing.length < MAX_LINES) {
			appendFileSync(path, `${JSON.stringify(text)}\n`);
			return;
		}
		const kept = [...existing, text].slice(-MAX_LINES);
		writeFileSync(path, `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`);
	} catch {
		// unwritable home, disk full — recall for this session still works
	}
}

/** Test seam: build the file content the writer would produce. */
export function serializeHistory(lines: readonly string[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n");
}
