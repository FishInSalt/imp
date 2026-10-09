#!/usr/bin/env node
/**
 * build-docs-site.mjs — builds the GitHub Pages documentation site into
 * _site/ from README.md, README.zh-CN.md and the top-level docs pages.
 *
 * The published set mirrors the docs that ship in the npm package (the
 * design archive is excluded): README.md becomes the home page, every
 * top-level docs/<name>.md becomes docs/<name>.html, and the zh-CN mirror
 * (README.zh-CN.md, docs/zh-CN/<name>.md) becomes /zh/ and
 * /zh/docs/<name>.html. Relative links are rewritten for the static site —
 * links between published pages follow their language's .html versions,
 * anchors into translated pages are re-slugged by heading position, and
 * links that leave the published set point at the corresponding GitHub
 * page. Every page carries a language switcher and hreflang alternates.
 *
 * DOC_FILES must stay in sync with REQUIRED_DOCS in scripts/check-docs.mjs
 * (both languages; check-docs verifies the mirror and structural parity).
 *
 * Usage:  node scripts/build-docs-site.mjs   (also `npm run docs:site`)
 * Output: _site/ (gitignored; deployed by .github/workflows/pages.yml)
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = resolve(root, "_site");

const REPO_URL = "https://github.com/FishInSalt/ink";
const SITE_URL = "https://fishinsalt.github.io/ink";
const OG_IMAGE =
	"https://raw.githubusercontent.com/FishInSalt/ink/main/assets/social-preview.png";

// Published docs, in sidebar order. Must stay in sync with REQUIRED_DOCS
// in scripts/check-docs.mjs.
const DOC_FILES = [
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

// Per-language site configuration: source paths, output paths, template strings.
const LANGUAGES = {
	en: {
		htmlLang: "en",
		homeSource: "README.md",
		homeOut: "index.html",
		docsSrcDir: "docs",
		docsOutDir: "docs",
		switcherLabel: "English",
		strings: {
			homeTitle: "Ink — an open-source AI assistant and agent harness for the terminal",
			homeDescription:
				"Ink — an open-source AI assistant and agent harness for the terminal. Sessions, extensions, skills, subagents, and MCP; works with Anthropic, OpenAI, GLM, DeepSeek, and Kimi.",
			tagline: "an AI agent harness for the terminal",
			home: "Home",
			editLabel: "Edit this page on GitHub",
			license: "Ink ships under the MIT license",
			staleNote: null,
		},
		labels: {
			"index.md": "Overview",
			"cli.md": "CLI reference",
			"providers.md": "Providers & models",
			"sessions.md": "Sessions",
			"settings.md": "Settings",
			"extensions.md": "Extensions",
			"skills.md": "Skills",
			"mcp.md": "MCP",
			"subagents.md": "Subagents",
			"images.md": "Images",
		},
	},
	zh: {
		htmlLang: "zh-CN",
		homeSource: "README.zh-CN.md",
		homeOut: "zh/index.html",
		docsSrcDir: "docs/zh-CN",
		docsOutDir: "zh/docs",
		switcherLabel: "简体中文",
		strings: {
			homeTitle: "Ink — 开源终端 AI 助手与 agent 运行框架",
			homeDescription:
				"Ink —— 一个开源的终端 AI 助手与 agent 运行框架：会话、扩展、技能、子代理与 MCP；支持 Anthropic、OpenAI、GLM、DeepSeek 和 Kimi。",
			tagline: "面向终端的 AI agent 运行框架",
			home: "首页",
			editLabel: "在 GitHub 上编辑此页",
			license: "Ink 以 MIT 许可证发布",
			staleNote: "中文翻译可能滞后于英文版本；如有出入，以英文版本为准。",
		},
		labels: {
			"index.md": "总览",
			"cli.md": "CLI 参考",
			"providers.md": "提供商与模型",
			"sessions.md": "会话",
			"settings.md": "设置",
			"extensions.md": "扩展",
			"skills.md": "技能",
			"mcp.md": "MCP",
			"subagents.md": "子代理",
			"images.md": "图片",
		},
	},
};

const SIDEBAR_LINKS = {
	en: [
		["GitHub", REPO_URL],
		["npm", "https://www.npmjs.com/package/ink-agent"],
		["Changelog", `${REPO_URL}/blob/main/CHANGELOG.md`],
	],
	zh: [
		["GitHub", REPO_URL],
		["npm", "https://www.npmjs.com/package/ink-agent"],
		["更新日志", `${REPO_URL}/blob/main/CHANGELOG.md`],
	],
};

// Repo-relative source path → published site path, per language. The zh
// translations copy the English link targets (translation rule), so the zh
// map serves both the zh source paths (sibling links inside zh docs) and
// the English doc paths (the zh home links `docs/…`); README.md maps to the
// English home because its only zh-side reference is the zh home's English
// switch.
const PUBLISHED = {
	en: new Map([
		["README.md", "index.html"],
		["README.zh-CN.md", "zh/index.html"],
		...DOC_FILES.map((file) => [`docs/${file}`, `docs/${file.replace(/\.md$/, ".html")}`]),
	]),
	zh: new Map([
		["README.md", "index.html"],
		["README.zh-CN.md", "zh/index.html"],
		...DOC_FILES.map((file) => [`docs/zh-CN/${file}`, `zh/docs/${file.replace(/\.md$/, ".html")}`]),
		...DOC_FILES.map((file) => [`docs/${file}`, `zh/docs/${file.replace(/\.md$/, ".html")}`]),
	]),
};

const FAVICON =
	"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%230d1016'/%3E%3Ctext%20x='16'%20y='23'%20font-family='Menlo,monospace'%20font-size='19'%20fill='%235eead4'%20text-anchor='middle'%3Ei%3C/text%3E%3C/svg%3E";

export function slugify(text) {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s/g, "-");
}

// GitHub-flavored heading slugs, so in-page anchors (#project-trust) keep
// working on the site.
function addHeadingIds(html) {
	return html.replace(/<h([1-6])>(.*?)<\/h\1>/gs, (whole, level, inner) => {
		if (whole.includes("id=")) return whole;
		const text = inner
			.replace(/<[^>]*>/g, "")
			.replace(/&amp;/g, "&")
			.replace(/&(?:#39|apos);/g, "'");
		return `<h${level} id="${slugify(text)}">${inner}</h${level}>`;
	});
}

// Heading ids in document order for a markdown file — the same ids the
// rendered page carries. Shared with scripts/check-docs.mjs (anchor checks).
export async function headingSlugs(markdown) {
	const html = await marked.parse(markdown);
	return [...addHeadingIds(html).matchAll(/<h[1-6] id="([^"]*)">/g)].map((match) => match[1]);
}

// en↔zh file pairing for anchor re-slugging: zh anchors are copied from the
// English source, so an anchor on a zh page is an English slug; heading
// parity maps it by position to the zh heading id.
function anchorPairOf(repoPath) {
	if (repoPath === "README.md" || repoPath === "README.zh-CN.md") {
		return ["README.md", "README.zh-CN.md"];
	}
	if (repoPath.startsWith("docs/zh-CN/")) {
		return [`docs/${repoPath.slice("docs/zh-CN/".length)}`, repoPath];
	}
	if (/^docs\/[a-z0-9-]+\.md$/.test(repoPath)) {
		return [repoPath, `docs/zh-CN/${repoPath.slice("docs/".length)}`];
	}
	return null;
}

const slugCache = new Map();
async function slugsOf(repoPath) {
	if (!slugCache.has(repoPath)) {
		const markdown = await readFile(resolve(root, repoPath), "utf8");
		slugCache.set(repoPath, await headingSlugs(markdown));
	}
	return slugCache.get(repoPath);
}

async function reSlugAnchor(anchor, pair) {
	if (!pair) return anchor;
	try {
		const [enFile, zhFile] = pair;
		const enSlugs = await slugsOf(enFile);
		const zhSlugs = await slugsOf(zhFile);
		const index = enSlugs.indexOf(anchor);
		if (index === -1 || zhSlugs[index] === undefined) return anchor;
		return zhSlugs[index];
	} catch {
		return anchor;
	}
}

// Rewrite one link target for the static site. Resolution uses the file's
// ACTUAL repo location (sourceDir); emitted hrefs are relative to the
// current page's OUTPUT dir (outDir) — the two coincide for en, and must
// not be conflated for zh.
async function rewriteTarget(target, context) {
	const { sourceDir, outDir, lang, sourcePath } = context;
	if (
		!target ||
		/^[a-z][a-z0-9+.-]*:/i.test(target) ||
		target.startsWith("//") ||
		target.startsWith("#")
	) {
		// Bare in-page anchor: re-slug for zh against the file's own pair.
		if (target.startsWith("#") && lang === "zh" && target.length > 1) {
			const anchor = await reSlugAnchor(target.slice(1), anchorPairOf(sourcePath));
			return `#${anchor}`;
		}
		return target;
	}
	const cut = target.search(/[#?]/);
	const path = cut === -1 ? target : target.slice(0, cut);
	const rest = cut === -1 ? "" : target.slice(cut);
	if (path === "" || path === "." || path === "./") return target;
	const repoPath = posix.normalize(posix.join(sourceDir, path));
	if (repoPath.startsWith("..")) return target; // leaves the repository
	if (repoPath.endsWith("/")) {
		return `${REPO_URL}/tree/main/${repoPath.replace(/\/+$/, "")}`;
	}
	const published = PUBLISHED[lang].get(repoPath);
	if (published !== undefined) {
		const relDir = posix.relative(outDir, posix.dirname(published));
		let anchorOut = rest;
		if (lang === "zh" && rest.startsWith("#")) {
			const anchor = await reSlugAnchor(rest.slice(1), anchorPairOf(repoPath));
			anchorOut = `#${anchor}`;
		}
		return `${relDir === "" ? "" : `${relDir}/`}${posix.basename(published)}${anchorOut}`;
	}
	return `${REPO_URL}/blob/main/${repoPath}${rest}`;
}

async function rewriteArticleLinks(html, context) {
	const pattern = /(href|src)="([^"]*)"/g;
	let result = "";
	let last = 0;
	for (const match of html.matchAll(pattern)) {
		result += html.slice(last, match.index);
		result += `${match[1]}="${await rewriteTarget(match[2], context)}"`;
		last = match.index + match[0].length;
	}
	return result + html.slice(last);
}

async function renderMarkdown(markdown, context) {
	const html = await marked.parse(markdown);
	return rewriteArticleLinks(addHeadingIds(html), context);
}

// First plain paragraph, stripped of inline markdown, for meta description.
function summarize(markdown) {
	let inFence = false;
	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence || line === "") continue;
		if (/^[#<>\-*|]/.test(line)) continue;
		const text = line
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/[*_`]/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (text.length >= 40) {
			return text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text;
		}
	}
	return "";
}

function escapeAttr(text) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const STYLE = `
:root{--bg:#fff;--panel:#f7f9fb;--fg:#1b2333;--dim:#5c6a7e;--line:#e4e8ef;--code:#f4f6f9;--brand:#0f766e;--brand-soft:#0f766e14;}
@media (prefers-color-scheme:dark){:root{--bg:#0d1016;--panel:#12161e;--fg:#d8dee9;--dim:#8a94a6;--line:#222a36;--code:#151a23;--brand:#5eead4;--brand-soft:#5eead41a;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
.layout{max-width:1120px;margin:0 auto;display:flex;padding:0 24px}
.side{flex:0 0 218px;position:sticky;top:0;align-self:flex-start;height:100vh;overflow-y:auto;padding:30px 20px 60px 0;border-right:1px solid var(--line)}
.brand{display:block;font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--fg)}
.brand:hover{text-decoration:none}
.brand .cursor{color:var(--brand);animation:cursor-blink 1.2s infinite}
@keyframes cursor-blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.brand .cursor{animation:none}}
.tagline{font-size:12.5px;color:var(--dim);margin:6px 0 8px}
.lang{font-size:12.5px;color:var(--dim);margin:0 0 22px}
.group{margin:0 0 22px}
.group a{display:block;padding:4px 8px;margin-left:-8px;border-radius:6px;color:var(--fg);font-size:14px}
.group a:hover{background:var(--code);text-decoration:none}
.group a.active{background:var(--brand-soft);color:var(--brand);font-weight:600}
main{flex:1;min-width:0;padding:34px 0 80px 40px}
article{max-width:760px}
article h1{font-size:30px;letter-spacing:-.01em;margin:0 0 18px}
article h2{font-size:21px;letter-spacing:-.01em;margin:44px 0 14px;padding-bottom:6px;border-bottom:1px solid var(--line)}
article h3{font-size:17px;margin:30px 0 10px}
article p{margin:12px 0}
article ul,article ol{padding-left:22px;margin:12px 0}
article li{margin:5px 0}
article code{font:.92em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:2px 5px;border-radius:5px}
article pre{background:var(--code);border:1px solid var(--line);border-radius:9px;padding:14px 16px;overflow-x:auto;margin:16px 0}
article pre code{background:none;padding:0;font-size:12.8px;line-height:1.6}
article blockquote{margin:16px 0;padding:2px 16px;border-left:3px solid var(--line);color:var(--dim)}
article table{border-collapse:collapse;margin:16px 0;display:block;max-width:100%;overflow-x:auto}
article th,article td{border:1px solid var(--line);padding:7px 12px;text-align:left;font-size:14px}
article th{background:var(--panel)}
article img{max-width:100%;height:auto}
article hr{border:none;border-top:1px solid var(--line);margin:32px 0}
.footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap}
.footer a{color:var(--dim);text-decoration:underline}
@media (max-width:860px){
.layout{display:block;padding:0 18px}
.side{position:static;height:auto;border-right:none;border-bottom:1px solid var(--line);padding:22px 0 14px;overflow:visible}
.group{display:flex;flex-wrap:wrap;gap:2px 12px;margin-bottom:14px}
.group a{display:inline-block}
main{padding:24px 0 60px}
}
`;

function relHref(fromOutPath, toOutPath) {
	return posix.relative(posix.dirname(fromOutPath), toOutPath);
}

function canonicalOf(outPath) {
	return outPath.endsWith("index.html") ? `/${outPath.slice(0, -"index.html".length)}` : `/${outPath}`;
}

function renderPage({ lang, title, description, outPath, content, activeFile }) {
	const config = LANGUAGES[lang];
	const strings = config.strings;
	const isDocsPage = activeFile !== null;
	const canonicalPath = canonicalOf(outPath);
	const otherLang = lang === "en" ? "zh" : "en";
	const otherConfig = LANGUAGES[otherLang];
	const otherOut = lang === "en" ? `zh/${outPath}` : outPath.replace(/^zh\//, "");
	const otherCanonicalPath = canonicalOf(otherOut);
	const enCanonicalPath = lang === "en" ? canonicalPath : otherCanonicalPath;
	const zhCanonicalPath = lang === "zh" ? canonicalPath : otherCanonicalPath;
	const switcherSelf = `<strong>${config.switcherLabel}</strong>`;
	const switcherOther = `<a href="${relHref(outPath, otherOut)}">${otherConfig.switcherLabel}</a>`;
	const switcher = lang === "en" ? `${switcherSelf} | ${switcherOther}` : `${switcherOther} | ${switcherSelf}`;
	const editTarget = isDocsPage ? `${config.docsSrcDir}/${activeFile}` : config.homeSource;
	const navItems = [
		{ href: relHref(outPath, config.homeOut), label: strings.home, active: !isDocsPage },
		...DOC_FILES.map((file) => ({
			href: relHref(outPath, `${config.docsOutDir}/${file.replace(/\.md$/, ".html")}`),
			label: config.labels[file],
			active: isDocsPage && file === activeFile,
		})),
	];
	const sidebar = SIDEBAR_LINKS[lang]
		.map(([label, href]) => `<a href="${href}">${label}</a>`)
		.join("\n");
	return `<!doctype html>
<html lang="${config.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
<meta name="description" content="${escapeAttr(description)}">
<link rel="canonical" href="${SITE_URL}${canonicalPath}">
<link rel="alternate" hreflang="en" href="${SITE_URL}${enCanonicalPath}">
<link rel="alternate" hreflang="zh-CN" href="${SITE_URL}${zhCanonicalPath}">
<link rel="alternate" hreflang="x-default" href="${SITE_URL}${enCanonicalPath}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Ink">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${SITE_URL}${canonicalPath}">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body>
<div class="layout">
<aside class="side">
<a class="brand" href="${relHref(outPath, config.homeOut)}">ink<span class="cursor">▌</span></a>
<div class="tagline">${strings.tagline}</div>
<div class="lang">${switcher}</div>
<nav class="group">
${navItems.map((item) => `<a href="${item.href}"${item.active ? ' class="active"' : ""}>${item.label}</a>`).join("\n")}
</nav>
<nav class="group">
${sidebar}
</nav>
</aside>
<main>
<article>
${content}
</article>
<footer class="footer">
<a href="${REPO_URL}/blob/main/${editTarget}">${strings.editLabel}</a>
<span>·</span>
<span>${strings.license}</span>
${strings.staleNote === null ? "" : `<span>·</span>\n<span>${strings.staleNote}</span>`}
<span>·</span>
<span><code>npm install -g ink-agent</code></span>
</footer>
</main>
</div>
</body>
</html>
`;
}

async function writeOut(outDir, relativePath, content) {
	const target = resolve(outDir, relativePath);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
}

export async function buildSite({ outDir = defaultOutDir } = {}) {
	await rm(outDir, { recursive: true, force: true });
	const pages = [];
	for (const lang of ["en", "zh"]) {
		const config = LANGUAGES[lang];
		const homeMarkdown = await readFile(resolve(root, config.homeSource), "utf8");
		const homeContext = {
			sourceDir: posix.dirname(config.homeSource),
			outDir: posix.dirname(config.homeOut),
			lang,
			sourcePath: config.homeSource,
		};
		await writeOut(
			outDir,
			config.homeOut,
			renderPage({
				lang,
				title: config.strings.homeTitle,
				description: config.strings.homeDescription,
				outPath: config.homeOut,
				content: await renderMarkdown(homeMarkdown, homeContext),
				activeFile: null,
			}),
		);
		pages.push(config.homeOut);
		for (const file of DOC_FILES) {
			const source = `${config.docsSrcDir}/${file}`;
			const markdown = await readFile(resolve(root, source), "utf8");
			const outPath = `${config.docsOutDir}/${file.replace(/\.md$/, ".html")}`;
			const context = {
				sourceDir: posix.dirname(source),
				outDir: posix.dirname(outPath),
				lang,
				sourcePath: source,
			};
			await writeOut(
				outDir,
				outPath,
				renderPage({
					lang,
					title: `${config.labels[file]} — Ink`,
					description: summarize(markdown) || config.strings.homeDescription,
					outPath,
					content: await renderMarkdown(markdown, context),
					activeFile: file,
				}),
			);
			pages.push(outPath);
		}
	}
	const canonicalPaths = pages.map((outPath) => canonicalOf(outPath));
	await writeOut(outDir, "robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
	await writeOut(
		outDir,
		"sitemap.xml",
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${canonicalPaths
			.map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`)
			.join("\n")}\n</urlset>\n`,
	);
	console.log(`docs site: ${pages.length} pages + robots.txt + sitemap.xml → ${outDir}`);
	return { pages };
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await buildSite();
}
