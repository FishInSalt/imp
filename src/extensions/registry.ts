import { Value } from "typebox/value";
import { BUILTIN_TOOL_NAMES, NAME_PATTERN } from "../core/constants.js";
import type { ToolCallDecision } from "../core/loop.js";
import type { Tool } from "../core/tools/types.js";
import { firstLine } from "../format.js";
import { COMMANDS, type SlashCommand } from "../repl/commands.js";
import type {
	ConfirmOptions,
	ContextSection,
	ExtensionEventHandlerMap,
	ExtensionEventName,
	ExtensionOrigin,
	ExtensionSummary,
	MessageEndEvent,
	RegisteredExtensionCommand,
	RunEndEvent,
	RunStartEvent,
	ToolCallEvent,
	ToolCallHandler,
	ToolEndEvent,
} from "./types.js";

/** imp's own slash commands — reserved (design §9). Derived from COMMANDS
 *  (M15 review P2-6): the hand list had drifted to a subset, letting
 *  extensions register duplicate /settings, /think, /status, /trust rows. */
const BUILTIN_COMMAND_NAMES: readonly string[] = COMMANDS.map((command) => command.name);

// BUILTIN_TOOL_NAMES and NAME_PATTERN live in core/constants.ts (M18: the
// MCP bridge shares them — one hand list, not two).

const KNOWN_EVENTS: readonly ExtensionEventName[] = [
	"tool_call",
	"tool_end",
	"message_end",
	"run_start",
	"run_end",
];

/** Defensive cap on a stored status text (UTF-16 code units). The shell does
 *  the real width truncation at render time (task-timer design §4.2). */
const STATUS_TEXT_CAP = 500;

type AnyHandler = ExtensionEventHandlerMap[ExtensionEventName];

interface StoredHandler {
	source: string;
	event: ExtensionEventName;
	handler: AnyHandler;
}

/** The in-flight per-extension section: registrations land here until commit/discard. */
interface OpenSection {
	name: string;
	origin: ExtensionOrigin;
	tools: Tool[];
	commands: RegisteredExtensionCommand[];
	contexts: ContextSection[];
	hooks: StoredHandler[];
}

export interface ExtensionRegistryOptions {
	/** Teaching-style diagnostic sink (`imp: …` lines, design §12). Default: discard. */
	report?: (line: string) => void;
	/** Interactive confirm (the REPL's tty prompt). Absent — print mode, plain
	 *  tests — api.confirm resolves false after one stderr teaching line and
	 *  never hangs (spec part 2 item 5). */
	confirm?: (message: string, detail?: string, options?: ConfirmOptions) => Promise<boolean>;
}

/** The one stderr line written when api.confirm runs without an interactive host. */
export const NO_CONFIRM_LINE =
	"imp: extension asked for confirmation but no interactive prompt is available — declining\n";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The extension data record: factories write into it through validated
 * registration methods; the host (runner/repl) reads plain data back out —
 * never closures it didn't create (design §2.1).
 *
 * Every method is total: extension-caused failures become diagnostics
 * (errors as data), never throws into the host (design §7.2).
 */
export class ExtensionRegistry {
	/** Registered tools in load order; the runner appends these after its own set (M4a). */
	readonly tools: Tool[] = [];
	/** Registered slash commands in load order (dispatched from M4b). */
	readonly commands: RegisteredExtensionCommand[] = [];
	/** Registered system-prompt sections in load order (injected from M4c). */
	readonly contextSections: ContextSection[] = [];

	private readonly report: (line: string) => void;
	private readonly confirmHandler:
		| ((message: string, detail?: string, options?: ConfirmOptions) => Promise<boolean>)
		| undefined;
	/** The no-handler stderr line has been written once already. */
	private noConfirmWarned = false;
	/** Committed name → owning extension name (conflict policy, design §9). */
	private readonly toolOwners = new Map<string, string>();
	private readonly commandOwners = new Map<string, string>();
	private readonly contextOwners = new Map<string, string>();
	/** Committed handlers in load order (chain order is load order, design §6.1). */
	private readonly handlers: StoredHandler[] = [];
	private section: OpenSection | null = null;
	/** Status texts by extension bucket (`origin:name`) then author key. */
	private readonly statuses = new Map<string, Map<string, string>>();
	/** The one shell status renderer; null until a TUI machine binds (print
	 *  mode and legacy shell: never — writes stay storage-only). */
	private statusSink: ((line: string) => void) | null = null;

	constructor(options: ExtensionRegistryOptions = {}) {
		this.report = options.report ?? (() => {});
		this.confirmHandler = options.confirm;
	}

	// --- load lifecycle (loader-facing) ---

	/** True while a factory is running — the only window registrations are accepted. */
	hasOpenSection(): boolean {
		return this.section !== null;
	}

	/** Open a fresh per-extension section (design §7.1 step 3). */
	beginExtension(name: string, origin: ExtensionOrigin): void {
		this.section = { name, origin, tools: [], commands: [], contexts: [], hooks: [] };
	}

	/** Merge the open section into the record; returns its banner summary. */
	commitExtension(): ExtensionSummary | null {
		const section = this.section;
		if (section === null) return null;
		for (const tool of section.tools) {
			this.tools.push(tool);
			this.toolOwners.set(tool.name, section.name);
		}
		for (const command of section.commands) {
			this.commands.push(command);
			this.commandOwners.set(command.command.name, section.name);
		}
		for (const context of section.contexts) {
			this.contextSections.push(context);
			this.contextOwners.set(context.id, section.name);
		}
		this.handlers.push(...section.hooks);
		const summary: ExtensionSummary = {
			name: section.name,
			origin: section.origin,
			toolCount: section.tools.length,
			commandCount: section.commands.length,
			contextCount: section.contexts.length,
			hookCount: section.hooks.length,
		};
		this.section = null;
		return summary;
	}

	/** Drop the open section atomically — a thrown factory discards everything it registered. */
	discardExtension(): void {
		this.section = null;
	}

	// --- registration (api-facing; validated, never throws) ---

	registerTool(tool: Tool): void {
		const section = this.section;
		if (section === null) return; // post-load attempts are reported by the api layer
		if (typeof tool !== "object" || tool === null) {
			this.report(
				`imp: extension ${section.name} could not register tool — expected a tool object, got ${typeof tool}`,
			);
			return;
		}
		const name = typeof tool.name === "string" ? tool.name : String(tool.name);
		if (typeof tool.name !== "string" || !NAME_PATTERN.test(name)) {
			this.report(
				`imp: extension ${section.name} could not register tool "${name}" — tool names must match /^[a-z][a-z0-9_-]{0,63}$/ (got "${name}")`,
			);
			return;
		}
		if (BUILTIN_TOOL_NAMES.includes(name)) {
			this.report(
				`imp: extension ${section.name} could not register tool "${name}" — reserved by imp (built-in tools: ${BUILTIN_TOOL_NAMES.join(" ")})`,
			);
			return;
		}
		const earlier = this.conflictOwner(this.toolOwners, section.tools, name, (t) => t.name);
		if (earlier !== undefined) {
			this.report(
				`imp: extension ${section.name} could not register tool "${name}" — already registered by ${earlier}`,
			);
			return;
		}
		if (typeof tool.description !== "string" || tool.description.trim() === "") {
			this.report(
				`imp: extension ${section.name} could not register tool "${name}" — description must be a non-empty string`,
			);
			return;
		}
		// Schema smoke check — a crash-guard, not validation (design §8.1): "passes"
		// means Value.Check does not throw against {}. Schemas with required
		// properties return false here, which is fine and ignored on purpose; the
		// loop's call-time Value.Check remains the only authority on arguments.
		try {
			Value.Check(tool.parameters, {});
		} catch (err) {
			this.report(
				`imp: extension ${section.name} could not register tool "${name}" — parameters schema is malformed: ${firstLine(errorText(err), 160)}`,
			);
			return;
		}
		section.tools.push(tool);
	}

	registerCommand(command: SlashCommand): void {
		const section = this.section;
		if (section === null) return;
		if (typeof command !== "object" || command === null) {
			this.report(
				`imp: extension ${section.name} could not register command — expected a command object, got ${typeof command}`,
			);
			return;
		}
		const name = typeof command.name === "string" ? command.name : String(command.name);
		if (typeof command.name !== "string" || !NAME_PATTERN.test(name)) {
			this.report(
				`imp: extension ${section.name} could not register command "${name}" — command names must match /^[a-z][a-z0-9_-]{0,63}$/ (got "${name}")`,
			);
			return;
		}
		if (BUILTIN_COMMAND_NAMES.includes(name)) {
			this.report(
				`imp: extension ${section.name} could not register command "${name}" — reserved by imp (known: ${BUILTIN_COMMAND_NAMES.join(" ")})`,
			);
			return;
		}
		const earlier = this.conflictOwner(this.commandOwners, section.commands, name, (c) => c.command.name);
		if (earlier !== undefined) {
			this.report(
				`imp: extension ${section.name} could not register command "${name}" — already registered by ${earlier}`,
			);
			return;
		}
		section.commands.push({ command, source: section.name });
	}

	registerContext(id: string, text: string): void {
		const section = this.section;
		if (section === null) return;
		const label = typeof id === "string" ? id : String(id);
		if (typeof id !== "string" || id === "") {
			this.report(
				`imp: extension ${section.name} could not register context "${label}" — id must be a non-empty string`,
			);
			return;
		}
		if (typeof text !== "string") {
			this.report(
				`imp: extension ${section.name} could not register context "${label}" — text must be a string, got ${typeof text}`,
			);
			return;
		}
		const earlier = this.conflictOwner(this.contextOwners, section.contexts, id, (c) => c.id);
		if (earlier !== undefined) {
			this.report(
				`imp: extension ${section.name} could not register context "${label}" — already registered by ${earlier}`,
			);
			return;
		}
		section.contexts.push({ id, text });
	}

	/** api.on(): validate the event name and handler, then store in load order. */
	subscribe(event: string, handler: unknown): void {
		const section = this.section;
		if (section === null) return;
		if (!KNOWN_EVENTS.includes(event as ExtensionEventName)) {
			this.report(
				`imp: extension ${section.name} could not subscribe to "${String(event)}" — known events: ${KNOWN_EVENTS.join(" ")}`,
			);
			return;
		}
		if (typeof handler !== "function") {
			this.report(
				`imp: extension ${section.name} could not subscribe to ${event} — handler must be a function, got ${typeof handler}`,
			);
			return;
		}
		section.hooks.push({
			source: section.name,
			event: event as ExtensionEventName,
			handler: handler as AnyHandler,
		});
	}

	// --- emits (isolated; the runner wires them from M4c) ---

	/**
	 * api.confirm(): true only on explicit approval. Fails safe — no wired
	 * prompt or a throwing handler resolves false (with a teaching line), so
	 * an extension gate can never hang a run on a question nobody can answer.
	 */
	async confirm(message: string, detail?: string, options?: ConfirmOptions): Promise<boolean> {
		if (this.confirmHandler === undefined) {
			// once per registry: a chatty gate in print mode (a model retrying a
			// blocked call in a loop) must not spam one stderr line per attempt
			if (!this.noConfirmWarned) {
				this.noConfirmWarned = true;
				process.stderr.write(NO_CONFIRM_LINE);
			}
			return false;
		}
		try {
			return await this.confirmHandler(message, detail, options);
		} catch (err) {
			this.report(`imp: extension confirm handler error — ${firstLine(errorText(err), 160)}`);
			return false;
		}
	}

	/**
	 * Chain "tool_call" handlers in load order. The first { block: true }
	 * short-circuits; everything else continues the chain. A throwing handler
	 * fails SAFE — the tool is blocked with an E9-shaped reason (design §7.2).
	 */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallDecision | undefined> {
		for (const stored of this.handlers) {
			if (stored.event !== "tool_call") continue;
			try {
				const decision = await (stored.handler as ToolCallHandler)(event);
				if (decision?.block === true) return decision;
			} catch (err) {
				const first = firstLine(errorText(err), 160);
				return { block: true, reason: `handler error — ${first}` };
			}
		}
		return undefined;
	}

	/** Observability emits: fire-and-forget with internal isolation (design §6.1). */
	emitToolEnd(event: ToolEndEvent): void {
		this.fireObservers("tool_end", event);
	}

	emitMessageEnd(event: MessageEndEvent): void {
		this.fireObservers("message_end", event);
	}

	emitRunStart(event: RunStartEvent): void {
		this.fireObservers("run_start", event);
	}

	emitRunEnd(event: RunEndEvent): void {
		this.fireObservers("run_end", event);
	}

	// --- extension status channel (shell-facing; task-timer design §4.2) ---

	/** api.setStatus's registry side: validate, store, then push the recomposed
	 *  line to the bound sink (storage only while unbound). Every rule violation
	 *  is one teaching-style diagnostic, never a throw into the host. */
	setExtensionStatus(bucket: string, key: string, text: string | undefined): void {
		if (typeof key !== "string" || key.trim() === "") {
			this.report(`imp: extension ${bucket} status dropped — key must be a non-empty string`);
			return;
		}
		if (text !== undefined && typeof text !== "string") {
			this.report(`imp: extension ${bucket} status dropped — text must be a string or undefined`);
			return;
		}
		if (text === undefined) {
			const existing = this.statuses.get(bucket);
			if (existing === undefined) return; // nothing stored — no repaint owed
			existing.delete(key);
			if (existing.size === 0) this.statuses.delete(bucket);
		} else {
			let bucketMap = this.statuses.get(bucket);
			if (bucketMap === undefined) {
				bucketMap = new Map();
				this.statuses.set(bucket, bucketMap);
			}
			bucketMap.set(key, text.length > STATUS_TEXT_CAP ? text.slice(0, STATUS_TEXT_CAP) : text);
		}
		this.pushStatus();
	}

	/** Flattened status entries in composition order (sorted by bucket:key,
	 *  code-point compare — the readdir lesson of design §17 risk 3). */
	getExtensionStatusEntries(): readonly { bucket: string; key: string; text: string }[] {
		const entries: { bucket: string; key: string; text: string }[] = [];
		for (const [bucket, map] of this.statuses) {
			for (const [key, text] of map) entries.push({ bucket, key, text });
		}
		entries.sort((a, b) => {
			const left = `${a.bucket}:${a.key}`;
			const right = `${b.bucket}:${b.key}`;
			return left < right ? -1 : left > right ? 1 : 0;
		});
		return entries;
	}

	/** Bind the shell's status-line renderer (one per process — the REPL
	 *  machine; no unbind: the machine lives as long as the process). */
	setStatusSink(sink: (line: string) => void): void {
		this.statusSink = sink;
	}

	// --- internals ---

	private pushStatus(): void {
		if (this.statusSink === null) return;
		this.statusSink(
			this.getExtensionStatusEntries()
				.map((entry) => entry.text)
				.join(" "),
		);
	}

	private fireObservers(eventName: ExtensionEventName, event: unknown): void {
		for (const stored of this.handlers) {
			if (stored.event !== eventName) continue;
			try {
				const returned = (stored.handler as (e: unknown) => unknown)(event);
				if (returned instanceof Promise) {
					void returned.catch((err) => this.reportHandlerError(stored, err));
				}
			} catch (err) {
				this.reportHandlerError(stored, err);
			}
		}
	}

	private reportHandlerError(stored: StoredHandler, err: unknown): void {
		this.report(
			`imp: extension ${stored.source} handler error (${stored.event}) — ${firstLine(errorText(err), 160)}`,
		);
	}

	/** First registration of `name` wins: committed owners first, then the open section itself. */
	private conflictOwner<T>(
		committed: Map<string, string>,
		open: readonly T[],
		name: string,
		getName: (item: T) => string,
	): string | undefined {
		const owner = committed.get(name);
		if (owner !== undefined) return owner;
		return open.some((item) => getName(item) === name) ? this.sectionName() : undefined;
	}

	private sectionName(): string {
		return this.section?.name ?? "(unknown)";
	}
}
