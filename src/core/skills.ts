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
	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	if (!hasDescription && !isDeclaredSkill) return { skill: null, diagnostics };
	if (!hasDescription) {
		diagnostics.push({
			type: "warning",
			message: `skill "${basename(dirname(filePath))}" (${filePath}) ignored — description is required`,
			path: filePath,
		});
		return { skill: null, diagnostics };
	}
	const descriptionText = description as string;
	if (descriptionText.length > MAX_DESCRIPTION_LENGTH) {
		diagnostics.push({
			type: "warning",
			message: `skill "${basename(dirname(filePath))}" (${filePath}): description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${descriptionText.length})`,
			path: filePath,
		});
	}

	// Frontmatter name wins; empty/absent falls back to the parent directory
	// name. The name may differ from the directory (pi's deliberate standard
	// divergence — shared .agents/skills trees serve many harnesses).
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : "";
	const name = frontmatterName || basename(dirname(filePath));
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
		if (resolve(candidate) !== userGlobal) dirs.push(candidate);
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
			seenRealPaths.add(real);
			const existing = byName.get(skill.name);
			if (existing !== undefined) {
				diagnostics.push({
					type: "warning",
					message: `skill name collision: "${skill.name}" from ${skill.filePath} loses to ${existing.filePath} (first loaded wins)`,
					path: skill.filePath,
				});
				continue;
			}
			byName.set(skill.name, skill);
			skills.push(skill);
		}
	};

	// Explicit paths FIRST — explicit intent outranks discovery (cli --skill,
	// then settings entries; the caller orders them), matching how pi merges
	// CLI-enabled resources ahead of discovered ones.
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

function escapeXml(text: string): string {
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
