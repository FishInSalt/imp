#!/usr/bin/env node
/**
 * check-docs.mjs (self-docs-design rev 3, D6; zh-docs-site-design):
 * structural guard for the published docs set. Wired into
 * `npm run lint:scripts`.
 *
 * Checks:
 *  (a) the ten user-facing docs exist at docs/ top level, plus the full
 *      zh-CN mirror under docs/zh-CN/ (full-mirror policy);
 *  (b) SELF_DOCS_TOPICS in src/core/self-docs.ts names only existing docs
 *      (regex extraction — one `doc: "..."` literal per line, pinned by
 *      test/self-docs.test.ts);
 *  (c) docs/index.md's relative markdown links resolve;
 *  (d) every top-level doc's, both READMEs', and every zh doc's relative
 *      links resolve in their actual locations (missing targets make the
 *      model's routing land on 404s);
 *  (e) structural parity per en↔zh pair (README pair + ten docs): identical
 *      heading level sequences, byte-identical fenced code blocks including
 *      info strings, equal link-target multisets. The README pair allows
 *      exactly two documented differences — the language-switch lines and
 *      the language-home site links — and pins each side's exact target;
 *  (f) anchors: every anchor link's anchor must be found among the heading
 *      slugs of its target's en counterpart (zh anchors are copied en
 *      slugs; the site builder re-slugs them by heading position, which
 *      the parity checks above make well-defined).
 *
 * Link extraction covers inline links (with optional quoted or
 * parenthesized titles). Reference-style link definitions are not used in
 * this corpus and are not covered by these extractors.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headingSlugs } from "./build-docs-site.mjs";

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

// (a) required docs exist in both languages
for (const doc of REQUIRED_DOCS) {
	if (!existsSync(join(docsDir, doc))) failures.push(`missing required doc: docs/${doc}`);
	if (!existsSync(join(docsDir, "zh-CN", doc)))
		failures.push(`missing zh-CN mirror doc: docs/zh-CN/${doc}`);
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

// (b2) every topic doc must be reachable from docs/index.md (design D6
// "topics ↔ index.md 一致" — implementation review N10).
const indexText = readFileSync(join(docsDir, "index.md"), "utf8");
for (const doc of topicDocs) {
	const base = doc.replace(/^docs\//, "");
	if (!indexText.includes(`(${base})`)) {
		failures.push(`docs/index.md does not link topic doc: ${base}`);
	}
}

// (c)+(d) relative markdown links resolve
function checkLinks(file, label) {
	const text = readFileSync(file, "utf8");
	for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g)) {
		const target = match[1];
		if (/^[a-z]+:\/\//i.test(target) || target.startsWith("/")) continue; // external/absolute
		const resolved = resolve(dirname(file), target);
		if (!existsSync(resolved)) failures.push(`${label}: broken relative link → ${target}`);
	}
}

for (const doc of REQUIRED_DOCS) {
	const file = join(docsDir, doc);
	if (existsSync(file)) checkLinks(file, `docs/${doc}`);
	const zhFile = join(docsDir, "zh-CN", doc);
	if (existsSync(zhFile)) checkLinks(zhFile, `docs/zh-CN/${doc}`);
}
checkLinks(join(root, "README.md"), "README.md");
checkLinks(join(root, "README.zh-CN.md"), "README.zh-CN.md");

// (e) structural parity per en↔zh pair
function headingLevels(text) {
	const levels = [];
	let inFence = false;
	for (const line of text.split("\n")) {
		if (/^```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const match = /^(#{1,6})\s/.exec(line);
		if (match) levels.push(match[1].length);
	}
	return levels;
}

function fencedBlocks(text) {
	const blocks = [];
	let current = null;
	for (const line of text.split("\n")) {
		if (current === null) {
			if (/^```/.test(line)) current = [line];
		} else {
			current.push(line);
			if (/^```/.test(line)) {
				blocks.push(current.join("\n"));
				current = null;
			}
		}
	}
	if (current !== null) blocks.push(current.join("\n"));
	return blocks;
}

function linkTargets(text) {
	return [...text.matchAll(/\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g)].map((match) => match[1]);
}

function removeOnce(list, value) {
	const index = list.indexOf(value);
	if (index === -1) return false;
	list.splice(index, 1);
	return true;
}

// README pair: the only documented target differences — one language-switch
// line and one language-home site link per side. Each exact target is
// pinned here (a missing value fails), so drift on either side is loud.
const README_ALLOWED = [
	["en", "README.zh-CN.md"],
	["zh", "README.md"],
	["en", "https://fishinsalt.github.io/ink/"],
	["zh", "https://fishinsalt.github.io/ink/zh/"],
];

function compareParity(enFile, zhFile, label, allowed = null) {
	const en = readFileSync(enFile, "utf8");
	const zh = readFileSync(zhFile, "utf8");
	const enLevels = headingLevels(en);
	const zhLevels = headingLevels(zh);
	if (enLevels.join(",") !== zhLevels.join(",")) {
		failures.push(
			`parity ${label}: heading level sequences differ (en [${enLevels.join(",")}] vs zh [${zhLevels.join(",")}])`,
		);
	}
	const enBlocks = fencedBlocks(en);
	const zhBlocks = fencedBlocks(zh);
	if (enBlocks.length !== zhBlocks.length) {
		failures.push(`parity ${label}: fenced block count differs (${enBlocks.length} vs ${zhBlocks.length})`);
	} else {
		for (let index = 0; index < enBlocks.length; index++) {
			if (enBlocks[index] !== zhBlocks[index]) {
				failures.push(`parity ${label}: fenced block ${index + 1} is not byte-identical`);
				break;
			}
		}
	}
	const enTargets = linkTargets(en);
	const zhTargets = linkTargets(zh);
	if (allowed !== null) {
		for (const [side, value] of allowed) {
			const removed = removeOnce(side === "en" ? enTargets : zhTargets, value);
			if (!removed) failures.push(`parity ${label}: pinned ${side} link target missing: ${value}`);
		}
	}
	const enSorted = [...enTargets].sort();
	const zhSorted = [...zhTargets].sort();
	if (enSorted.join("\n") !== zhSorted.join("\n")) {
		const enOnly = enSorted.filter((value) => !zhSorted.includes(value));
		const zhOnly = zhSorted.filter((value) => !enSorted.includes(value));
		failures.push(
			`parity ${label}: link-target multisets differ (en-only: ${JSON.stringify(enOnly.slice(0, 4))}, zh-only: ${JSON.stringify(zhOnly.slice(0, 4))})`,
		);
	}
}

compareParity(join(root, "README.md"), join(root, "README.zh-CN.md"), "README", README_ALLOWED);
for (const doc of REQUIRED_DOCS) {
	const enFile = join(docsDir, doc);
	const zhFile = join(docsDir, "zh-CN", doc);
	if (existsSync(enFile) && existsSync(zhFile)) compareParity(enFile, zhFile, `docs/${doc}`);
}

// (f) anchors map to the en counterpart's headings
const slugCache = new Map();
async function slugsOf(relPath) {
	if (!slugCache.has(relPath)) {
		slugCache.set(relPath, await headingSlugs(readFileSync(join(root, relPath), "utf8")));
	}
	return slugCache.get(relPath);
}

function enCounterpart(relPath) {
	if (relPath === "README.zh-CN.md") return "README.md";
	const match = /^docs\/zh-CN\/(.+)$/.exec(relPath);
	if (match) return `docs/${match[1]}`;
	return null;
}

async function checkAnchors(relPath) {
	const text = readFileSync(join(root, relPath), "utf8");
	const isZh = relPath.startsWith("docs/zh-CN/") || relPath === "README.zh-CN.md";
	for (const match of text.matchAll(/\]\(([^)\s#]*)#([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g)) {
		const [, pathPart, anchor] = match;
		let target;
		if (pathPart === "") {
			target = isZh ? (enCounterpart(relPath) ?? relPath) : relPath;
		} else {
			if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith("/")) continue;
			const resolved = posix.normalize(posix.join(posix.dirname(relPath), pathPart));
			target = isZh ? (enCounterpart(resolved) ?? resolved) : resolved;
		}
		if (!existsSync(join(root, target))) continue; // resolution is checked above
		const slugs = await slugsOf(target);
		if (!slugs.includes(anchor)) {
			failures.push(`${relPath}: anchor #${anchor} not found among ${target} headings`);
		}
	}
}

const anchorFiles = [
	...REQUIRED_DOCS.map((doc) => `docs/${doc}`),
	...REQUIRED_DOCS.map((doc) => `docs/zh-CN/${doc}`),
	"README.md",
	"README.zh-CN.md",
];
for (const relPath of anchorFiles) {
	if (existsSync(join(root, relPath))) await checkAnchors(relPath);
}

if (failures.length > 0) {
	console.error(`check-docs: ${failures.length} failure(s)`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(
	`check-docs: ${REQUIRED_DOCS.length} docs ×2 languages, ${topicDocs.length} topic routes, links/parity/anchors OK`,
);
