import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The docs site builder is JavaScript without declarations.
import { buildSite } from "../scripts/build-docs-site.mjs";

const SITE_URL = "https://fishinsalt.github.io/ink";

let outDir: string;

beforeAll(async () => {
	outDir = await mkdtemp(join(tmpdir(), "ink-docs-site-"));
	await buildSite({ outDir });
});

afterAll(async () => {
	await rm(outDir, { recursive: true, force: true });
});

function page(relPath: string): Promise<string> {
	return readFile(join(outDir, relPath), "utf8");
}

describe("docs site build", () => {
	it("en home: the language switch points at the zh home", async () => {
		expect(await page("index.html")).toContain(
			'<div class="lang"><strong>English</strong> | <a href="zh/index.html">简体中文</a></div>',
		);
	});

	it("zh home: the English switch points back at the en home", async () => {
		expect(await page("zh/index.html")).toContain(
			'<div class="lang"><a href="../index.html">English</a> | <strong>简体中文</strong></div>',
		);
	});

	it("doc pages carry switcher hrefs both ways", async () => {
		expect(await page("docs/cli.html")).toContain('<a href="../zh/docs/cli.html">简体中文</a>');
		expect(await page("zh/docs/cli.html")).toContain('<a href="../../docs/cli.html">English</a>');
	});

	it("zh cross-file anchors are re-slugged to the zh heading ids", async () => {
		const zhSettings = await page("zh/docs/settings.html");
		const match = /href="index\.html#([^"]+)"/.exec(zhSettings);
		expect(match).toBeTruthy();
		const zhIndex = await page("zh/docs/index.html");
		expect(zhIndex).toContain(`id="${match?.[1]}"`);
	});

	it("keeps the en cross-file anchor unchanged", async () => {
		expect(await page("docs/settings.html")).toContain('href="index.html#project-trust"');
	});

	it("sets the language attribute per page", async () => {
		expect(await page("index.html")).toContain('<html lang="en">');
		expect(await page("zh/index.html")).toContain('<html lang="zh-CN">');
		expect(await page("zh/docs/cli.html")).toContain('<html lang="zh-CN">');
	});

	it("emits hreflang alternates both ways with x-default on en", async () => {
		const enHome = await page("index.html");
		expect(enHome).toContain(`<link rel="alternate" hreflang="zh-CN" href="${SITE_URL}/zh/">`);
		expect(enHome).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE_URL}/">`);
		const zhHome = await page("zh/index.html");
		expect(zhHome).toContain(`<link rel="alternate" hreflang="en" href="${SITE_URL}/">`);
		expect(zhHome).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE_URL}/">`);
	});

	it("sitemap lists all eleven zh URLs", async () => {
		const sitemap = await page("sitemap.xml");
		const zhUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
			.map((match) => match[1])
			.filter((url) => url.startsWith(`${SITE_URL}/zh`));
		expect(zhUrls).toHaveLength(11);
		expect(zhUrls).toContain(`${SITE_URL}/zh/`);
		expect(zhUrls).toContain(`${SITE_URL}/zh/docs/cli.html`);
	});

	it("resolves every emitted href and src on sample pages against the built tree", async () => {
		const samples = ["index.html", "zh/index.html", "docs/cli.html", "zh/docs/settings.html"];
		for (const sample of samples) {
			const html = await page(sample);
			for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
				const target = match[1];
				if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#")) {
					continue;
				}
				const path = target.split(/[#?]/)[0];
				if (path === "") continue;
				const resolved = posix.normalize(posix.join(posix.dirname(sample), path));
				expect(resolved.includes("zh/zh"), `${sample}: doubled zh segment in ${target}`).toBe(false);
				expect(existsSync(join(outDir, resolved)), `${sample}: unresolved ${target}`).toBe(true);
			}
		}
	});
});
