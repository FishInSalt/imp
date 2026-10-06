import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { type ChildModelBinding, isModelBinding } from "./child-model.js";
import { type SessionEntry, type SessionHeader, SessionStore } from "./session/store.js";
import { collectTaskRecords, type TaskRecordStatus, taskRecordsInEntry } from "./task-record.js";
import { probeWorktreeIdentity } from "./worktree.js";

/**
 * SA-06 design (docs/sa-06-child-launch-record-design.md): the versioned
 * launch record persisted in a CHILD session header, plus the managed lookup
 * and the continuation validation SA-07 consumes.
 *
 * One source of truth per fact: this module carries creation-time facts;
 * SA-03's TaskRecord (read here via collectTaskRecords) carries terminal
 * facts; validation combines the two and never guesses across them. Nothing
 * here can weaken permission rules — the record cannot express a permission.
 */

export const CHILD_LAUNCH_VERSION = 1;

export type LaunchExtensionOrigin = "cli" | "project" | "global";

/** Identity of one loaded extension module (SA-06 §5.3): the entry file's
 *  canonical path and content hash. Import-graph hashing is out of scope —
 *  a changed transitive import is a documented, tested limit. */
export interface ExtensionModuleIdentity {
	name: string;
	origin: LaunchExtensionOrigin;
	path: string;
	sha256: string;
}

export interface ExtensionContextIdentity {
	id: string;
	sha256: string;
}

/** Raw assembly inputs the runner retains (hashed by the builder here — a
 *  single hashing authority keeps launch and validation bit-identical). */
export interface LaunchContextFile {
	path: string;
	content: string;
}

export interface LaunchPromptFile {
	kind: "override" | "append";
	path: string;
	text: string;
}

export interface LaunchExtensionContext {
	id: string;
	text: string;
}

export interface LaunchEnvironmentFacts {
	inkVersion: string;
	systemText: string;
	contextFiles: LaunchContextFile[];
	promptFiles: LaunchPromptFile[];
	extensions: ExtensionModuleIdentity[];
	extensionContexts: LaunchExtensionContext[];
}

export interface ChildLaunchWorktree {
	repoRoot: string;
	baseline: string;
	path: string;
	branch: string;
	/** SA-01 creation reflog snapshot, when capturable — a rewrite check that
	 *  survives the child's own commits (newest-first `reflog show`: the
	 *  snapshot must stay the listing's oldest TAIL). */
	creationReflog?: string[];
}

export interface ChildLaunchToolEntry {
	name: string;
	mcpServer?: string;
}

export interface ChildLaunchRecord {
	version: 1;
	parentSessionId: string;
	childId: string;
	inkVersion: string;
	agent?: { name: string; source: string; roleSha256: string };
	model: ChildModelBinding;
	cwd: string;
	worktree?: ChildLaunchWorktree;
	tools: ChildLaunchToolEntry[];
	system: {
		sha256: string;
		contextFiles: Array<{ path: string; sha256: string }>;
		promptFiles: Array<{ kind: "override" | "append"; path: string; sha256: string }>;
		extensionContexts: Array<{ id: string; sha256: string }>;
	};
	extensions: ExtensionModuleIdentity[];
}

export interface ChildLaunchBuildInput {
	parentSessionId: string;
	childId: string;
	inkVersion: string;
	agent?: { name: string; system: string; source: string };
	model: ChildModelBinding;
	cwd: string;
	worktree?: {
		repoRoot: string;
		baseline: string;
		path: string;
		branch: string;
		creationReflog?: readonly string[];
	};
	tools: ReadonlyArray<{ name: string; mcpServer?: string }>;
	systemText: string;
	contextFiles: readonly LaunchContextFile[];
	promptFiles: readonly LaunchPromptFile[];
	extensionContexts: readonly LaunchExtensionContext[];
	extensions: readonly ExtensionModuleIdentity[];
}

export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * L6 normalization: exactly the `- Date: YYYY-MM-DD` line is replaced before
 * hashing the assembled system text. The date is the one line that
 * legitimately changes between attempts; every other byte stays significant.
 */
export function normalizeSystemText(text: string): string {
	return text.replace(/^- Date: \d{4}-\d{2}-\d{2}$/gm, "- Date: <normalized>");
}

/** Assemble a record from explicit runtime facts. Pure; no throw paths; every
 *  field is a scalar or an array of plain objects of scalars by construction. */
export function buildChildLaunch(input: ChildLaunchBuildInput): ChildLaunchRecord {
	const record: ChildLaunchRecord = {
		version: CHILD_LAUNCH_VERSION,
		parentSessionId: input.parentSessionId,
		childId: input.childId,
		inkVersion: input.inkVersion,
		model: { ...input.model },
		cwd: input.cwd,
		tools: input.tools
			.map((tool) =>
				tool.mcpServer === undefined ? { name: tool.name } : { name: tool.name, mcpServer: tool.mcpServer },
			)
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
		system: {
			sha256: sha256Hex(normalizeSystemText(input.systemText)),
			contextFiles: input.contextFiles.map((file) => ({ path: file.path, sha256: sha256Hex(file.content) })),
			promptFiles: input.promptFiles.map((file) => ({
				kind: file.kind,
				path: file.path,
				sha256: sha256Hex(file.text),
			})),
			extensionContexts: input.extensionContexts.map((section) => ({
				id: section.id,
				sha256: sha256Hex(section.text),
			})),
		},
		extensions: input.extensions.map((extension) => ({ ...extension })),
	};
	if (input.agent !== undefined) {
		record.agent = {
			name: input.agent.name,
			source: input.agent.source,
			roleSha256: sha256Hex(input.agent.system),
		};
	}
	if (input.worktree !== undefined) {
		record.worktree = {
			repoRoot: input.worktree.repoRoot,
			baseline: input.worktree.baseline,
			path: input.worktree.path,
			branch: input.worktree.branch,
			...(input.worktree.creationReflog === undefined
				? {}
				: { creationReflog: [...input.worktree.creationReflog] }),
		};
	}
	return record;
}

// --- parse -----------------------------------------------------------------

export type ChildLaunchParse =
	| { ok: true; launch: ChildLaunchRecord }
	| { ok: false; reason: "missing" | "invalid" };

export function parseChildLaunch(value: unknown): ChildLaunchParse {
	if (value === undefined || value === null) return { ok: false, reason: "missing" };
	if (!isRecord(value)) return { ok: false, reason: "invalid" };
	const r = value;
	if (r.version !== CHILD_LAUNCH_VERSION) return { ok: false, reason: "invalid" };
	if (!isName(r.parentSessionId) || !isName(r.childId)) {
		return { ok: false, reason: "invalid" };
	}
	// Presence is an own property: a present `inkVersion` must be a nonempty
	// string (no fallback); the legacy `impVersion` is consulted only when the
	// new key is absent; carrying both names requires equal values.
	const hasInk = Object.hasOwn(r, "inkVersion");
	const hasLegacy = Object.hasOwn(r, "impVersion");
	const version = hasInk ? r.inkVersion : r.impVersion;
	if (!isName(version)) return { ok: false, reason: "invalid" };
	if (hasInk && hasLegacy && r.impVersion !== version) return { ok: false, reason: "invalid" };
	if (!isAbsolutePath(r.cwd)) return { ok: false, reason: "invalid" };
	if (!isBinding(r.model)) return { ok: false, reason: "invalid" };
	if (r.agent !== undefined && !isAgent(r.agent)) return { ok: false, reason: "invalid" };
	if (r.worktree !== undefined && !isWorktree(r.worktree)) return { ok: false, reason: "invalid" };
	if (!Array.isArray(r.tools) || !r.tools.every(isToolEntry)) return { ok: false, reason: "invalid" };
	if (!isSystemBlock(r.system)) return { ok: false, reason: "invalid" };
	if (!Array.isArray(r.extensions) || !r.extensions.every(isExtensionIdentity)) {
		return { ok: false, reason: "invalid" };
	}
	// Unknown extra fields are tolerated (readers-ignore convention); the
	// builder never writes them, and nothing in the verdict reads them. One
	// deliberate exception: the legacy `impVersion` key is consumed and dropped
	// here, so every reader sees exactly one version field.
	const launch: Record<string, unknown> = { ...r, inkVersion: version };
	delete launch.impVersion;
	return { ok: true, launch: launch as unknown as ChildLaunchRecord };
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^[0-9a-f]{7,40}$/;
const ORIGINS: readonly string[] = ["cli", "project", "global"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && path.isAbsolute(value);
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && HEX64.test(value);
}

function isBinding(value: unknown): boolean {
	// SA-08 reopened F-3: one shared derivation rule with TaskRecord's
	// isBinding (a3aaa72's launch-side rule generalized).
	if (value === undefined) return false;
	return isModelBinding(value);
}

function isAgent(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return isName(value.name) && isAbsolutePath(value.source) && isHash(value.roleSha256);
}

function isWorktree(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isAbsolutePath(value.repoRoot) || !isAbsolutePath(value.path) || !isName(value.branch)) return false;
	if (typeof value.baseline !== "string" || !HEX_COMMIT.test(value.baseline)) return false;
	if (value.creationReflog === undefined) return true;
	return (
		Array.isArray(value.creationReflog) && value.creationReflog.every((line) => typeof line === "string")
	);
}

function isToolEntry(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isName(value.name)) return false;
	return value.mcpServer === undefined || isName(value.mcpServer);
}

function isSystemBlock(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isHash(value.sha256)) return false;
	const files = value.contextFiles;
	if (
		!Array.isArray(files) ||
		!files.every((f) => isRecord(f) && isAbsolutePath(f.path) && isHash(f.sha256))
	) {
		return false;
	}
	const prompt = value.promptFiles;
	if (
		!Array.isArray(prompt) ||
		!prompt.every(
			(f) =>
				isRecord(f) &&
				(f.kind === "override" || f.kind === "append") &&
				isAbsolutePath(f.path) &&
				isHash(f.sha256),
		)
	) {
		return false;
	}
	const contexts = value.extensionContexts;
	return Array.isArray(contexts) && contexts.every((c) => isRecord(c) && isName(c.id) && isHash(c.sha256));
}

function isExtensionIdentity(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		isName(value.name) &&
		typeof value.origin === "string" &&
		ORIGINS.includes(value.origin) &&
		isAbsolutePath(value.path) &&
		isHash(value.sha256)
	);
}

// --- managed lookup --------------------------------------------------------

export interface ChildLaunchFile {
	filePath: string;
	header: SessionHeader;
	launch: ChildLaunchRecord;
	store: SessionStore;
	messageCount: number;
}

export type ChildLookupCode =
	| "not-found"
	| "ambiguous"
	| "not-owned"
	| "outside"
	| "malformed"
	| "missing-launch"
	| "invalid-launch";

export type ChildLookupResult =
	| { ok: true; file: ChildLaunchFile }
	| { ok: false; code: ChildLookupCode; message: string };

export type ChildListStatus =
	| "ok"
	| "symlink"
	| "malformed"
	| "unknown-version"
	| "missing-launch"
	| "invalid-launch";

export interface ChildListEntry {
	filePath: string;
	status: ChildListStatus;
	id?: string;
	launch?: ChildLaunchRecord;
}

const MAX_HEADER_BYTES = 64 * 1024;

/** First line only (bounded): enumeration must not parse child transcripts. */
function readFirstLine(filePath: string): string | null {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		if (read <= 0) return null;
		const newline = buffer.subarray(0, read).indexOf(0x0a);
		if (newline === -1) return null; // no complete first line — malformed
		return buffer.subarray(0, newline).toString("utf8");
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

type Candidate =
	| { status: "symlink" }
	| { status: "malformed" }
	| { status: "unknown-version" }
	| { status: "readable"; header: SessionHeader };

function classifyCandidate(filePath: string): Candidate {
	let isSymlink = false;
	let isFile = false;
	try {
		const stat = lstatSync(filePath);
		isSymlink = stat.isSymbolicLink();
		isFile = stat.isFile();
	} catch {
		return { status: "malformed" };
	}
	if (isSymlink) return { status: "symlink" }; // never follow a link into a session
	if (!isFile) return { status: "malformed" };
	const line = readFirstLine(filePath);
	if (line === null || line.trim() === "") return { status: "malformed" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { status: "malformed" };
	}
	if (!isRecord(parsed) || parsed.type !== "session") return { status: "malformed" };
	if (parsed.version !== 1) return { status: "unknown-version" };
	if (!isName(parsed.id)) return { status: "malformed" };
	return { status: "readable", header: parsed as unknown as SessionHeader };
}

function childrenDirFor(parent: SessionStore): string {
	// Derived from the parent FILE's location — the same directory
	// createChildSession writes to for every normal flow. baseDir is not
	// re-derivable and lookup never tries (design §3).
	return path.join(path.dirname(parent.filePath), "children");
}

function listCandidateNames(parent: SessionStore): { dir: string; names: string[] } {
	const dir = childrenDirFor(parent);
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		names = [];
	}
	names.sort();
	return { dir, names };
}

/**
 * Managed identity lookup (design §3): only this parent's own children
 * directory, only header-id matching, symlinks refused, containment checked.
 * Never accepts a caller-supplied file name.
 */
export function findChildByLaunch(parent: SessionStore, childId: string): ChildLookupResult {
	const { dir, names } = listCandidateNames(parent);
	const skipped: string[] = [];
	const matches: Array<{ filePath: string; header: SessionHeader }> = [];
	for (const name of names) {
		const filePath = path.join(dir, name);
		const candidate = classifyCandidate(filePath);
		if (candidate.status === "readable") {
			if (candidate.header.id === childId) matches.push({ filePath, header: candidate.header });
		} else {
			skipped.push(`${name} (${candidate.status})`);
		}
	}
	if (matches.length === 0) {
		const diagnostics =
			skipped.length === 0 ? "" : ` — skipped candidate(s): ${skipped.slice(0, 3).join(", ")}`;
		return {
			ok: false,
			code: "not-found",
			message: `no child session matching "${childId}" in ${dir}${diagnostics}`,
		};
	}
	if (matches.length > 1) {
		return {
			ok: false,
			code: "ambiguous",
			message: `"${childId}" matches ${matches.length} files (${matches
				.map((m) => path.basename(m.filePath))
				.join(", ")}) — duplicated ids cannot be disambiguated`,
		};
	}
	const match = matches[0] as { filePath: string; header: SessionHeader };
	// Containment is defense-in-depth: candidates come from readdir of this
	// directory, so the `outside` branch only fires if a future caller hands
	// in foreign paths; symlinked child FILES are refused earlier by lstat.
	try {
		const realDir = realpathSync(dir);
		const realFile = realpathSync(match.filePath);
		if (!realFile.startsWith(`${realDir}${path.sep}`)) {
			return {
				ok: false,
				code: "outside",
				message: `${match.filePath} resolves outside ${dir}`,
			};
		}
	} catch (err) {
		return {
			ok: false,
			code: "malformed",
			message: `could not resolve ${match.filePath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (match.header.parent !== parent.header.id) {
		return {
			ok: false,
			code: "not-owned",
			message: `"${childId}" belongs to parent ${String(match.header.parent)}, not to this session`,
		};
	}
	let store: SessionStore;
	let messageCount: number;
	try {
		store = SessionStore.open(match.filePath);
		// Corruption probes. Explicit structural validation comes first — a
		// string retainedTail spreads into garbage, [null] and content-less
		// messages only explode downstream, so buildContext() succeeding is
		// NOT proof of validity. Then the traversal guard (broken chain /
		// parentId cycle, guarded in getBranch) and buildContext as a
		// catch-all. Scoped to this continuation boundary on purpose:
		// ordinary history reads keep their lenient compatibility rules.
		const structural = effectiveHistoryProblem(store.getBranch());
		if (structural !== null) {
			return {
				ok: false,
				code: "malformed",
				message: `child session ${match.filePath} is structurally unusable for continuation: ${structural}`,
			};
		}
		store.buildContext();
		messageCount = store.getEntries().filter((entry) => entry.type === "message").length;
	} catch (err) {
		return {
			ok: false,
			code: "malformed",
			message: `child session ${match.filePath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const parsed = parseChildLaunch(match.header.launch);
	if (!parsed.ok) {
		return parsed.reason === "missing"
			? {
					ok: false,
					code: "missing-launch",
					message: `child "${childId}" has no launch record (launched before SA-06 or without the environment wiring) — readable, not resumable`,
				}
			: {
					ok: false,
					code: "invalid-launch",
					message: `child "${childId}" has a launch record that fails schema validation — refused, not repaired`,
				};
	}
	// Identity binding (design §2.1): the record must be about THIS file and
	// THIS parent — otherwise another child's settled record could be borrowed
	// for the verdict. header.parent === parent.header.id is enforced above,
	// so these two checks close the three-way consistency.
	if (parsed.launch.childId !== match.header.id) {
		return {
			ok: false,
			code: "invalid-launch",
			message: `launch.childId "${parsed.launch.childId}" does not match the file's header id "${match.header.id}" — refused`,
		};
	}
	if (parsed.launch.parentSessionId !== match.header.parent) {
		return {
			ok: false,
			code: "not-owned",
			message: `launch.parentSessionId "${parsed.launch.parentSessionId}" does not match the file's header parent "${String(match.header.parent)}"`,
		};
	}
	return {
		ok: true,
		file: { filePath: match.filePath, header: match.header, launch: parsed.launch, store, messageCount },
	};
}

// --- effective-history structure (continuation boundary only) --------------

/**
 * Strict structural validation of the branch a continuation would rebuild
 * from (acceptance round 2). buildContext() succeeding is not proof: a
 * string `retainedTail` spreads into garbage "messages", `[null]` and
 * content-less messages only throw later in estimation. Returns a
 * human-readable problem or null; deliberately NOT wired into ordinary
 * history reads (their compatibility rules stay untouched).
 */
function effectiveHistoryProblem(entries: readonly SessionEntry[]): string | null {
	for (const entry of entries) {
		if (entry.type === "message") {
			const problem = messageProblem(entry.message, `entry ${entry.id}`);
			if (problem !== null) return problem;
			continue;
		}
		if (entry.type === "compaction") {
			if (typeof entry.summary !== "string") {
				return `compaction entry ${entry.id} has no summary text`;
			}
			if (!Array.isArray(entry.retainedTail)) {
				return `compaction entry ${entry.id}: retainedTail is not an array`;
			}
			for (let i = 0; i < entry.retainedTail.length; i++) {
				const problem = messageProblem(entry.retainedTail[i], `compaction ${entry.id} retainedTail[${i}]`);
				if (problem !== null) return problem;
			}
			continue;
		}
		if (entry.type === "branchSummary" && typeof entry.summary !== "string") {
			return `branchSummary entry ${entry.id} has no summary text`;
		}
	}
	return null;
}

function isContent(value: unknown): boolean {
	if (typeof value === "string") return true;
	if (!Array.isArray(value)) return false;
	return value.every((block) => {
		if (!isRecord(block) || typeof block.type !== "string") return false;
		if (block.type === "text") return typeof block.text === "string";
		if (block.type === "image") return typeof block.data === "string" && typeof block.mimeType === "string";
		return false;
	});
}

function assistantBlockProblem(block: unknown): string | null {
	if (!isRecord(block) || typeof block.type !== "string") return "a block is not an object with a type";
	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? null : "a text block has no text string";
		case "toolCall":
			return typeof block.id === "string" && typeof block.name === "string" && "arguments" in block
				? null
				: "a toolCall block is missing id, name or arguments";
		case "thinking":
			return typeof block.thinking === "string" &&
				(block.signature === undefined || typeof block.signature === "string")
				? null
				: "a thinking block has no thinking string";
		default:
			return `unknown block type ${JSON.stringify(block.type)}`;
	}
}

function isOptionalNumber(value: unknown): boolean {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function messageProblem(value: unknown, where: string): string | null {
	if (!isRecord(value)) return `${where}: not a message object`;
	switch (value.role) {
		case "user":
			return isContent(value.content)
				? null
				: `${where}: user message content is not a string or content-block array`;
		case "assistant": {
			if (!Array.isArray(value.blocks)) return `${where}: assistant message has no blocks array`;
			for (const block of value.blocks) {
				const problem = assistantBlockProblem(block);
				if (problem !== null) return `${where}: ${problem}`;
			}
			const usage = value.usage;
			if (
				!isRecord(usage) ||
				typeof usage.inputTokens !== "number" ||
				!Number.isFinite(usage.inputTokens) ||
				typeof usage.outputTokens !== "number" ||
				!Number.isFinite(usage.outputTokens) ||
				!isOptionalNumber(usage.cacheReadTokens) ||
				!isOptionalNumber(usage.cacheWriteTokens)
			) {
				return `${where}: assistant message usage is invalid`;
			}
			const stop = value.stopReason;
			if (
				!(
					stop === null ||
					stop === "end_turn" ||
					stop === "tool_use" ||
					stop === "max_tokens" ||
					stop === "stop_sequence"
				)
			) {
				return `${where}: assistant message stopReason is invalid`;
			}
			return null;
		}
		case "toolResult": {
			if (!Array.isArray(value.results)) return `${where}: toolResult message has no results array`;
			for (let i = 0; i < value.results.length; i++) {
				const result = value.results[i];
				if (
					!isRecord(result) ||
					typeof result.toolCallId !== "string" ||
					typeof result.toolName !== "string" ||
					!isContent(result.content) ||
					typeof result.isError !== "boolean"
				) {
					return `${where}: toolResult entry ${i} is structurally invalid`;
				}
			}
			return null;
		}
		default:
			return `${where}: unknown message role ${JSON.stringify(value.role)}`;
	}
}

/** Enumerate this parent's children with per-file classifications (SA-07's
 *  diagnostics surface; also pins symlink/malformed/unknown-version handling). */
export function listChildLaunches(parent: SessionStore): ChildListEntry[] {
	const { dir, names } = listCandidateNames(parent);
	const out: ChildListEntry[] = [];
	for (const name of names) {
		const filePath = path.join(dir, name);
		const candidate = classifyCandidate(filePath);
		if (candidate.status !== "readable") {
			out.push({ filePath, status: candidate.status });
			continue;
		}
		const entry: ChildListEntry = { filePath, status: "ok", id: candidate.header.id };
		const parsed = parseChildLaunch(candidate.header.launch);
		if (parsed.ok) {
			// Same identity binding rule as findChildByLaunch (design §2.1).
			if (parsed.launch.childId !== candidate.header.id) entry.status = "invalid-launch";
			else entry.launch = parsed.launch;
		} else {
			entry.status = parsed.reason === "missing" ? "missing-launch" : "invalid-launch";
		}
		out.push(entry);
	}
	return out;
}

// --- validation ------------------------------------------------------------

export type ContinuationCode =
	| "no-record"
	| "empty-transcript"
	| "version-drift"
	| "agent-missing"
	| "agent-drift"
	| "system-drift"
	| "context-files-drift"
	| "prompt-files-drift"
	| "extension-contexts-drift"
	| "extension-drift"
	| "tools-drift"
	| "model-drift"
	| "cwd-drift"
	| "cwd-missing"
	| "cwd-not-directory"
	| "worktree-cwd-outside"
	| "worktree-repo-missing"
	| "worktree-missing"
	| "worktree-replaced"
	| "worktree-unregistered"
	| "worktree-branch-swapped"
	| "worktree-history-replaced";

export interface ChildContinuationVerdict {
	resumable: boolean;
	executionState: "settled" | "unknown";
	attempts: number;
	lastStatus?: TaskRecordStatus;
	onCurrentBranch?: boolean;
	diagnostics?: string[];
	reasons: Array<{ code: ContinuationCode; message: string }>;
}

/** The currently resolved environment, supplied by the caller (SA-07's
 *  wiring). All plain data — no provider instances, no closures with state. */
export interface CurrentChildEnvironment {
	inkVersion: string;
	systemText: string;
	cwd: string | undefined;
	agentResolver: (name: string) => { system: string } | undefined;
	contextFiles: readonly LaunchContextFile[];
	promptFiles: readonly LaunchPromptFile[];
	extensionContexts: readonly LaunchExtensionContext[];
	extensions: readonly ExtensionModuleIdentity[];
	childTools: ReadonlyArray<{ name: string; mcpServer?: string }>;
	binding: ChildModelBinding;
}

function sameBinding(a: ChildModelBinding, b: ChildModelBinding): boolean {
	return a.providerName === b.providerName && a.wireModelId === b.wireModelId && a.reference === b.reference;
}

/** SA-08 reopened F-2b (owner round 2): the execution cwd must RESOLVE to a
 *  directory (symlinks followed). Returns the refusal, or undefined when the
 *  cwd is usable. ENOENT here means the path vanished between the
 *  existsSync pre-check and this stat — an existence verdict, not a type
 *  verdict (design §2.2 item 5). */
function cwdDirectoryProblem(
	cwd: string,
): { code: "cwd-missing" | "cwd-not-directory"; detail: string } | undefined {
	try {
		if (statSync(cwd).isDirectory()) return undefined;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { code: "cwd-missing", detail: "it vanished between the existence check and the type check" };
		}
		return {
			code: "cwd-not-directory",
			detail: `its type could not be confirmed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { code: "cwd-not-directory", detail: "it is not a directory" };
}

function cwdProblemMessage(code: "cwd-missing" | "cwd-not-directory", cwd: string, detail: string): string {
	return code === "cwd-missing"
		? `the recorded execution cwd ${cwd} no longer exists (${detail})`
		: `the recorded execution cwd ${cwd} cannot be used: ${detail}`;
}

/** SA-08 reopened F-2: separator-exact containment of the RESOLVED cwd
 *  inside the RESOLVED worktree path (no `/wt-other` false positives; the
 *  filesystem root keeps its single separator). */
function cwdInsideWorktree(cwd: string, worktreePath: string): { ok: boolean; detail?: string } {
	let realCwd: string;
	let realWt: string;
	try {
		realCwd = realpathSync(cwd);
		realWt = realpathSync(worktreePath);
	} catch (err) {
		return {
			ok: false,
			detail: `could not resolve the paths: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const prefix = realWt.endsWith(path.sep) ? realWt : `${realWt}${path.sep}`;
	if (realCwd === realWt || realCwd.startsWith(prefix)) return { ok: true };
	return { ok: false, detail: `resolved to ${realCwd}, outside ${realWt}` };
}

/** Compare recorded fingerprints against the current environment; every
 *  difference is a refusal with an actionable message. Never repairs. */
export async function validateChildContinuation(
	file: ChildLaunchFile,
	parent: SessionStore,
	current: CurrentChildEnvironment,
): Promise<ChildContinuationVerdict> {
	const launch = file.launch;
	const reasons: ChildContinuationVerdict["reasons"] = [];
	const diagnostics: string[] = [];

	// 1. Parent-side history (all entries, file order — the child file is
	//    branch-independent, so attempts recorded on a later-abandoned branch
	//    still happened). No record => unknown state, refused by construction.
	const records = collectTaskRecords(parent.getEntries()).filter(
		(record) => record.childId === launch.childId,
	);
	const settled = records.filter((record) => record.launched);
	let executionState: "settled" | "unknown" = "unknown";
	let lastStatus: TaskRecordStatus | undefined;
	if (settled.length === 0) {
		reasons.push({
			code: "no-record",
			message: `no settled task record for child ${launch.childId} — it may still be running, or the process died before any parent-side write`,
		});
	} else {
		executionState = "settled";
		lastStatus = settled[settled.length - 1]?.status;
	}
	// Diagnostic only (never a refusal): is the newest record on the branch
	// the parent currently sits on?
	let onCurrentBranch: boolean | undefined;
	try {
		const branchIds = new Set(parent.getBranch().map((entry) => entry.id));
		let lastEntryId: string | undefined;
		for (const entry of parent.getEntries()) {
			if (taskRecordsInEntry(entry).some((record) => record.childId === launch.childId)) {
				lastEntryId = entry.id;
			}
		}
		if (lastEntryId !== undefined) onCurrentBranch = branchIds.has(lastEntryId);
	} catch {
		onCurrentBranch = undefined;
	}

	// 2. Conversation content.
	if (file.messageCount === 0) {
		reasons.push({
			code: "empty-transcript",
			message: "the child session contains no conversation content — nothing to continue",
		});
	}

	// 3. Ink version (O2: the binary-controlled layer is not fingerprinted
	//    per-component, so any version change is an incompatibility).
	if (current.inkVersion !== launch.inkVersion) {
		reasons.push({
			code: "version-drift",
			message: `launched under application version ${launch.inkVersion}; the current build is ${current.inkVersion} — resuming across versions is refused`,
		});
	}

	// 4. Agent role.
	if (launch.agent !== undefined) {
		const resolved = current.agentResolver(launch.agent.name);
		if (resolved === undefined) {
			reasons.push({
				code: "agent-missing",
				message: `agent "${launch.agent.name}" (${launch.agent.source}) is not in the current registry`,
			});
		} else if (sha256Hex(resolved.system) !== launch.agent.roleSha256) {
			reasons.push({
				code: "agent-drift",
				message: `agent "${launch.agent.name}" body changed since launch (${launch.agent.source})`,
			});
		}
	}

	// 5. Assembled system text (L6 coverage: roster, catalog, MCP text).
	if (sha256Hex(normalizeSystemText(current.systemText)) !== launch.system.sha256) {
		reasons.push({
			code: "system-drift",
			message: "the assembled system prompt changed since launch (see the per-source diffs below)",
		});
	}

	// 6. Context files.
	const contextDiff = diffByPath(
		launch.system.contextFiles,
		current.contextFiles.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) })),
	);
	if (contextDiff !== undefined) {
		reasons.push({ code: "context-files-drift", message: contextDiff });
	}

	// 7. Prompt files (SYSTEM.md override/append).
	const promptDiff = diffByPath(
		launch.system.promptFiles.map((f) => ({ path: `${f.kind}:${f.path}`, sha256: f.sha256 })),
		current.promptFiles.map((f) => ({ path: `${f.kind}:${f.path}`, sha256: sha256Hex(f.text) })),
	);
	if (promptDiff !== undefined) {
		reasons.push({ code: "prompt-files-drift", message: promptDiff });
	}

	// 8. Extension context sections (registration order).
	const contextSectionDiff = diffByPath(
		launch.system.extensionContexts.map((section) => ({ path: section.id, sha256: section.sha256 })),
		current.extensionContexts.map((section) => ({ path: section.id, sha256: sha256Hex(section.text) })),
	);
	if (contextSectionDiff !== undefined) {
		reasons.push({ code: "extension-contexts-drift", message: contextSectionDiff });
	}

	// 9. Extension modules (load order + content hashes).
	const extensionDiff = diffExtensions(launch.extensions, current.extensions);
	if (extensionDiff !== undefined) {
		reasons.push({ code: "extension-drift", message: extensionDiff });
	}

	// 10. Tool contract (canonical projection; exact set equality — extra
	//     tools would broaden the child's contract).
	const recordedTools = canonicalTools(launch.tools);
	const currentTools = canonicalTools(current.childTools);
	if (JSON.stringify(recordedTools) !== JSON.stringify(currentTools)) {
		reasons.push({ code: "tools-drift", message: toolDiff(recordedTools, currentTools) });
	}

	// 11. Model binding.
	if (!sameBinding(launch.model, current.binding)) {
		reasons.push({
			code: "model-drift",
			message: `the child ran on ${launch.model.reference}; the current resolution yields ${current.binding.reference}`,
		});
	}

	// 12/13. Execution cwd or worktree identity.
	if (launch.worktree === undefined) {
		if (current.cwd !== undefined && current.cwd !== launch.cwd) {
			reasons.push({
				code: "cwd-drift",
				message: `the child ran in ${launch.cwd}; the current cwd is ${current.cwd} — resuming elsewhere needs an explicit caller decision`,
			});
		} else if (!existsSync(launch.cwd)) {
			reasons.push({
				code: "cwd-missing",
				message: `the recorded execution cwd ${launch.cwd} no longer exists`,
			});
		} else {
			// SA-08 reopened F-2b: existence alone is not enough — a file is
			// not an execution environment.
			const problem = cwdDirectoryProblem(launch.cwd);
			if (problem !== undefined) {
				reasons.push({
					code: problem.code,
					message: cwdProblemMessage(problem.code, launch.cwd, problem.detail),
				});
			}
		}
	} else {
		const probe = await probeWorktreeIdentity({
			repoRoot: launch.worktree.repoRoot,
			path: launch.worktree.path,
			branch: launch.worktree.branch,
			baseline: launch.worktree.baseline,
			...(launch.worktree.creationReflog === undefined
				? {}
				: { creationReflog: launch.worktree.creationReflog }),
		});
		if (!probe.ok) reasons.push({ code: probe.code, message: probe.message });
		else if (probe.detail !== undefined) diagnostics.push(probe.detail);
		// SA-08 reopened F-2: the validated worktree identity must constrain
		// the EXECUTION cwd — the tool pool, the permission gate, and events
		// all run with launch.cwd, and fresh dispatch builds it as the
		// worktree root or a subdirectory of it (subdirectory parents keep
		// their relative position). Symlinks resolve before containment.
		if (!existsSync(launch.cwd)) {
			reasons.push({
				code: "cwd-missing",
				message: `the recorded execution cwd ${launch.cwd} no longer exists`,
			});
		} else {
			// SA-08 reopened F-2b: dirness FIRST — containment alone accepts a
			// symlink inside the worktree whose final object is a file (F2-e).
			const problem = cwdDirectoryProblem(launch.cwd);
			if (problem !== undefined) {
				reasons.push({
					code: problem.code,
					message: cwdProblemMessage(problem.code, launch.cwd, problem.detail),
				});
			} else if (probe.ok) {
				const containment = cwdInsideWorktree(launch.cwd, launch.worktree.path);
				if (!containment.ok) {
					reasons.push({
						code: "worktree-cwd-outside",
						message: `the recorded execution cwd ${launch.cwd} is not inside the verified worktree ${launch.worktree.path}${
							containment.detail === undefined ? "" : ` (${containment.detail})`
						} — the validated environment and the execution environment must agree`,
					});
				}
			}
		}
	}

	const verdict: ChildContinuationVerdict = {
		resumable: reasons.length === 0,
		executionState,
		attempts: settled.length,
		reasons,
	};
	if (lastStatus !== undefined) verdict.lastStatus = lastStatus;
	if (onCurrentBranch !== undefined) verdict.onCurrentBranch = onCurrentBranch;
	if (diagnostics.length > 0) verdict.diagnostics = diagnostics;
	return verdict;
}

function canonicalTools(
	tools: ReadonlyArray<{ name: string; mcpServer?: string }>,
): Array<{ name: string; mcpServer?: string }> {
	// Set semantics: duplicate names collapse to their first entry (a tampered
	// record with duplicates must compare like a single occurrence).
	const byName = new Map<string, { name: string; mcpServer?: string }>();
	for (const tool of tools) {
		if (byName.has(tool.name)) continue;
		byName.set(
			tool.name,
			tool.mcpServer === undefined ? { name: tool.name } : { name: tool.name, mcpServer: tool.mcpServer },
		);
	}
	return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function toolDiff(
	recorded: Array<{ name: string; mcpServer?: string }>,
	current: Array<{ name: string; mcpServer?: string }>,
): string {
	const parts: string[] = [];
	const currentBy = new Map(current.map((t) => [t.name, t]));
	for (const tool of recorded) {
		const now = currentBy.get(tool.name);
		if (now === undefined) parts.push(`${tool.name} is no longer available`);
		else if (now.mcpServer !== tool.mcpServer) {
			parts.push(
				`${tool.name} comes from a different source now (${tool.mcpServer ?? "builtin"} -> ${now.mcpServer ?? "builtin"})`,
			);
		}
	}
	const recordedNames = new Set(recorded.map((t) => t.name));
	for (const tool of current) {
		if (!recordedNames.has(tool.name)) parts.push(`${tool.name} would be added to the contract`);
	}
	return parts.length > 0 ? parts.join("; ") : "the tool set order changed";
}

function diffByPath(
	recorded: Array<{ path: string; sha256: string }>,
	current: Array<{ path: string; sha256: string }>,
): string | undefined {
	if (
		recorded.length === current.length &&
		recorded.every((entry, i) => entry.path === current[i]?.path && entry.sha256 === current[i]?.sha256)
	) {
		return undefined;
	}
	const parts: string[] = [];
	const currentBy = new Map(current.map((entry) => [entry.path, entry]));
	for (const entry of recorded) {
		const now = currentBy.get(entry.path);
		if (now === undefined)
			parts.push(`${entry.path} is missing from the current prompt (no longer readable)`);
		else if (now.sha256 !== entry.sha256) parts.push(`${entry.path} content changed`);
	}
	const recordedPaths = new Set(recorded.map((entry) => entry.path));
	for (const entry of current) {
		if (!recordedPaths.has(entry.path)) parts.push(`${entry.path} was added to the prompt`);
	}
	return parts.length > 0 ? parts.join("; ") : "the file order changed";
}

function diffExtensions(
	recorded: readonly ExtensionModuleIdentity[],
	current: readonly ExtensionModuleIdentity[],
): string | undefined {
	const equal =
		recorded.length === current.length &&
		recorded.every(
			(entry, i) =>
				entry.name === current[i]?.name &&
				entry.origin === current[i]?.origin &&
				entry.path === current[i]?.path &&
				entry.sha256 === current[i]?.sha256,
		);
	if (equal) return undefined;
	const parts: string[] = [];
	for (const entry of recorded) {
		const now = current.find((candidate) => candidate.path === entry.path);
		if (now === undefined) parts.push(`${entry.name} (${entry.path}) is not loaded now`);
		else if (now.sha256 !== entry.sha256) parts.push(`${entry.name} (${entry.path}) content changed`);
		else if (now.origin !== entry.origin || now.name !== entry.name) {
			parts.push(`${entry.name} (${entry.path}) provenance changed`);
		}
	}
	for (const entry of current) {
		if (!recorded.some((candidate) => candidate.path === entry.path)) {
			parts.push(`${entry.name} (${entry.path}) is loaded now but was not at launch`);
		}
	}
	return parts.length > 0 ? parts.join("; ") : "the extension load order changed";
}
