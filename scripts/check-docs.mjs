#!/usr/bin/env node
/**
 * check-docs.mjs (self-docs-design rev 3, D6): structural guard for the
 * published docs set. Wired into `npm run lint:scripts`.
 *
 * Checks:
 *  (a) the ten user-facing docs exist at docs/ top level;
 *  (b) SELF_DOCS_TOPICS in src/core/self-docs.ts names only existing docs
 *      (regex extraction — one `doc: "..."` literal per line, pinned by
 *      test/self-docs.test.ts);
 *  (c) docs/index.md's relative markdown links resolve;
 *  (d) every top-level doc's relative links resolve (missing targets make
 *      the model's routing land on 404s).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const failures = [];

function join(...parts) {
	return parts.join("/").replace(/\/+/g, "/");
}

const REQUIRED_DOCS = [
	"index.md",
	"cli.md",
	"providers.md",
	"sessions.md",
	"settings.md",
	"extensions.md",
	"skills.md",
	"mcp.md",
	"subagents.md",
	"images.md",
];

// (a) required docs exist
for (const doc of REQUIRED_DOCS) {
	if (!existsSync(join(docsDir, doc))) failures.push(`missing required doc: docs/${doc}`);
}

// (b) SELF_DOCS_TOPICS entries exist (regex, single-line literals)
const selfDocsSource = readFileSync(join(root, "src", "core", "self-docs.ts"), "utf8");
const topicDocs = [...selfDocsSource.matchAll(/doc:\s*"(docs\/[a-z0-9-]+\.md)"/g)].map((m) => m[1]);
if (topicDocs.length === 0) {
	failures.push("no topic docs extracted from src/core/self-docs.ts — regex/format drift?");
}
for (const doc of topicDocs) {
	if (!existsSync(join(root, doc))) failures.push(`SELF_DOCS_TOPICS names a missing doc: ${doc}`);
}

// (c)+(d) relative markdown links in top-level docs resolve
function checkLinks(file, label) {
	const text = readFileSync(file, "utf8");
	for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
		const target = match[1];
		if (/^[a-z]+:\/\//i.test(target) || target.startsWith("/")) continue; // external/absolute
		const resolved = resolve(dirname(file), target);
		if (!existsSync(resolved)) failures.push(`${label}: broken relative link → ${target}`);
	}
}

for (const doc of REQUIRED_DOCS) {
	const file = join(docsDir, doc);
	if (existsSync(file)) checkLinks(file, `docs/${doc}`);
}

if (failures.length > 0) {
	console.error(`check-docs: ${failures.length} failure(s)`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`check-docs: ${REQUIRED_DOCS.length} docs, ${topicDocs.length} topic routes, links OK`);
