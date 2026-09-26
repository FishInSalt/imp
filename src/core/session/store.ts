import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { firstLine } from "../../format.js";
import { type AgentMessage, contentText, type Usage } from "../messages.js";

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
 *   {"type":"branchSummary","id":<8hex>,"parentId":<id>,"timestamp":<iso>,
 *    "summary":<text>}   #10: written when /tree switches away from a branch
 *   {"type":"session_info","id":<8hex>,"parentId":<id>,"timestamp":<iso>,
 *    "name":<text>}   M16 /name: the branch's display name; the latest
 *    one on the current branch wins, empty clears (pi's session_info)
 *   {"type":"position","leafId":<id|null>}   #10 review: a file-level marker
 *    (NOT a tree node) recording the write position when /fork or /tree
 *    moved it without appending — otherwise a restart landed on the file's
 *    last line, i.e. the ABANDONED branch. Reopen rule: the last tree ENTRY
 *    wins over any earlier position (appends imply their own leaf); a
 *    position only wins when nothing was appended after it.
 */

export interface SessionModel {
	provider: string;
	modelId: string;
}

/** Keep validation local: reading sessions must not load provider runtimes. */
function parseModel(value: unknown, context: string): SessionModel {
	const model = value as Partial<SessionModel> | null;
	if (
		typeof model !== "object" ||
		model === null ||
		!["anthropic", "openai", "openai-codex", "zai", "deepseek"].includes(model.provider ?? "") ||
		typeof model.modelId !== "string" ||
		model.modelId.trim() === ""
	) {
		throw new SessionError(`${context}: invalid session model`);
	}
	return { provider: model.provider as string, modelId: model.modelId };
}

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
	model?: SessionModel;
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

/** #10: an LLM summary of the branch LEFT by a /tree switch, appended at the
 *  new tip — the model keeps the memory of what the abandoned path tried
 *  (pi's BranchSummaryEntry, slimmed). Participates in context as one
 *  framed user message (branchSummaryToMessage); never counted in stats. */
export interface BranchSummaryEntry extends EntryBase {
	type: "branchSummary";
	summary: string;
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

/** #thinking-levels: a level change (pi's ThinkingLevelChangeEntry). Tree
 *  metadata like branch summaries — participates in the tree structure
 *  (parent/leaf) but never in buildContext. The RUNNER restores the
 *  branch's last level on resume (restoreThinkingFromSession); replay
 *  renders messages only, so these entries are audit-visible on disk. */
export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinkingLevelChange";
	thinkingLevel: string;
}

/** M16 /name: the session's display name (pi's SessionInfoEntry, slimmed).
 *  Tree metadata like thinkingLevelChange — participates in the
 *  parent/leaf structure, never in buildContext or stats. The latest one
 *  on the CURRENT branch wins; an empty name explicitly clears it. */
export interface SessionInfoEntry extends EntryBase {
	type: "session_info";
	name: string;
}

/** #tree: a note pinned to another entry for navigation (pi's label entry,
 *  DELIBERATELY different shape — see appendLabelChange). Labels never
 *  advance the leaf and never sit on a content entry's parent chain, so
 *  they cannot orphan subtrees in getTree and need no re-chaining. */
export interface LabelEntry extends EntryBase {
	type: "label";
	/** The entry this label names (does not need to exist yet — tolerated). */
	targetId: string;
	/** The label text; an empty string removes the label (pi parity). */
	label: string;
}

export type SessionEntry =
	| MessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ThinkingLevelChangeEntry
	| SessionInfoEntry
	| LabelEntry;

/** One node of the session tree (#tree): a content entry (label entries
 *  are folded into `label`, never nodes) with its children, oldest first. */
export interface TreeNode {
	entry: SessionEntry;
	children: TreeNode[];
	/** The latest label pinned to this entry (file-level, last write wins). */
	label?: string;
}

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
	} else if (entry.type === "branchSummary") {
		if (typeof entry.summary !== "string") {
			throw new SessionError(`session line ${lineNo}: branchSummary entry missing summary`);
		}
	} else if (entry.type === "thinkingLevelChange") {
		if (typeof entry.thinkingLevel !== "string") {
			throw new SessionError(`session line ${lineNo}: thinkingLevelChange entry missing level`);
		}
	} else if (entry.type === "session_info") {
		if (typeof entry.name !== "string") {
			throw new SessionError(`session line ${lineNo}: session_info entry missing name`);
		}
	} else if (entry.type === "label") {
		if (typeof entry.targetId !== "string" || typeof entry.label !== "string") {
			throw new SessionError(`session line ${lineNo}: label entry missing targetId/label`);
		}
	} else {
		throw new SessionError(`session line ${lineNo}: unknown entry type "${String(entry.type)}"`);
	}
	return entry as SessionEntry;
}

export class SessionStore {
	readonly filePath: string;
	readonly header: SessionHeader;
	private persisted = false;
	private initializationFailed = false;
	private savedModel?: SessionModel;
	private pendingModel?: SessionModel;
	private explicitModelSelection = false;
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	/** Current leaf = id of the last appended entry (tree position). */
	private leafId: string | null = null;
	/** #tree: labels by target entry id (file-level — replay is last-write-wins,
	 *  regardless of which branch the label entry was written on). */
	private labelsById = new Map<string, string>();

	private constructor(filePath: string, header: SessionHeader, entries: SessionEntry[]) {
		this.filePath = filePath;
		this.header = header;
		for (const entry of entries) this.indexEntry(entry);
	}

	private indexEntry(entry: SessionEntry): void {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		// #tree: labels are side-attachments — they never become the write
		// position, so the next content append stays a sibling of the label,
		// never its child (design §3.1, review P1-5).
		if (entry.type === "label") {
			if (entry.label === "") this.labelsById.delete(entry.targetId);
			else this.labelsById.set(entry.targetId, entry.label);
			return;
		}
		this.leafId = entry.id;
	}

	/** Whether this store was successfully written or opened; not a durability guarantee. */
	get isPersisted(): boolean {
		return this.persisted;
	}

	get hasModelSelection(): boolean {
		return this.explicitModelSelection;
	}

	getModel(): SessionModel | undefined {
		const model = this.savedModel ?? this.pendingModel;
		return model === undefined ? undefined : { ...model };
	}

	seedModel(model: SessionModel): void {
		if (this.getModel() === undefined) this.pendingModel = parseModel(model, "seedModel");
	}

	setModel(model: SessionModel): void {
		const next = parseModel(model, "setModel");
		const current = this.getModel();
		if (current?.provider === next.provider && current.modelId === next.modelId) return;
		this.writeRecords(`${JSON.stringify({ type: "session_model", ...next, explicit: true })}\n`);
		this.savedModel = next;
		this.pendingModel = undefined;
		this.explicitModelSelection = true;
	}

	/** Allocate a session identity; the file is created on its first entry. */
	static create(filePath: string, cwd: string, id = randomUUID(), parent?: string): SessionStore {
		const header: SessionHeader = {
			type: "session",
			version: 1,
			id,
			timestamp: new Date().toISOString(),
			cwd,
		};
		if (parent !== undefined) header.parent = parent;
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

		let model = header.model === undefined ? undefined : parseModel(header.model, "session header");
		let explicitModelSelection = false;
		const entries: SessionEntry[] = [];
		let lastEntryIndex = -1;
		let lastPosition: { leafId: string | null; index: number } | null = null;
		for (let i = 1; i < lines.length; i++) {
			const raw = lines[i] as string;
			// Position markers are file-level metadata, not tree nodes (#10
			// review P1-2): recognize them before entry parsing.
			try {
				const probe = JSON.parse(raw) as { type?: unknown; leafId?: unknown };
				if (probe.type === "position") {
					if (probe.leafId === null || typeof probe.leafId === "string") {
						lastPosition = { leafId: probe.leafId, index: i };
					}
					continue;
				}
			} catch {
				// fall through to parseEntryLine for the canonical error report
			}
			try {
				let metadata: { type?: unknown; explicit?: unknown } | null = null;
				try {
					metadata = JSON.parse(raw);
				} catch {
					/* canonical error below */
				}
				if (metadata?.type === "session_model") {
					const next = parseModel(metadata, `session line ${i + 1}`);
					if (typeof metadata.explicit !== "boolean") {
						throw new SessionError(`session line ${i + 1}: invalid session model explicit flag`);
					}
					model = next;
					explicitModelSelection ||= metadata.explicit;
					continue;
				}
				entries.push(parseEntryLine(raw, i + 1));
				lastEntryIndex = i;
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
		const store = new SessionStore(filePath, header, entries);
		store.persisted = true;
		store.savedModel = model;
		store.explicitModelSelection = explicitModelSelection;
		// Reopen rule (#10 review P1-2): an entry appended AFTER the last
		// position implies its own leaf; otherwise the position records where
		// /fork or /tree moved the write head. An id that no longer resolves
		// (corrupt edit) is ignored — the last entry is the safe fallback.
		if (lastPosition !== null && lastPosition.index > lastEntryIndex) {
			const leafId = lastPosition.leafId;
			if (leafId === null || store.byId.has(leafId)) store.leafId = leafId;
		}
		return store;
	}

	private append(entry: SessionEntry): void {
		const seed = this.pendingModel;
		let lines = `${JSON.stringify(entry)}\n`;
		if (seed !== undefined && this.persisted) {
			lines = `${JSON.stringify({ type: "session_model", ...seed, explicit: false })}\n${lines}`;
		}
		this.writeRecords(lines, seed);
		if (seed !== undefined) {
			this.savedModel = seed;
			this.pendingModel = undefined;
		}
		this.indexEntry(entry);
	}

	/** Shared exclusive lazy writer; callers commit memory only after success. */
	private writeRecords(line: string, headerModel?: SessionModel): void {
		if (this.initializationFailed) {
			throw new SessionError(
				`session initialization previously failed: ${this.filePath} — start a new session`,
			);
		}
		if (this.persisted) {
			appendFileSync(this.filePath, line, { encoding: "utf8" });
		} else {
			const header = headerModel === undefined ? this.header : { ...this.header, model: headerModel };
			const initial = `${JSON.stringify(header)}\n${line}`;
			// Exclusive creation must never adopt or overwrite a competing file.
			// An open failure is retryable; after opening, a failed write/close may
			// leave partial bytes. Preserve that artifact and fail closed on retry.
			const fd = openSync(this.filePath, "wx");
			let closeAttempted = false;
			try {
				writeFileSync(fd, initial, { encoding: "utf8" });
				closeAttempted = true;
				closeSync(fd);
			} catch (error) {
				this.initializationFailed = true;
				if (!closeAttempted) {
					try {
						closeSync(fd);
					} catch {
						// Preserve the original write error; never retry an uncertain close.
					}
				}
				throw error;
			}
			this.persisted = true;
			if (headerModel !== undefined) this.header.model = { ...headerModel };
		}
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

	/** M16 /name: append a session_info entry. The name is sanitized by
	 *  the CALLER (commands.ts, which owns the normalization warning);
	 *  the store keeps exactly what it is given. */
	appendSessionName(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: this.nextId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name,
		};
		this.append(entry);
		return entry.id;
	}

	/** The branch's display name: the LATEST session_info entry on the
	 *  current branch, undefined when none exists or the latest is empty
	 *  (an empty name explicitly clears — pi parity). */
	getSessionName(): string | undefined {
		const branch = this.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "session_info") {
				return entry.name.trim() || undefined;
			}
		}
		return undefined;
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinkingLevelChange",
			id: this.nextId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
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

	/** User-message fork points on the CURRENT branch, oldest → newest
	 *  (#10 batch 1): /fork's picker and /fork <n> both index this list. The
	 *  latest user message is included — forking before it re-does the last
	 *  exchange. */
	userForkPoints(): MessageEntry[] {
		return this.getBranch().filter(
			(entry): entry is MessageEntry => entry.type === "message" && entry.message.role === "user",
		);
	}

	/** Fork the tree: move the write position to just BEFORE the given user
	 *  message — the abandoned tail stays in the file (append-only), and
	 *  subsequent appends grow a NEW branch from the fork point. pi's
	 *  boundary rule: fork targets are user messages (conversation seams),
	 *  and the chosen message itself is re-typed on the new branch.
	 *  Returns message counts for the teaching note. */
	forkBefore(entryId: string): { retained: number; abandoned: number } {
		const target = this.byId.get(entryId);
		if (target === undefined || target.type !== "message" || target.message.role !== "user") {
			throw new SessionError(`fork target ${entryId} is not a user message`);
		}
		// Defense: only current-path entries are fork targets (the picker and
		// /fork <n> never offer others — switching to ANOTHER branch's message
		// is /tree's job, not /fork's).
		const onCurrentPath = this.getBranch().some((entry) => entry.id === entryId);
		if (!onCurrentPath) {
			throw new SessionError(`fork target ${entryId} is not on the current branch`);
		}
		const before = this.getBranch().filter((entry) => entry.type === "message").length;
		this.leafId = target.parentId; // null targets the very first message → empty branch
		this.persistPosition(); // review P1-2: the move must survive a restart
		const retained = this.getBranch().filter((entry) => entry.type === "message").length;
		return { retained, abandoned: before - retained };
	}

	/** All OTHER branch tips with their picker metadata (#10 /tree): each
	 *  leaf that is not on the current path, labeled by the first user
	 *  message of its divergent segment, with that segment's message count.
	 *  (#tree: the /tree picker now renders the full tree via getTree();
	 *  this stays as the tests' convenience view of "the other branches".) */
	otherBranchTips(): { id: string; label: string; count: number }[] {
		const currentPathIds = new Set(this.getBranch().map((entry) => entry.id));
		const tips: { id: string; label: string; count: number }[] = [];
		for (const entry of this.entries) {
			if (entry.type === "label") continue; // side-attachment, not a node
			if (this.childrenOf(entry.id).length > 0) continue; // not a tip
			if (currentPathIds.has(entry.id)) continue; // the current branch's own tip
			const { other } = this.splitBranches(entry.id);
			const firstUser = other.find(
				(e): e is MessageEntry => e.type === "message" && e.message.role === "user",
			);
			const first = firstUser?.message;
			// firstLine: a multi-line message can start with a blank (shift+enter)
			// — the label must preview actual content (review F3).
			const label =
				first !== undefined && first.role === "user"
					? firstLine(contentText(first.content))
					: "(no user message)";
			tips.push({
				id: entry.id,
				label,
				count: other.filter((e) => e.type === "message").length,
			});
		}
		return tips;
	}

	/** Split the current path and another branch at their longest common
	 *  PREFIX (the shared trunk) — what each holds beyond it (#10 /tree). */
	splitBranches(otherLeafId: string): { abandoned: SessionEntry[]; other: SessionEntry[] } {
		const current = this.getBranch();
		const other = this.getBranch(otherLeafId);
		let i = 0;
		while (i < current.length && i < other.length && current[i]?.id === other[i]?.id) i++;
		return { abandoned: current.slice(i), other: other.slice(i) };
	}

	/** Move the write position to ANY entry — or to null, i.e. before the
	 *  first entry, the re-edit-the-opening-move position (#tree; the
	 *  generalization of the old tip-only switchBranch, which this replaces).
	 *  The current branch is abandoned in place (append-only; its entries
	 *  stay); the next append grows a new child of the target. Interior
	 *  targets are legal — their existing children just become siblings of
	 *  the new branch. Persisted via the position marker (reopen rule). */
	branchTo(entryId: string | null): void {
		if (entryId !== null) {
			const target = this.byId.get(entryId);
			if (target === undefined) throw new SessionError(`branch target ${entryId} not found`);
			if (target.type === "label") throw new SessionError("labels are not branch targets");
			if (entryId === this.leafId) throw new SessionError("already at that position");
		}
		this.leafId = entryId;
		this.persistPosition(); // review P1-2: the move must survive a restart
	}

	/** The full session tree (#tree): content entries (labels folded into
	 *  `label`, never nodes) with children oldest-first. A well-formed
	 *  session has one root; orphans (broken parent chain, self-parent) are
	 *  returned as additional roots (pi's rules). Iterative — deep trees
	 *  must not overflow the stack. */
	getTree(): TreeNode[] {
		const nodeMap = new Map<string, TreeNode>();
		const roots: TreeNode[] = [];
		for (const entry of this.entries) {
			if (entry.type === "label") continue; // folded into .label, not a node
			const label = this.labelsById.get(entry.id);
			nodeMap.set(entry.id, label === undefined ? { entry, children: [] } : { entry, children: [], label });
		}
		for (const entry of this.entries) {
			if (entry.type === "label") continue;
			const node = nodeMap.get(entry.id)!; // set in the pass above
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node); // pi's self-parent rule: a self-referencing entry is a root
				continue;
			}
			const parent = nodeMap.get(entry.parentId);
			if (parent === undefined)
				roots.push(node); // orphan → root
			else parent.children.push(node);
		}
		const stack = [...roots]; // iterative sort — deep trees must not overflow
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
			stack.push(...node.children);
		}
		return roots;
	}

	/** Pin a navigation label onto an entry (#tree, format-first batch A:
	 *  produced by tests/fixtures now, edited via l-key in batch B). A
	 *  side-attachment — never advances the leaf, never enters a content
	 *  chain (design §3.1, review P1-5), so branching cannot lose it.
	 *  An empty/undefined label REMOVES the note (pi parity). */
	appendLabelChange(targetId: string, label: string | undefined): string {
		const entry: LabelEntry = {
			type: "label",
			id: this.nextId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label: label ?? "",
		};
		this.append(entry); // indexEntry's label branch advances NO leaf
		return entry.id;
	}

	/** The latest label pinned to an entry, if any (#tree). */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/** Append the file-level position marker (#10 review P1-2). Best-effort:
	 *  an unwritable file keeps the move in memory for this session. */
	private persistPosition(): void {
		// Moving a pristine session to null is a no-op, not a first record.
		if (!this.persisted) return;
		try {
			appendFileSync(this.filePath, `${JSON.stringify({ type: "position", leafId: this.leafId })}\n`, {
				encoding: "utf8",
			});
		} catch {
			// position is an optimization for restarts, not a correctness gate
		}
	}

	/** Children index for tip detection (rebuilt per call — branch counts
	 *  stay tiny; the append-only file means no invalidation is needed).
	 *  Labels are side-attachments, never children (#tree). */
	private childrenOf(id: string): SessionEntry[] {
		return this.entries.filter((entry) => entry.type !== "label" && entry.parentId === id);
	}

	/** Append a branch summary at the current leaf (#10): the memory of the
	 *  branch just left, carried into the new one's context. */
	appendBranchSummary(summary: string): string {
		const entry: BranchSummaryEntry = {
			type: "branchSummary",
			id: this.nextId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
		};
		this.append(entry);
		return entry.id;
	}

	/** Entries from root to the given leaf (default: current leaf). */
	getBranch(leafId?: string | null): SessionEntry[] {
		const target = leafId === undefined ? this.leafId : leafId;
		if (target === null) return [];
		// push + reverse: repeated unshift shifts the whole accumulated array
		// per step (O(n²) slots for depth n) — linear instead.
		const reversed: SessionEntry[] = [];
		let current: SessionEntry | undefined = this.byId.get(target);
		while (current) {
			reversed.push(current);
			current = current.parentId === null ? undefined : this.byId.get(current.parentId);
		}
		const path = reversed.reverse();
		// The walk must terminate at a root (parentId === null). A parentId that
		// is not in the file exits the loop early with a truncated path — its
		// head could be any role (e.g. a toolResult), which would break resume.
		// NOTE: the old guard `path[path.length - 1]?.id !== target` was dead code
		// — target is always the first element after reversing.
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
	 *
	 * compactionBoundary (#compaction-ux F1): the index of the first message
	 * AFTER the compaction splice point (1 + retainedTail.length when
	 * compacted, otherwise 0). Messages at index >= boundary belong to the
	 * CURRENT context shape; earlier assistant usage reports describe a
	 * pre-compaction context and must not anchor the token estimate.
	 */
	buildContext(): { messages: AgentMessage[]; compacted: boolean; compactionBoundary: number } {
		const branch = this.getBranch();
		let lastCompactionIndex = -1;
		for (let i = 0; i < branch.length; i++) {
			if (branch[i]?.type === "compaction") lastCompactionIndex = i;
		}

		const messages: AgentMessage[] = [];
		let compacted = false;
		let compactionBoundary = 0;
		if (lastCompactionIndex === -1) {
			for (const entry of branch) {
				if (entry.type === "message") messages.push(entry.message);
				else if (entry.type === "branchSummary") messages.push(branchSummaryToMessage(entry.summary));
			}
		} else {
			compacted = true;
			const compaction = branch[lastCompactionIndex] as CompactionEntry;
			messages.push(summaryToMessage(compaction.summary));
			messages.push(...compaction.retainedTail);
			compactionBoundary = 1 + compaction.retainedTail.length;
			for (let i = lastCompactionIndex + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry?.type === "message") messages.push(entry.message);
				else if (entry?.type === "branchSummary") messages.push(branchSummaryToMessage(entry.summary));
			}
		}
		return { messages, compacted, compactionBoundary };
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

/** Marker prefix identifying the framed BRANCH summary message below
 *  (replay.ts matches on this — keep it exported so the two cannot drift
 *  silently). */
export const BRANCH_MARK = "[Branch summary —";

/** #10: a branch summary as the model sees it — a framed user message, the
 *  same convention as compaction's summaryToMessage (replay detects the
 *  mark and renders the body dim instead of echoing a `> ` line). */
export function branchSummaryToMessage(summary: string): AgentMessage {
	return {
		role: "user",
		content: `${BRANCH_MARK} this context was explored on a branch you later left; keep its lessons. Treat this as established context, not as a new request.]\n\n${summary}`,
	};
}

/** Marker prefix identifying the framed COMPACTON summary message
 *  (replay.ts matches on this — same anti-drift contract as BRANCH_MARK). */
export const SUMMARY_MARK = "[Conversation summary —";

/** The summary is replayed into context as a framed user message. */
export function summaryToMessage(summary: string): AgentMessage {
	return {
		role: "user",
		content: `${SUMMARY_MARK} earlier messages were compacted to save context space. Treat this as established context, not as a new request.]\n\n${summary}`,
	};
}
