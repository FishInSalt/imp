/**
 * Self-docs unit tests (self-docs-design rev 3, D6): render states, length
 * budget, topic-table consistency with the shipped docs, and
 * resolveInstallRoot's three states.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveInstallRoot, SELF_DOCS_TOPICS, selfDocsSection } from "../src/core/self-docs.js";
import { mkTempDir } from "./helpers/mktemp.js";

const paths = {
	readme: "/usr/local/lib/node_modules/ink-agent/README.md",
	docs: "/usr/local/lib/node_modules/ink-agent/docs",
	examples: "/usr/local/lib/node_modules/ink-agent/examples",
};

describe("selfDocsSection", () => {
	it("renders the routing block with absolute paths", () => {
		const text = selfDocsSection(paths);
		expect(text).toContain(`- Main documentation: ${paths.readme}`);
		expect(text).toContain(`- Full docs index: ${paths.docs}/index.md`);
		expect(text).toContain(`- Examples: ${paths.examples}`);
		expect(text).toContain("read only when the user asks about ink itself");
		expect(text).toContain("resolve docs/... and examples/... under the paths above");
	});

	it("renders the empty string without paths (old-install degradation)", () => {
		expect(selfDocsSection(undefined)).toBe("");
	});

	it("stays within the length budget with realistic install paths", () => {
		// Literal 1100, not SELF_DOCS_MAX_CHARS — the pin must fail if someone
		// raises the constant alongside the copy (implementation review N9).
		expect(selfDocsSection(paths).length).toBeLessThanOrEqual(1100);
		// Long-path headroom: a deep Windows-style install must also fit.
		const deep = {
			readme: "C:/Users/EXAMPLEUSER/AppData/Roaming/npm/node_modules/ink-agent/README.md",
			docs: "C:/Users/EXAMPLEUSER/AppData/Roaming/npm/node_modules/ink-agent/docs",
			examples: "C:/Users/EXAMPLEUSER/AppData/Roaming/npm/node_modules/ink-agent/examples",
		};
		expect(selfDocsSection(deep).length).toBeLessThanOrEqual(1100);
	});

	it("names every topic doc in the routing line", () => {
		const text = selfDocsSection(paths);
		for (const { doc } of SELF_DOCS_TOPICS) {
			expect(text).toContain(doc);
		}
	});
});

describe("SELF_DOCS_TOPICS consistency with shipped docs", () => {
	// The routing table is dead text if it names files the tarball does not
	// carry (a rename here must update the table there).
	it("every topic doc exists at the repository docs top level", () => {
		for (const { doc } of SELF_DOCS_TOPICS) {
			const relative = doc.replace(/^docs\//, "");
			const file = new URL(`../docs/${relative}`, import.meta.url);
			expect(existsSync(file), doc).toBe(true);
		}
	});

	it("keeps the table literals greppable for check-docs.mjs (one doc per line)", async () => {
		// check-docs.mjs extracts doc: "..." literals from the SOURCE with a
		// single-line regex — multi-line or template-literal entries would
		// silently drop out of that check. The real pin: extraction count
		// must equal the runtime table length.
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("../src/core/self-docs.ts", import.meta.url), "utf8");
		const extracted = [...source.matchAll(/doc:\s*"(docs\/[a-z0-9-]+\.md)"/g)].map((m) => m[1]);
		expect(extracted).toHaveLength(SELF_DOCS_TOPICS.length);
		const table = SELF_DOCS_TOPICS.map((t) => t.doc);
		expect(new Set(table).size).toBe(table.length); // no duplicates
	});
});

describe("resolveInstallRoot", () => {
	const roots: string[] = [];

	function makeRoot(withDocs: boolean): string {
		const root = mkTempDir("ink-selfdocs-");
		roots.push(root);
		if (withDocs) {
			mkdirSync(join(root, "docs"));
			writeFileSync(join(root, "docs", "index.md"), "# index\n");
		}
		writeFileSync(join(root, "package.json"), "{}\n");
		return root;
	}

	afterAll(() => {
		for (const root of roots) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// best effort cleanup
			}
		}
	});

	it("finds a root that carries package.json + docs/index.md (source state)", () => {
		const root = makeRoot(true);
		expect(resolveInstallRoot(join(root, "src", "core"))).toBe(root);
	});

	it("walks up past a package.json without a docs tree to the real root", () => {
		// dist/core-like: inner dir has package.json but no docs; outer is the root
		const root = makeRoot(true);
		const nested = join(root, "nested");
		mkdirSync(nested);
		writeFileSync(join(nested, "package.json"), "{}\n");
		// The nearest package.json WITH docs wins over the nearer bare one.
		expect(resolveInstallRoot(join(nested, "lib"))).toBe(root);
	});

	it("returns undefined when no qualifying root exists (old install)", () => {
		const root = makeRoot(false); // package.json but no docs/
		expect(resolveInstallRoot(join(root, "dist", "core"))).toBeUndefined();
	});
});
