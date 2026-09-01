import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { firstLine, VERSION } from "../format.js";
import { ExtensionRegistry } from "./registry.js";
import type {
	ExtensionApi,
	ExtensionEventHandlerMap,
	ExtensionEventName,
	ExtensionFactory,
	ExtensionFailure,
	ExtensionOrigin,
	ExtensionSummary,
} from "./types.js";

export interface LoadExtensionsOptions {
	cwd: string;
	/** Paths from repeatable -e/--extension flags, in flag order. */
	cliPaths: readonly string[];
	/** -ne/--no-extensions: skip both discovery dirs (explicit -e paths still load). */
	noDiscovery?: boolean;
	/** Overrides os.homedir() — hermetic tests point the global dir at a temp dir. */
	home?: string;
	/** Receives teaching-style diagnostic lines as they are discovered (renderer-backed). */
	onDiagnostic?: (line: string) => void;
}

export interface LoadedExtensions {
	/** The runtime the runner/repl consume (tools, commands, context, emits). */
	readonly runtime: ExtensionRegistry;
	/** Per-extension summaries for the startup banner, in load order. */
	readonly summaries: readonly ExtensionSummary[];
	/** Extensions that failed to load (already reported via onDiagnostic). */
	readonly failures: readonly ExtensionFailure[];
}

interface ExtensionCandidate {
	/** Absolute file path of the extension module. */
	path: string;
	/** Extension name: basename without extension (design §5.1). */
	name: string;
	origin: ExtensionOrigin;
}

/** The E2 rename hint, appended to any failed `.js` import (design §12). */
const JS_HINT =
	'hint: bare ".js" files without a module-typed package.json are CommonJS to Node — rename to ".mjs" or add package.json {"type":"module"}';

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function errorDetail(err: unknown): string {
	return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** Code-point order (not UTF-16 code-unit order) — design §3.2, risk 3. */
function compareCodePoints(a: string, b: string): number {
	if (a === b) return 0;
	const pa = [...a].map((ch) => ch.codePointAt(0) ?? 0);
	const pb = [...b].map((ch) => ch.codePointAt(0) ?? 0);
	const shared = Math.min(pa.length, pb.length);
	for (let i = 0; i < shared; i++) {
		const left = pa[i] ?? 0;
		const right = pb[i] ?? 0;
		if (left !== right) return left < right ? -1 : 1;
	}
	return pa.length - pb.length;
}

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function realpathOf(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return target; // broken symlink / vanished path — the import step reports it
	}
}

/**
 * Direct entries of one discovery directory (design §3.2): `*.mjs` / `*.js`
 * files and `dir/index.*` packages, skipping dotfiles and `_`-prefixed names.
 * Returned in code-point order of the entry name.
 */
function dirEntries(dir: string): Array<{ name: string; isDir: boolean }> {
	let dirents: Dirent[];
	try {
		dirents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return []; // unreadable/missing — skip silently, like context files
	}
	const entries: Array<{ name: string; isDir: boolean }> = [];
	for (const dirent of dirents) {
		if (dirent.name.startsWith(".") || dirent.name.startsWith("_")) continue;
		const full = path.join(dir, dirent.name);
		// stat (unlike Dirent kinds) follows symlinks, so a linked extension
		// file or dir behaves like the real thing — realpath dedup then applies.
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(full);
		} catch {
			continue; // broken symlink / vanished entry
		}
		if (stats.isFile() && (dirent.name.endsWith(".mjs") || dirent.name.endsWith(".js"))) {
			entries.push({ name: dirent.name, isDir: false });
		} else if (
			stats.isDirectory() &&
			(existsSync(path.join(full, "index.mjs")) || existsSync(path.join(full, "index.js")))
		) {
			entries.push({ name: dirent.name, isDir: true });
		}
	}
	return entries.sort((a, b) => compareCodePoints(a.name, b.name));
}

/**
 * Candidate order is load order (design §3.1): `-e` flags (each a file or a
 * directory using the same entry rules), then `<cwd>/.imp/extensions/`, then
 * `~/.imp/extensions/`. Deduplicated by realpath across all sources, keeping
 * the first occurrence (and its origin).
 */
function discoverCandidates(options: LoadExtensionsOptions): ExtensionCandidate[] {
	const candidates: ExtensionCandidate[] = [];
	const seen = new Set<string>();
	const add = (candidate: ExtensionCandidate): void => {
		const key = realpathOf(candidate.path);
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};
	const addDir = (dir: string, origin: ExtensionOrigin): void => {
		for (const entry of dirEntries(dir)) {
			const entryPath = entry.isDir
				? path.join(
						dir,
						entry.name,
						existsSync(path.join(dir, entry.name, "index.mjs")) ? "index.mjs" : "index.js",
					)
				: path.join(dir, entry.name);
			add({ path: entryPath, name: entry.name.replace(/\.(mjs|js)$/, ""), origin });
		}
	};

	for (const cliPath of options.cliPaths) {
		const resolved = path.resolve(cliPath);
		if (isDirectory(resolved)) {
			addDir(resolved, "cli");
		} else {
			add({ path: resolved, name: path.basename(resolved).replace(/\.(mjs|js)$/, ""), origin: "cli" });
		}
	}
	if (!options.noDiscovery) {
		const projectDir = path.join(options.cwd, ".imp", "extensions");
		if (isDirectory(projectDir)) addDir(projectDir, "project");
		const globalDir = path.join(options.home ?? os.homedir(), ".imp", "extensions");
		if (isDirectory(globalDir)) addDir(globalDir, "global");
	}
	return candidates;
}

/**
 * Build the per-extension api object (design §6). Registration and
 * subscription only work while the factory runs — attempts afterwards are
 * reported, not silently dropped and not thrown.
 */
function extensionApi(
	registry: ExtensionRegistry,
	facts: { cwd: string; version: string; origin: ExtensionOrigin; name: string },
	report: (line: string) => void,
): ExtensionApi {
	const whileLoading = (what: string, register: () => void): void => {
		if (!registry.hasOpenSection()) {
			report(
				`imp: extension ${facts.name} could not ${what} — registration only works while the factory runs`,
			);
			return;
		}
		register();
	};
	return {
		cwd: facts.cwd,
		version: facts.version,
		origin: facts.origin,
		registerTool: (tool) =>
			whileLoading(`register tool "${String(tool?.name ?? tool)}"`, () => registry.registerTool(tool)),
		registerCommand: (command) =>
			whileLoading(`register command "${String(command?.name ?? command)}"`, () =>
				registry.registerCommand(command),
			),
		registerContext: (id, text) =>
			whileLoading(`register context "${String(id)}"`, () => registry.registerContext(id, text)),
		on: (event: ExtensionEventName, handler: ExtensionEventHandlerMap[ExtensionEventName]): void => {
			whileLoading(`subscribe to ${String(event)}`, () => registry.subscribe(event, handler));
		},
	};
}

/**
 * Load every discovered extension (design §7.1): plain `await import()` of
 * real files, factories awaited before the runner starts, and three layers of
 * isolation — import failure, bad default export, and a thrown factory each
 * discard that one extension while the rest load. Never throws.
 */
export async function loadExtensions(options: LoadExtensionsOptions): Promise<LoadedExtensions> {
	const report = options.onDiagnostic ?? (() => {});
	const registry = new ExtensionRegistry({ report });
	const summaries: ExtensionSummary[] = [];
	const failures: ExtensionFailure[] = [];

	for (const candidate of discoverCandidates(options)) {
		// 1. import (E1, with the E2 hint for bare .js files)
		let mod: { default?: unknown };
		try {
			mod = (await import(pathToFileURL(candidate.path).href)) as { default?: unknown };
		} catch (err) {
			const body = firstLine(errorText(err), 160);
			const hint = candidate.path.endsWith(".js") ? ` ${JS_HINT}` : "";
			report(`imp: extension ${candidate.name} failed to load — ${body}${hint}`);
			failures.push({ path: candidate.path, error: body, detail: errorDetail(err) });
			continue;
		}

		// 2. default export must be a factory (E3)
		const factory = mod.default;
		if (typeof factory !== "function") {
			const body = `default export must be a function, got ${typeof factory}`;
			report(`imp: extension ${candidate.name} failed to load — ${body}`);
			failures.push({ path: candidate.path, error: body, detail: body });
			continue;
		}

		// 3. factory with atomic discard (E4 — same shape as E1)
		registry.beginExtension(candidate.name, candidate.origin);
		try {
			await (factory as ExtensionFactory)(
				extensionApi(
					registry,
					{
						cwd: options.cwd,
						version: VERSION,
						origin: candidate.origin,
						name: candidate.name,
					},
					report,
				),
			);
			const summary = registry.commitExtension();
			if (summary !== null) summaries.push(summary);
		} catch (err) {
			registry.discardExtension();
			const body = firstLine(errorText(err), 160);
			report(`imp: extension ${candidate.name} failed to load — ${body}`);
			failures.push({ path: candidate.path, error: body, detail: errorDetail(err) });
		}
	}

	return { runtime: registry, summaries, failures };
}

/** The `▪ extension …` startup lines (design §7.3): zero categories omitted, counts pluralized. */
export function extensionBannerLines(summaries: readonly ExtensionSummary[]): string[] {
	return summaries.map((summary) => {
		const parts: string[] = [];
		const count = (n: number, singular: string, plural: string): void => {
			if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
		};
		count(summary.toolCount, "tool", "tools");
		count(summary.commandCount, "command", "commands");
		count(summary.contextCount, "context", "contexts");
		count(summary.hookCount, "hook", "hooks");
		const tail = parts.length > 0 ? ` — ${parts.join(", ")}` : " — no registrations";
		return `▪ extension ${summary.name} [${summary.origin}]${tail}`;
	});
}

/**
 * Shared startup-banner printer (design §7.3/§10): cli.ts and the test
 * harness call this one function so the two cannot drift. Zero extensions →
 * silence (the 99% no-extension run stays byte-identical).
 */
export function printExtensionDiagnostics(
	summaries: readonly ExtensionSummary[],
	note: (line: string) => void,
): void {
	for (const line of extensionBannerLines(summaries)) note(line);
}
