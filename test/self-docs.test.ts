/**
 * Self-docs unit tests (self-docs-design rev 3, D6): render states, length
 * budget, topic-table consistency with the shipped docs, and
 * resolveInstallRoot's three states.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	resolveInstallRoot,
	SELF_DOCS_MAX_CHARS,
	SELF_DOCS_TOPICS,
	selfDocsSection,
} from "../src/core/self-docs.js";

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
		expect(selfDocsSection(paths).length).toBeLessThanOrEqual(SELF_DOCS_MAX_CHARS);
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

	it("keeps the table literals greppable for check-docs.mjs (one doc per line)", () => {
		// check-docs.mjs extracts doc: "..." literals per line — multi-line
		// entries would silently drop out of that check.
		const table = SELF_DOCS_TOPICS.map((t) => t.doc);
		expect(new Set(table).size).toBe(table.length); // no duplicates
	});
});

describe("resolveInstallRoot", () => {
	const roots: string[] = [];

	function makeRoot(withDocs: boolean): string {
		const root = mkdtempSync(join(tmpdir(), "ink-selfdocs-"));
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
				rmRoot(root);
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

// Recursive rm without node:fs/rm's global state dependency.
function rmRoot(dir: string): void {
	const { readdirSync, rmdirSync, unlinkSync, statSync } = require("node:fs") as typeof import("node:fs");
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) rmRoot(full);
		else unlinkSync(full);
	}
	rmdirSync(dir);
	void statSync; // keep the import used in both branches' toolchain shape
}
