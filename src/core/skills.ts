/**
 * Skills (M12) — self-contained capability packages the model loads on demand.
 *
 * A skill is a directory with SKILL.md (YAML frontmatter + Markdown body), per
 * the Agent Skills standard (agentskills.io). Progressive disclosure: only
 * name + description + location enter the system prompt (formatSkillsForPrompt);
 * the model reads the full body with the existing read tool when a task
 * matches. Users force-load one via /skill:name (batch 2).
 *
 * pi parity (packages/coding-agent/src/core/skills.ts + package-manager.ts's
 * collectAncestorAgentsSkillDirs): discovery rules, lenient validation
 * (warn-not-block; missing description = skip), realpath dedup, first-wins
 * name collisions, the `.agents/skills` ancestor walk to the git root, and the
 * user-global `~/.agents/skills` carve-out. Precedence, first-wins: explicit
 * paths (CLI --skill, then settings) > project tiers > user tiers — explicit
 * intent outranks discovery, local outranks global (imp's md-commands rule;
 * pi loads project resources before user ones too).
 *
 * Deliberate divergences from pi (design Appendix A): no ignore-file scanning
 * (node_modules/dot-entry skipping covers the practical blast radius), plain
 * warning objects instead of pi's diagnostic framework, and one combined
 * name-validation message instead of per-rule strings.
 */
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RegisteredExtensionCommand } from "../extensions/types.js";
import type { CommandOutcome } from "../repl/commands.js";

/** Max name length per the Agent Skills spec. */
const MAX_NAME_LENGTH = 64;
/** Max description length per the spec. */
const MAX_DESCRIPTION_LENGTH = 1024;

export interface Skill {
	name: string;
	/** What the skill does and when to use it — the progressive-disclosure key. */
	description: string;
	/** Absolute path to the SKILL.md (or bare .md) file. */
	filePath: string;
	/** dirname(filePath) — where the skill's relative references resolve. */
	baseDir: string;
	source: "user" | "project" | "path";
	/** `disable-model-invocation: true` — hidden from the prompt, /skill: only. */
	disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
	type: "warning";
	message: string;
	path: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}

/** Frontmatter + body of a Markdown file. Throws on malformed YAML. */
export function parseSkillFile(content: string): { frontmatter: Record<string, unknown>; body: string } {
	// BOM strip + newline normalize (Windows editors) — same as pi's frontmatter util.
	const normalized = content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: normalized };
	const parsed = parseYaml(normalized.slice(4, end));
	return {
		frontmatter: (parsed ?? {}) as Record<string, unknown>,
		body: normalized.slice(end + 4).trim(),
	};
}

/** Name validation, spec rules, one combined message (design §7): warn-not-block. */
function nameWarning(name: string, filePath: string): SkillDiagnostic | null {
	const valid =
		name.length >= 1 &&
		name.length <= MAX_NAME_LENGTH &&
		/^[a-z0-9-]+$/.test(name) &&
		!name.startsWith("-") &&
		!name.endsWith("-") &&
		!name.includes("--");
	if (valid) return null;
	return {
		type: "warning",
		message: `skill name "${name}" (${filePath}) invalid: must be 1-64 chars, lowercase letters, digits, hyphens`,
		path: filePath,
	};
}

function loadSkillFromFile(
	filePath: string,
	source: Skill["source"],
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
	const diagnostics: SkillDiagnostic[] = [];
	const isDeclaredSkill = basename(filePath) === "SKILL.md";

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const message = err instanceof Error ? err.message : "failed to read skill file";
		diagnostics.push({
			type: "warning",
			message: `skill file "${filePath}" failed to read: ${message}`,
			path: filePath,
		});
		return { skill: null, diagnostics };
	}

	let parsed: ReturnType<typeof parseSkillFile>;
	try {
		parsed = parseSkillFile(raw);
	} catch (err) {
		// A declared SKILL.md that cannot parse is a broken skill — warn + skip.
		// Other .md files without frontmatter are simply not skills — silent.
		if (isDeclaredSkill) {
			const message = err instanceof Error ? err.message.split("\n")[0] : "failed to parse skill file";
			diagnostics.push({
				type: "warning",
				message: `skill file "${filePath}" failed to parse: ${message}`,
				path: filePath,
			});
		}
		return { skill: null, diagnostics };
	}

	const { frontmatter } = parsed;
	// Resolved name FIRST (review A4): description diagnostics label the skill
	// by the name it would load under — frontmatter name if present, parent
	// directory otherwise. The name may differ from the directory (pi's
	// deliberate standard divergence — shared .agents/skills trees serve many
	// harnesses).
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : "";
	const name = frontmatterName || basename(dirname(filePath));
	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	if (!hasDescription && !isDeclaredSkill) return { skill: null, diagnostics };
	if (!hasDescription) {
		diagnostics.push({
			type: "warning",
			message: `skill "${name}" (${filePath}) ignored — description is required`,
			path: filePath,
		});
		return { skill: null, diagnostics };
	}
	const descriptionText = description as string;
	if (descriptionText.length > MAX_DESCRIPTION_LENGTH) {
		diagnostics.push({
			type: "warning",
			message: `skill "${name}" (${filePath}): description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${descriptionText.length})`,
			path: filePath,
		});
	}

	const warning = nameWarning(name, filePath);
	if (warning !== null) diagnostics.push(warning);

	return {
		skill: {
			name,
			description: descriptionText,
			filePath,
			baseDir: dirname(filePath),
			source,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

/**
 * Bare-.md discovery mode per root directory type (pi's SkillDiscoveryMode):
 * - "imp"     — `.imp/skills` and `~/.imp/skills` roots: root-level bare .md
 *               files ARE skills; nested .md only inside SKILL.md roots.
 * - "agents"  — `.agents/skills` roots: root-level bare .md is IGNORED;
 *               .md nested inside grouping subdirectories IS discovered.
 * Explicit paths (settings/CLI) behave like "imp" (root .md included).
 */
type DiscoveryMode = "imp" | "agents";

function scanSkillsDir(
	dir: string,
	mode: DiscoveryMode,
	source: Skill["source"],
	rootDir: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	if (!existsSync(dir)) return { skills, diagnostics };

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { skills, diagnostics };
	}

	// A directory containing SKILL.md is ONE skill — no deeper recursion
	// (a broken SKILL.md still stops the scan; pi returns the same way).
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		const full = join(dir, entry.name);
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				isFile = statSync(full).isFile();
			} catch {
				continue; // broken symlink → fall through to the directory scan
			}
		}
		if (!isFile) continue;
		const result = loadSkillFromFile(full, source);
		if (result.skill !== null) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(full);
				isDirectory = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue;
			}
		}
		if (isDirectory) {
			const sub = scanSkillsDir(full, mode, source, rootDir);
			skills.push(...sub.skills);
			diagnostics.push(...sub.diagnostics);
			continue;
		}
		// Root-tier rule (pi: mode "pi" && dir===root, mode "agents" && dir!==root).
		const atRoot = dir === rootDir;
		const bareMdAllowed = mode === "imp" ? atRoot : !atRoot;
		if (isFile && bareMdAllowed && entry.name.endsWith(".md")) {
			const result = loadSkillFromFile(full, source);
			if (result.skill !== null) skills.push(result.skill);
			diagnostics.push(...result.diagnostics);
		}
	}

	return { skills, diagnostics };
}

/** Nearest ancestor containing .git — the ancestor `.agents/skills` walk stops here. */
function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * `.agents/skills` directories from cwd up to the git repo root (inclusive),
 * cwd first, excluding the user-global ~/.agents/skills itself — that one is
 * the user's own installation and never a project resource (pi parity).
 */
export function ancestorAgentsSkillDirs(cwd: string, home: string): string[] {
	const userGlobal = resolve(home, ".agents", "skills");
	const gitRoot = findGitRepoRoot(cwd);
	const dirs: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, ".agents", "skills");
		// Canonicalized compare (review A2): resolve() alone misses symlinked
		// homes (/var vs /private/var aliasing), misclassifying the user-global
		// dir as a project resource — over-gating (fail-closed), never a bypass,
		// but a spurious trust ask under aliased homes. pi's trust side
		// canonicalizes too (trust-manager.ts uses canonicalizePath).
		if (canonicalize(candidate) !== canonicalize(userGlobal)) dirs.push(candidate);
		if (gitRoot !== null && dir === gitRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function canonicalize(filePath: string): string {
	try {
		return realpathSync(filePath);
	} catch {
		return resolve(filePath);
	}
}

export interface LoadSkillsOptions {
	cwd: string;
	/** Home dir (injectable — hermetic tests). */
	home: string;
	/** M8 trust gate: false skips both project tiers entirely. */
	projectTrusted: boolean;
	/** `--no-skills`: skip every default location; explicitPaths still load. */
	noSkills: boolean;
	/** Explicit paths in precedence order (CLI --skill entries first, then
	 * settings `skills` entries) — the caller has already applied --no-skills
	 * to the settings half. Files (.md) or directories. */
	explicitPaths: string[];
}

/** Load skills from every configured location; first-wins on name collisions. */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { cwd, home, projectTrusted, noSkills, explicitPaths } = options;
	const byName = new Map<string, Skill>();
	const seenRealPaths = new Set<string>();
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];

	const add = (result: LoadSkillsResult): void => {
		diagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const real = canonicalize(skill.filePath);
			if (seenRealPaths.has(real)) continue; // same file via symlink/overlap
			const existing = byName.get(skill.name);
			if (existing !== undefined) {
				diagnostics.push({
					type: "warning",
					message: `skill name collision: "${skill.name}" from ${skill.filePath} loses to ${existing.filePath} (first loaded wins)`,
					path: skill.filePath,
				});
				continue;
			}
			// Mark seen only on the winner (pi's shape, review A3): a third copy of
			// a losing file re-warns the collision instead of vanishing silently.
			seenRealPaths.add(real);
			byName.set(skill.name, skill);
			skills.push(skill);
		}
	};

	// Explicit paths FIRST — explicit intent outranks discovery (design §6
	// revision note: imp's md-commands rule "explicit/local outranks discovered";
	// pi's own loadSkills, unlike its resource loader, adds defaults first).
	for (const raw of explicitPaths) {
		const expanded = raw.startsWith("~") ? join(home, raw.slice(1)) : raw;
		const resolved = resolve(cwd, expanded);
		if (!existsSync(resolved)) {
			diagnostics.push({
				type: "warning",
				message: `skill path "${raw}" does not exist — skipped`,
				path: resolved,
			});
			continue;
		}
		// stat inside the try (review A1): existsSync→statSync is a TOCTOU —
		// a path deleted between the two must downgrade to a warning, not
		// take the whole startup down (pi wraps its explicit paths too).
		try {
			const stats = statSync(resolved);
			if (stats.isDirectory()) {
				add(scanSkillsDir(resolved, "imp", "path", resolved));
			} else if (stats.isFile() && resolved.endsWith(".md")) {
				const result = loadSkillFromFile(resolved, "path");
				add({ skills: result.skill !== null ? [result.skill] : [], diagnostics: result.diagnostics });
			} else {
				diagnostics.push({
					type: "warning",
					message: `skill path "${raw}" is not a markdown file — skipped`,
					path: resolved,
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message.split("\n")[0] : "failed to stat skill path";
			diagnostics.push({
				type: "warning",
				message: `skill path "${raw}" failed to stat: ${message}`,
				path: resolved,
			});
		}
	}

	if (!noSkills) {
		if (projectTrusted) {
			add(scanSkillsDir(join(cwd, ".imp", "skills"), "imp", "project", join(cwd, ".imp", "skills")));
			for (const dir of ancestorAgentsSkillDirs(cwd, home)) {
				add(scanSkillsDir(dir, "agents", "project", dir));
			}
		}
		add(scanSkillsDir(join(home, ".imp", "skills"), "imp", "user", join(home, ".imp", "skills")));
		add(scanSkillsDir(join(home, ".agents", "skills"), "agents", "user", join(home, ".agents", "skills")));
	}

	return { skills, diagnostics };
}

export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * The system-prompt block (pi's formatSkillsForPrompt, spec-recommended XML).
 * Only model-invocable skills appear; disable-model-invocation ones are
 * /skill:-only. Empty input → "" (never an empty <available_skills/>).
 */
export function formatSkillsForPrompt(
	skillList: readonly Skill[],
	fileReadTool: "read" | "bash" = "read",
): string {
	const visible = skillList.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: "Use bash to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Invocation plane (batch 2): /skill:name commands. Design §11.
// ---------------------------------------------------------------------------

/** /help row summary: the description collapsed to one line, first 80 chars. */
function skillSummary(description: string): string {
	const oneLine = description.replace(/\s+/g, " ").trim();
	return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/** The transcript echo / replay summary line for a skill invocation. */
export function skillDisplayLine(name: string, args: string): string {
	return `▪ skill: ${name}${args.trim() === "" ? "" : ` (${args.trim()})`}`;
}

/** Replay collapse (design §11.3): a user message that IS an expanded skill
 *  block renders as its summary line. Returns null for anything else. */
export function skillBlockSummary(content: string): string | null {
	if (!content.startsWith('<skill name="')) return null;
	const end = content.indexOf('"', 13);
	if (end === -1) return null;
	const name = content.slice(13, end);
	if (name === "") return null;
	return `▪ skill: ${name}`;
}

/** Expand a skill invocation to the exact pi-parity block (§11.2, pi
 *  agent-session.ts _expandSkillCommand):
 *
 *   <skill name="NAME" location="/abs/SKILL.md">
 *   References are relative to /abs/skill-dir.
 *
 *   BODY-WITHOUT-FRONTMATTER
 *   </skill>
 *
 *   ARGS          ← omitted (with its blank line) when args are empty
 *
 * Throws on read/parse failure — the command wrapper turns it into the
 * teaching error line. */
export function expandSkillBlock(skill: Skill, args: string): string {
	const content = readFileSync(skill.filePath, "utf8");
	const body = parseSkillFile(content).body.trim();
	const block =
		`<skill name="${skill.name}" location="${skill.filePath}">\n` +
		`References are relative to ${skill.baseDir}.\n\n` +
		`${body}\n</skill>`;
	const trimmedArgs = args.trim();
	return trimmedArgs === "" ? block : `${block}\n\n${trimmedArgs}`;
}

export interface BuildSkillCommandsOptions {
	/** enableSkillCommands === false disables registration entirely (§11.1). */
	enabled: boolean;
	/** Names already claimed by builtins/extensions/md commands — skills
	 *  yield with a warning (registration order §11.1). */
	reserved: ReadonlySet<string>;
	/** Teaching lines for skipped registrations. */
	onDiagnostic?: (message: string) => void;
}

/** Register one `skill:NAME` command per loaded skill, riding the md-command
 *  pipeline shape. disable-model-invocation skills still register — that is
 *  the point of the flag (user-only invocation). */
export function buildSkillCommands(
	skills: readonly Skill[],
	options: BuildSkillCommandsOptions,
): RegisteredExtensionCommand[] {
	if (!options.enabled) return [];
	const commands: RegisteredExtensionCommand[] = [];
	for (const skill of skills) {
		const name = `skill:${skill.name}`;
		if (options.reserved.has(name)) {
			options.onDiagnostic?.(
				`imp: skill command /${name} skipped — a command with that name is already registered`,
			);
			continue;
		}
		commands.push({
			command: {
				name,
				summary: skillSummary(skill.description),
				allowedDuringRun: false,
				run: (args, ctx): CommandOutcome => {
					// Read at invocation time (pi parity): a skill deleted or
					// edited after startup is honored as it exists NOW.
					try {
						ctx.submitPrompt(expandSkillBlock(skill, args), {
							display: skillDisplayLine(skill.name, args),
						});
					} catch (err) {
						// Teaching error, nothing reaches the model (Appendix A:
						// pi forwards the raw text instead — imp never sends
						// unexpanded command lines).
						const message = err instanceof Error ? err.message.split("\n")[0] : "failed to read";
						ctx.renderer.error(`imp: /${name} failed to read ${skill.filePath}: ${message}`);
					}
					return "handled";
				},
			},
			source: "skill",
		});
	}
	return commands;
}
