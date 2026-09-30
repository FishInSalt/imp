import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, "../bin/imp.js");

/** Hermetic world: fresh HOME per case — no settings, no .env, no creds. */
let world: string | undefined;
function freshWorld(): string {
	world = mkdtempSync(path.join(tmpdir(), "imp-tokens-e2e-"));
	return world;
}
afterEach(() => {
	world = undefined;
});

describe("#output-truncation D3 CLI wiring (bin/imp.js e2e)", () => {
	it("--help advertises the catalog default with the DEFAULT_MAX_TOKENS fallback", async () => {
		const dir = freshWorld();
		const { stdout } = await run(process.execPath, [BIN, "--help"], {
			cwd: dir,
			env: { ...process.env, HOME: dir },
		});
		expect(stdout).toContain("Max output tokens per turn (default: model catalog limit; 16384 when unknown)");
	});

	it("--max-tokens rejects non-numeric and non-positive values", async () => {
		const dir = freshWorld();
		await expect(
			run(process.execPath, [BIN, "--max-tokens", "foo", "-p", "hi"], {
				cwd: dir,
				env: { ...process.env, HOME: dir },
			}),
		).rejects.toThrow(/Invalid --max-tokens value "foo"/);
		await expect(
			run(process.execPath, [BIN, "--max-tokens", "0", "-p", "hi"], {
				cwd: dir,
				env: { ...process.env, HOME: dir },
			}),
		).rejects.toThrow(/must be a positive integer/);
	});

	// The e2e above passes with a copied literal too; this pins the single
	// source (#output-truncation D3 / review round-3 C3): the HELP template
	// must INTERPOLATE DEFAULT_MAX_TOKENS. AST only — importing cli.ts would
	// run its bottom `await main()`.
	it("the HELP template interpolates DEFAULT_MAX_TOKENS", () => {
		const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
		const file = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
		const help = file.statements.find(
			(statement): statement is ts.VariableStatement =>
				ts.isVariableStatement(statement) &&
				statement.declarationList.declarations.some(
					(declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "HELP",
				),
		);
		expect(help).toBeDefined();
		const text = help?.getText(file) ?? "";
		expect(text).toContain("--max-tokens");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the assertion IS the literal source text — the placeholder must appear verbatim in the HELP template
		expect(text).toContain("${DEFAULT_MAX_TOKENS}");
	});
});
