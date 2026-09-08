/**
 * Markdown quick commands (M11 #6) — a file in a commands directory IS a
 * slash command. The CC-parity affordance for "send this prompt" without
 * writing an extension module.
 *
 *   ~/.imp/commands/fix.md        global — every project
 *   <cwd>/.imp/commands/review.md project — this repo only
 *
 * Format (same hand-rolled frontmatter style as the agents registry):
 *
 *   ---
 *   description: Review the current diff, risk-ordered
 *   allowedDuringRun: false
 *   ---
 *   Review `git diff`. List issues by risk. $ARGUMENTS
 *
 * Rules:
 *  - name = filename stem, [a-z0-9][a-z0-9_-]* (validated);
 *  - built-in command names are reserved — a colliding file is rejected
 *    with a teaching line (mirrors the extension contract);
 *  - a project file with the same stem as a global one WINS (local intent
 *    outranks the global default; the /help tag shows the tier);
 *  - the project tier loads only when the M8 trust gate admits it — a
 *    cloned repo must not grow commands that talk to the model;
 *  - `$ARGUMENTS` substitutes the command args; without the placeholder,
 *    non-empty args append as their own paragraph;
 *  - command output is a PROMPT: it goes through the machine's normal
 *    turn/queue semantics (ctx.submitPrompt), never straight to the model.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegisteredExtensionCommand } from "../extensions/types.js";
import type { CommandOutcome } from "../repl/commands.js";

export interface MdCommandLoadOptions {
	cwd: string;
	home: string;
	/** M8 trust decision for the project tier; false loads global files only. */
	projectAllowed: boolean;
	/** Names that may not be shadowed: built-ins AND already-loaded
	 *  extension commands (cli passes both — a silent shadow plus a doubled
	 *  /help row was the review finding). */
	reserved: ReadonlySet<string>;
	/** Teaching lines for rejected files (mirrors the extension diagnostics). */
	onDiagnostic?: (message: string) => void;
}

export interface MdCommandLoadResult {
	/** Global tier first, then project — later entries replace same-named
	 *  earlier ones, so project wins. */
	commands: RegisteredExtensionCommand[];
}

interface ParsedFrontmatter {
	description?: string;
	allowedDuringRun: boolean;
	body: string;
}

// Lowercase only: dispatch matches names case-sensitively, so an uppercase
// file would register a command nobody can type (review P2).
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Parse `--- key: value ---` frontmatter; every field optional (the whole
 *  frontmatter block is). Returns an error string for malformed blocks. */
export function parseMdFrontmatter(content: string, source: string): ParsedFrontmatter | string {
	// Windows editors prepend a BOM — strip it or the frontmatter check fails
	// and the whole file silently becomes the prompt body (review P2).
	const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
	if (!text.startsWith("---")) return { allowedDuringRun: false, body: text.trim() };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return `${source}: unterminated frontmatter — close it with a "---" line`;
	const fields = new Map<string, string>();
	for (const line of text.slice(4, end).split("\n")) {
		if (line.trim() === "") continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key !== "" && value !== "") fields.set(key, value);
	}
	let allowedDuringRun = false;
	const allowRaw = fields.get("allowedDuringRun");
	if (allowRaw !== undefined) {
		const flag = allowRaw.toLowerCase();
		if (flag === "true") allowedDuringRun = true;
		else if (flag !== "false") {
			return `${source}: invalid "allowedDuringRun" "${allowRaw}" — use true or false`;
		}
	}
	return {
		description: fields.get("description"),
		allowedDuringRun,
		body: text.slice(end + 4).trim(),
	};
}

/** Render the prompt: $ARGUMENTS substitutes, or args append as a paragraph. */
export function renderMdPrompt(body: string, args: string): string {
	const trimmedArgs = args.trim();
	if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", trimmedArgs);
	return trimmedArgs === "" ? body : `${body}\n\n${trimmedArgs}`;
}

export async function loadMdCommands(options: MdCommandLoadOptions): Promise<MdCommandLoadResult> {
	const tiers: Array<{ dir: string; source: string }> = [
		{ dir: join(options.home, ".imp", "commands"), source: "md:global" },
	];
	if (options.projectAllowed)
		tiers.push({ dir: join(options.cwd, ".imp", "commands"), source: "md:project" });
	// Insertion order: global first, then project — later same-name entries
	// REPLACE earlier ones, which is exactly the override rule.
	const byName = new Map<string, RegisteredExtensionCommand>();
	for (const tier of tiers) {
		let files: string[] = [];
		try {
			files = readdirSync(tier.dir).filter((f) => f.endsWith(".md"));
		} catch {
			continue; // no directory — the common case
		}
		for (const file of files.sort()) {
			const name = file.slice(0, -3);
			const source = `${tier.dir}/${file}`;
			if (!NAME_RE.test(name)) {
				options.onDiagnostic?.(
					`imp: command file "${file}" ignored — the name must match [a-z0-9][a-z0-9_-]*`,
				);
				continue;
			}
			if (options.reserved.has(name)) {
				options.onDiagnostic?.(
					`imp: command file "${file}" ignored — "/${name}" is a built-in command (built-in names are reserved)`,
				);
				continue;
			}
			let parsed: ParsedFrontmatter | string;
			try {
				parsed = parseMdFrontmatter(readFileSync(join(tier.dir, file), "utf8"), source);
			} catch (err) {
				options.onDiagnostic?.(`imp: command file "${file}" could not be read — ${String(err)}`);
				continue;
			}
			if (typeof parsed === "string") {
				options.onDiagnostic?.(parsed);
				continue;
			}
			if (parsed.body === "") {
				options.onDiagnostic?.(`imp: command file "${file}" ignored — the prompt body is empty`);
				continue;
			}
			const body = parsed.body;
			byName.set(name, {
				command: {
					name,
					summary: parsed.description ?? `markdown command (${tier.source})`,
					allowedDuringRun: parsed.allowedDuringRun,
					run: (args, ctx): CommandOutcome => {
						ctx.submitPrompt(renderMdPrompt(body, args));
						return "handled";
					},
				},
				source: tier.source,
			});
		}
	}
	return { commands: [...byName.values()] };
}
