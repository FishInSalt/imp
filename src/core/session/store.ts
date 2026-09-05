import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentMessage, Usage } from "../messages.js";

/**
 * JSONL session storage — a message tree in a file.
 *
 * Line 1 is a session header; every following line is a tree entry linked to
 * its parent by `parentId`. The file is append-only: branching never rewrites
 * history, it just grows the tree, and the current position ("leaf") is the
 * last non-leaf entry appended. Context = walk from leaf to root.
 *
 * Format (adapted from pi's session format v3, heavily slimmed for imp):
 *   {"type":"session","version":1,"id":<uuid>,"timestamp":<iso>,"cwd":<path>}
 *   {"type":"message","id":<8hex>,"parentId":<id|null>,"timestamp":<iso>,"message":{...}}
 *   {"type":"compaction","id":<8hex>,"parentId":<id>,"timestamp":<iso>,
 *    "summary":<text>,"retainedTail":[...],"tokensBefore":<n>}
 */

export interface SessionHeader {
	type: "session";
	version: 1;
	id: string;
	timestamp: string;
	cwd: string;
	/** Session that spawned this one (subagent transcripts, M5 design §5).
	 *  Absent on top-level sessions — its presence identifies a child.
	 *  Readers ignore unknown header fields, so the format stays version 1. */
	parent?: string;
}

interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	/** Messages kept verbatim after compaction — a self-contained checkpoint. */
	retainedTail: AgentMessage[];
	/** Context size (estimated tokens) right before compaction. */
	tokensBefore: number;
	/** Usage of the LLM call that produced the summary, if known. */
	usage?: Usage;
}

export type SessionEntry = MessageEntry | CompactionEntry;

export interface SessionStats {
	messageCount: number;
	turnCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export function newEntryId(): string {
	// 8 hex chars; collisions within a session are handled by the caller retrying.
	return Array.from({ length: 4 }, () =>
		Math.floor(Math.random() * 0x10000)
			.toString(16)
			.padStart(4, "0"),
	).join("");
}

export class SessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionError";
	}
}

/** Parse one JSONL line into an entry, with file/line context in errors. */
function parseEntryLine(line: string, lineNo: number): SessionEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (err) {
		throw new SessionError(
			`session line ${lineNo}: invalid JSON (${err instanceof Error ? err.message : err})`,
		);
	}
	const entry = parsed as Partial<SessionEntry> & { message?: unknown; type?: unknown };
	if (typeof entry.type !== "string") throw new SessionError(`session line ${lineNo}: missing entry type`);
	if (typeof entry.id !== "string" || entry.id === "") {
		throw new SessionError(`session line ${lineNo}: missing entry id`);
	}
	if (entry.parentId !== null && typeof entry.parentId !== "string") {
		throw new SessionError(`session line ${lineNo}: invalid parentId`);
	}
	if (typeof entry.timestamp !== "string") {
		throw new SessionError(`session line ${lineNo}: missing timestamp`);
	}
	if (entry.type === "message") {
		const msg = entry.message as { role?: unknown } | undefined;
		if (typeof msg !== "object" || msg === null || typeof msg.role !== "string") {
			throw new SessionError(`session line ${lineNo}: message entry has no valid message.role`);
		}
	} else if (entry.type === "compaction") {
		if (typeof entry.summary !== "string") {
			throw new SessionError(`session line ${lineNo}: compaction entry missing summary`);
		}
	} else {
		throw new SessionError(`session line ${lineNo}: unknown entry type "${String(entry.type)}"`);
	}
	return entry as SessionEntry;
}

export class SessionStore {
	readonly filePath: string;
	readonly header: SessionHeader;
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	/** Current leaf = id of the last appended entry (tree position). */
	private leafId: string | null = null;

	private constructor(filePath: string, header: SessionHeader, entries: SessionEntry[]) {
		this.filePath = filePath;
		this.header = header;
		for (const entry of entries) this.indexEntry(entry);
	}

	private indexEntry(entry: SessionEntry): void {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
	}

	static create(filePath: string, cwd: string, id = randomUUID(), parent?: string): SessionStore {
		const header: SessionHeader = {
			type: "session",
			version: 1,
			id,
			timestamp: new Date().toISOString(),
			cwd,
		};
		if (parent !== undefined) header.parent = parent;
		writeFileSync(filePath, `${JSON.stringify(header)}\n`, { encoding: "utf8" });
		return new SessionStore(filePath, header, []);
	}

	static open(filePath: string): SessionStore {
		if (!existsSync(filePath)) throw new SessionError(`session file not found: ${filePath}`);
		const lines = readFileSync(filePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "");
		if (lines.length === 0) throw new SessionError(`empty session file: ${filePath}`);

		let header: SessionHeader;
		try {
			header = JSON.parse(lines[0] as string) as SessionHeader;
		} catch {
			throw new SessionError(`session file ${filePath}: first line is not valid JSON`);
		}
		if (header.type !== "session" || header.version !== 1 || typeof header.id !== "string") {
			throw new SessionError(`session file ${filePath}: missing or unsupported session header`);
		}

		const entries: SessionEntry[] = [];
		for (let i = 1; i < lines.length; i++) {
			try {
				entries.push(parseEntryLine(lines[i] as string, i + 1));
			} catch (err) {
				// A torn FINAL line (crash mid-append) must not hide the whole session;
				// interior corruption is still fatal — something is structurally wrong.
				if (i === lines.length - 1 && err instanceof SessionError) {
					process.stderr.write(`imp: dropping torn final line in ${filePath}\n`);
					break;
				}
				throw err;
			}
		}
		return new SessionStore(filePath, header, entries);
	}

	private append(entry: SessionEntry): void {
		appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
		this.indexEntry(entry);
	}

	private nextId(): string {
		for (let i = 0; i < 100; i++) {
			const id = newEntryId();
			if (!this.byId.has(id)) return id;
		}
		return randomUUID().slice(0, 8);
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getEntries(): readonly SessionEntry[] {
		return this.entries;
	}

	appendMessage(message: AgentMessage): string {
		const entry: MessageEntry = {
			type: "message",
			id: this.nextId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this.append(entry);
		return entry.id;
	}

	appendCompaction(
		summary: string,
		retainedTail: AgentMessage[],
		tokensBefore: number,
		usage?: Usage,
	): string {
		const entry: CompactionEntry = {
			type: "compaction",
			id: this.nextId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			retainedTail,
			tokensBefore,
			usage,
		};
		this.append(entry);
		return entry.id;
	}

	/** Entries from root to the given leaf (default: current leaf). */
	getBranch(leafId?: string | null): SessionEntry[] {
		const target = leafId === undefined ? this.leafId : leafId;
		if (target === null) return [];
		const path: SessionEntry[] = [];
		let current: SessionEntry | undefined = this.byId.get(target);
		while (current) {
			path.unshift(current);
			current = current.parentId === null ? undefined : this.byId.get(current.parentId);
		}
		// The walk must terminate at a root (parentId === null). A parentId that
		// is not in the file exits the loop early with a truncated path — its
		// head could be any role (e.g. a toolResult), which would break resume.
		// NOTE: the old guard `path[path.length - 1]?.id !== target` was dead code
		// — target is always the last element after unshifting.
		const head = path[0];
		if (!head) throw new SessionError(`entry ${target} not found`);
		if (head.parentId !== null) {
			throw new SessionError(`broken parentId chain at entry ${target}`);
		}
		return path;
	}

	/**
	 * Build the LLM context from the current branch, honoring the latest
	 * compaction on the path: everything before it collapses into one summary
	 * message; its retainedTail plus all entries after it stay verbatim.
	 */
	buildContext(): { messages: AgentMessage[]; compacted: boolean } {
		const branch = this.getBranch();
		let lastCompactionIndex = -1;
		for (let i = 0; i < branch.length; i++) {
			if (branch[i]?.type === "compaction") lastCompactionIndex = i;
		}

		const messages: AgentMessage[] = [];
		let compacted = false;
		if (lastCompactionIndex === -1) {
			for (const entry of branch) {
				if (entry.type === "message") messages.push(entry.message);
			}
		} else {
			compacted = true;
			const compaction = branch[lastCompactionIndex] as CompactionEntry;
			messages.push(summaryToMessage(compaction.summary));
			messages.push(...compaction.retainedTail);
			for (let i = lastCompactionIndex + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry?.type === "message") messages.push(entry.message);
			}
		}
		return { messages, compacted };
	}

	/**
	 * Aggregates over the current branch (root to leaf), not the whole
	 * file: abandoned branches keep their entries in the append-only tree,
	 * but only entries reachable from the current leaf count. Compaction
	 * entries are not messages and never count. Linear sessions (a single
	 * branch) get exactly the file totals.
	 */
	stats(): SessionStats {
		const stats: SessionStats = {
			messageCount: 0,
			turnCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		for (const entry of this.getBranch()) {
			if (entry.type !== "message") continue;
			stats.messageCount += 1;
			const msg = entry.message;
			if (msg.role === "assistant") {
				stats.turnCount += 1;
				stats.inputTokens += msg.usage.inputTokens;
				stats.outputTokens += msg.usage.outputTokens;
				stats.cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
				stats.cacheWriteTokens += msg.usage.cacheWriteTokens ?? 0;
			}
		}
		return stats;
	}
}

/** Marker prefix identifying the framed summary message below (replay.ts
 *  matches on this — keep it exported so the two cannot drift silently). */
export const SUMMARY_MARK = "[Conversation summary —";

/** The summary is replayed into context as a framed user message. */
export function summaryToMessage(summary: string): AgentMessage {
	return {
		role: "user",
		content: `${SUMMARY_MARK} earlier messages were compacted to save context space. Treat this as established context, not as a new request.]\n\n${summary}`,
	};
}
