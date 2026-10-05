import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { type CliFixture, createCliFixture } from "./helpers/cli-fixture.js";

const run = promisify(execFile);
let world: CliFixture | undefined;
function freshWorld(): CliFixture {
	world = createCliFixture();
	return world;
}
afterEach(() => world?.cleanup());

describe("#output-truncation D3 CLI wiring (fixture bin/ink.js e2e)", () => {
	it("--help advertises the catalog default with the DEFAULT_MAX_TOKENS fallback", async () => {
		const fixture = freshWorld();
		const { stdout } = await run(process.execPath, [fixture.bin, "--help"], {
			cwd: fixture.cwd,
			env: fixture.env(),
		});
		expect(stdout).toContain("Max output tokens per turn (default: model catalog limit; 16384 when unknown)");
	});

	it("--max-tokens rejects non-numeric and non-positive values", async () => {
		const fixture = freshWorld();
		await expect(
			run(process.execPath, [fixture.bin, "--max-tokens", "foo", "-p", "hi"], {
				cwd: fixture.cwd,
				env: fixture.env(),
			}),
		).rejects.toThrow(/Invalid --max-tokens value "foo"/);
		await expect(
			run(process.execPath, [fixture.bin, "--max-tokens", "0", "-p", "hi"], {
				cwd: fixture.cwd,
				env: fixture.env(),
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
