import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SessionError, type SessionHeader, type SessionStats, SessionStore } from "./store.js";

/**
 * Session discovery: where files live, listing, and `--continue`/`--resume`.
 *
 * Layout (mirrors pi): ~/.imp/sessions/<cwd-with-slashes-dashed>/<timestamp>-<uuid>.jsonl
 */

export function sessionsDirFor(cwd: string, baseDir?: string): string {
	const base = baseDir ?? path.join(homedir(), ".imp", "sessions");
	// Double existing dashes so "-" is an unambiguous path separator: /w/a-b and
	// /w/a/b must not map to the same directory.
	const safe = cwd
		.replace(/^[/\\]/, "")
		.replace(/-/g, "--")
		.replace(/[/\\:]/g, "-");
	return path.join(base, safe);
}

export interface SessionInfo {
	/** Session UUID (from header) — what --resume accepts. */
	id: string;
	filePath: string;
	/** File modification time — newest first in list(). */
	modified: Date;
	createdAt: string;
	cwd: string;
	messageCount: number;
	turnCount: number;
	/** First user message text, as a display title. */
	title: string;
}

function fileTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Create a new session file for `cwd`. */
export function createSession(cwd: string, baseDir?: string): SessionStore {
	const dir = sessionsDirFor(cwd, baseDir);
	mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${fileTimestamp()}-${randomUUID()}.jsonl`);
	return SessionStore.create(filePath, cwd);
}

/**
 * Create a child session file (subagents, M5 design §5): same naming scheme
 * and directory, but under `children/`, with the header linked to the parent
 * by id. The subdirectory keeps children out of listSessions/resolveSession
 * scans (a flat `.jsonl` read) — resume stays parent-only by construction.
 */
export function createChildSession(parent: SessionStore, baseDir?: string): SessionStore {
	const dir = path.join(sessionsDirFor(parent.header.cwd, baseDir), "children");
	mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${fileTimestamp()}-${randomUUID()}.jsonl`);
	return SessionStore.create(filePath, parent.header.cwd, undefined, parent.header.id);
}

/** Cheap header + title scan of one session file (reads the whole file; files are small). */
function inspectSessionFile(filePath: string): SessionInfo | null {
	let store: SessionStore;
	let stats: SessionStats;
	try {
		store = SessionStore.open(filePath);
		// stats() walks the branch and throws on a broken parent chain — such
		// files are skipped like unreadable ones, not fatal to the listing.
		stats = store.stats();
	} catch {
		return null; // unreadable/corrupt files are skipped, not fatal
	}
	const header: SessionHeader = store.header;
	let title = "(empty session)";
	for (const entry of store.getEntries()) {
		if (entry.type === "message" && entry.message.role === "user") {
			const first = entry.message.content.split("\n").find((l) => l.trim() !== "") ?? "";
			title = first.slice(0, 80);
			break;
		}
	}
	return {
		id: header.id,
		filePath,
		modified: statSync(filePath).mtime,
		createdAt: header.timestamp,
		cwd: header.cwd,
		messageCount: stats.messageCount,
		turnCount: stats.turnCount,
		title,
	};
}

/** List sessions for a cwd, newest first. */
export function listSessions(cwd: string, baseDir?: string): SessionInfo[] {
	const dir = sessionsDirFor(cwd, baseDir);
	if (!existsSync(dir)) return [];
	const infos: SessionInfo[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const info = inspectSessionFile(path.join(dir, name));
		if (info) infos.push(info);
	}
	infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return infos;
}

export interface ResolveSessionOptions {
	continueRecent?: boolean;
	/** Session UUID, unique prefix, or file name (with or without .jsonl). */
	resume?: string;
	baseDir?: string;
}

/** Id/prefix/filename matching for --resume. */
function matches(wanted: string, info: SessionInfo): boolean {
	const fileName = path.basename(info.filePath);
	return (
		info.id === wanted || info.id.startsWith(wanted) || fileName === wanted || fileName === `${wanted}.jsonl`
	);
}

export class SessionNotFoundError extends SessionError {}

/**
 * Resolve which session to use:
 *   --resume <id>   -> that session (error if not found or ambiguous)
 *   --continue      -> most recent session for cwd, or null if none exists
 *   neither         -> null (caller creates a new one)
 */
export function resolveSession(cwd: string, options: ResolveSessionOptions): SessionStore | null {
	if (options.resume !== undefined) {
		const wanted = options.resume;
		const sessions = listSessions(cwd, options.baseDir);
		const found = sessions.filter((s) => matches(wanted, s));
		if (found.length === 0) {
			throw new SessionNotFoundError(
				`no session matching "${wanted}" in ${sessionsDirFor(cwd, options.baseDir)} — run /sessions in the REPL to list them`,
			);
		}
		if (found.length > 1) {
			throw new SessionNotFoundError(
				`"${wanted}" matches ${found.length} sessions (${found
					.slice(0, 3)
					.map((s) => s.id.slice(0, 8))
					.join(", ")}…) — use more characters`,
			);
		}
		return SessionStore.open((found[0] as SessionInfo).filePath);
	}
	if (options.continueRecent) {
		const [latest] = listSessions(cwd, options.baseDir);
		return latest ? SessionStore.open(latest.filePath) : null;
	}
	return null;
}
