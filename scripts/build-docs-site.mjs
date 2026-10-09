#!/usr/bin/env node
/**
 * build-docs-site.mjs — builds the GitHub Pages documentation site into
 * _site/ from README.md and the top-level docs pages.
 *
 * The published set mirrors the docs that ship in the npm package (the
 * design archive is excluded): README.md becomes the home page and every
 * top-level docs/<name>.md becomes docs/<name>.html. Relative links are
 * rewritten for the static site — links between published pages follow
 * their .html versions, links that leave the published set (examples/,
 * LICENSE, RELEASING.md, docs/design/, the Chinese README) point at the
 * corresponding GitHub page.
 *
 * The DOCS list must stay in sync with REQUIRED_DOCS in
 * scripts/check-docs.mjs.
 *
 * Usage:  node scripts/build-docs-site.mjs   (also `npm run docs:site`)
 * Output: _site/ (gitignored; deployed by .github/workflows/pages.yml)
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "_site");

const REPO_URL = "https://github.com/FishInSalt/ink";
const SITE_URL = "https://fishinsalt.github.io/ink";
const SITE_DESCRIPTION =
	"Ink — an open-source AI assistant and agent harness for the terminal. Sessions, extensions, skills, subagents, and MCP; works with Anthropic, OpenAI, GLM, DeepSeek, and Kimi.";
const OG_IMAGE =
	"https://raw.githubusercontent.com/FishInSalt/ink/main/assets/social-preview.png";

// Published pages, in sidebar order: [docs file, sidebar label].
const DOCS = [
	["index.md", "Overview"],
	["cli.md", "CLI reference"],
	["providers.md", "Providers & models"],
	["sessions.md", "Sessions"],
	["settings.md", "Settings"],
	["extensions.md", "Extensions"],
	["skills.md", "Skills"],
	["mcp.md", "MCP"],
	["subagents.md", "Subagents"],
	["images.md", "Images"],
];

// Repo-relative path → published site path.
const PUBLISHED = new Map([
	["README.md", "index.html"],
	...DOCS.map(([file]) => [`docs/${file}`, `docs/${file.replace(/\.md$/, ".html")}`]),
]);

const FAVICON =
	"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%230d1016'/%3E%3Ctext%20x='16'%20y='23'%20font-family='Menlo,monospace'%20font-size='19'%20fill='%235eead4'%20text-anchor='middle'%3Ei%3C/text%3E%3C/svg%3E";

function slugify(text) {
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

function rewriteTarget(target, pageDir) {
	if (
		!target ||
		/^[a-z][a-z0-9+.-]*:/i.test(target) ||
		target.startsWith("//") ||
		target.startsWith("#")
	) {
		return target;
	}
	const cut = target.search(/[#?]/);
	const path = cut === -1 ? target : target.slice(0, cut);
	const rest = cut === -1 ? "" : target.slice(cut);
	if (path === "" || path === "." || path === "./") return target;
	const repoPath = posix.normalize(posix.join(pageDir, path));
	if (repoPath.startsWith("..")) return target; // leaves the repository
	if (repoPath.endsWith("/")) {
		return `${REPO_URL}/tree/main/${repoPath.replace(/\/+$/, "")}`;
	}
	const published = PUBLISHED.get(repoPath);
	if (published !== undefined) {
		const relDir = posix.relative(pageDir, posix.dirname(published));
		return `${relDir === "" ? "" : `${relDir}/`}${posix.basename(published)}${rest}`;
	}
	return `${REPO_URL}/blob/main/${repoPath}${rest}`;
}

function rewriteArticleLinks(html, pageDir) {
	return html.replace(/(href|src)="([^"]*)"/g, (_, attribute, target) => {
		return `${attribute}="${rewriteTarget(target, pageDir)}"`;
	});
}

async function renderMarkdown(markdown, pageDir) {
	const html = await marked.parse(markdown);
	return rewriteArticleLinks(addHeadingIds(html), pageDir);
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
.brand .cursor{color:var(--brand)}
.tagline{font-size:12.5px;color:var(--dim);margin:6px 0 24px}
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

function renderPage({ title, description, canonicalPath, content, activeFile }) {
	const isDocsPage = activeFile !== null;
	const pageDir = isDocsPage ? "docs" : "";
	const homeHref = isDocsPage ? "../index.html" : "index.html";
	const docHref = (file) =>
		isDocsPage ? file.replace(/\.md$/, ".html") : `docs/${file.replace(/\.md$/, ".html")}`;
	const editTarget = isDocsPage ? `docs/${activeFile}` : "README.md";
	const navItems = [
		{ href: homeHref, label: "Home", active: !isDocsPage },
		...DOCS.map(([file, label]) => ({
			href: docHref(file),
			label,
			active: isDocsPage && file === activeFile,
		})),
	];
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
<meta name="description" content="${escapeAttr(description)}">
<link rel="canonical" href="${SITE_URL}${canonicalPath}">
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
<a class="brand" href="${homeHref}">ink<span class="cursor">▌</span></a>
<div class="tagline">an AI agent harness for the terminal</div>
<nav class="group">
${navItems.map((item) => `<a href="${item.href}"${item.active ? ' class="active"' : ""}>${item.label}</a>`).join("\n")}
</nav>
<nav class="group">
<a href="${REPO_URL}">GitHub</a>
<a href="https://www.npmjs.com/package/ink-agent">npm</a>
<a href="${REPO_URL}/blob/main/CHANGELOG.md">Changelog</a>
</nav>
</aside>
<main>
<article>
${content}
</article>
<footer class="footer">
<a href="${REPO_URL}/blob/main/${editTarget}">Edit this page on GitHub</a>
<span>·</span>
<span>Ink ships under the MIT license</span>
<span>·</span>
<span><code>npm install -g ink-agent</code></span>
</footer>
</main>
</div>
</body>
</html>
`;
}

async function writeOut(relativePath, content) {
	const target = resolve(outDir, relativePath);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
}

async function main() {
	await rm(outDir, { recursive: true, force: true });

	const readme = await readFile(resolve(root, "README.md"), "utf8");
	await writeOut(
		"index.html",
		renderPage({
			title: "Ink — an open-source AI assistant and agent harness for the terminal",
			description: SITE_DESCRIPTION,
			canonicalPath: "/",
			content: await renderMarkdown(readme, ""),
			activeFile: null,
		}),
	);

	for (const [file, label] of DOCS) {
		const markdown = await readFile(resolve(root, "docs", file), "utf8");
		const page = file.replace(/\.md$/, ".html");
		await writeOut(
			`docs/${page}`,
			renderPage({
				title: `${label} — Ink`,
				description: summarize(markdown) || SITE_DESCRIPTION,
				canonicalPath: `/docs/${page}`,
				content: await renderMarkdown(markdown, "docs"),
				activeFile: file,
			}),
		);
	}

	const pagePaths = ["/", ...DOCS.map(([file]) => `/docs/${file.replace(/\.md$/, ".html")}`)];
	await writeOut(
		"robots.txt",
		`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`,
	);
	await writeOut(
		"sitemap.xml",
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pagePaths
			.map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`)
			.join("\n")}\n</urlset>\n`,
	);

	console.log(`docs site: ${pagePaths.length} pages + robots.txt + sitemap.xml → _site/`);
}

await main();
