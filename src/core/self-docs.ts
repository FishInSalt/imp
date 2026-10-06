/**
 * Self-docs (self-docs-design.md rev 3, D4): the docs routing section the
 * default system prompt carries so the model can look up Ink's own
 * documentation on demand (pi parity: promptSections.docs).
 *
 * Pure constants + one render function, no IO. The runner resolves install
 * paths via resolveInstallRoot() and passes them through SystemPromptOptions;
 * a missing docs tree (old-install upgrade) renders the empty string and
 * behavior degrades to the pre-self-docs prompt.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute install paths the routing block names. */
export interface SelfDocsPaths {
	readme: string;
	docs: string;
	examples: string;
}

/**
 * Topic→doc routing table, single source of truth. check-docs.mjs extracts
 * the `doc:` literals with a regex, so keep one literal per entry on a
 * single line (pinned by test/self-docs.test.ts).
 */
export const SELF_DOCS_TOPICS: ReadonlyArray<{ match: string; doc: string }> = [
	{ match: "extensions", doc: "docs/extensions.md" },
	{ match: "skills", doc: "docs/skills.md" },
	{ match: "MCP servers", doc: "docs/mcp.md" },
	{ match: "subagents and worktrees", doc: "docs/subagents.md" },
	{ match: "sessions and compaction", doc: "docs/sessions.md" },
	{ match: "settings and SYSTEM.md", doc: "docs/settings.md" },
	{ match: "providers and models", doc: "docs/providers.md" },
	{ match: "images", doc: "docs/images.md" },
	{ match: "CLI and env vars", doc: "docs/cli.md" },
];

/** Length budget for the rendered section (design D4: ≤1100 chars ≈ 280
 *  tokens; the renderer is pinned by test to keep future topic additions
 *  honest). */
export const SELF_DOCS_MAX_CHARS = 1100;

/** Render the docs routing block; undefined paths render "". */
export function selfDocsSection(paths: SelfDocsPaths | undefined): string {
	if (paths === undefined) return "";
	const topics = SELF_DOCS_TOPICS.map(({ match, doc }) => `${match} (${doc})`).join(", ");
	return [
		`Ink documentation (read only when the user asks about ink itself, its tools, extensions, skills, MCP, or sessions):`,
		`- Main documentation: ${paths.readme}`,
		`- Full docs index: ${paths.docs}/index.md`,
		`- Examples: ${paths.examples} (extensions, skills, agents)`,
		`- When reading ink docs or examples, resolve docs/... and examples/... under the paths above, not the current working directory`,
		`- When asked about: ${topics}`,
		`- When working on ink topics, read the docs and follow cross-references before implementing`,
	].join("\n");
}

/**
 * The install root containing docs/ and examples/ (design D4): walk up from
 * this module (src/core/ or dist/core/) to the nearest package.json that
 * also carries docs/index.md — pi's findNodePackageDir semantics, NOT
 * env.ts's fixed ".." (that works only from src/ top level). Returns
 * undefined when no such root exists (old install without a docs tree),
 * which degrades the prompt to the pre-self-docs shape. Memoized: the
 * filesystem does not change under a running process.
 */
export function resolveInstallRoot(startDir?: string): string | undefined {
	// An explicit startDir is a cache bypass: tests exercise distinct roots.
	if (startDir === undefined) {
		if (cacheSettled) return cachedRoot;
		cachedRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));
		cacheSettled = true;
	}
	return startDir === undefined ? cachedRoot : findInstallRoot(startDir);
}

function findInstallRoot(startDir: string): string | undefined {
	let dir = startDir;
	for (;;) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "docs", "index.md"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
// Two-state sentinel: the missing-docs result (undefined) caches too, so an
// old-install process walks the filesystem once, not once per assembleSystem.
let cachedRoot: string | undefined;
let cacheSettled = false;
