import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Execute the actual CLI parser and shared runner-options adapter without the
// main() startup side effects (catalog requests, credentials, or trust writes).
// Extract declarations via TypeScript's AST rather than copying parser logic.
const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["defaultModel", "envThinking", "parseArgs", "runnerOptions"]);
const declarations = file.statements.filter((statement) => {
	if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text ?? "");
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.some(
			(declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text),
		);
	}
	return false;
});
const { outputText } = ts.transpileModule(declarations.map((node) => node.getText(file)).join("\n"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});

function parse(
	argv: string[],
	defaults: { env?: string; global?: string; project?: string } = {},
): { model: string; modelExplicit: boolean; forwarded: { model: string; modelExplicit: boolean } } {
	return vm.runInNewContext(
		`${outputText}\nconst parsed = parseArgs(argv);\n({
			model: parsed.model,
			modelExplicit: parsed.modelExplicit,
			forwarded: runnerOptions(parsed, argv, {}),
		});`,
		{
			argv,
			process: {
				env: { IMP_MODEL: defaults.env },
				cwd: () => "/isolated-cli-test",
				stderr: { write: () => undefined },
				exit: (code: number) => {
					throw new Error(`CLI exit ${code}`);
				},
			},
			loadSettings: () => ({ defaultModel: defaults.global }),
			projectDefaultModelIfTrusted: () => defaults.project,
			HELP: "help",
		},
	);
}

function expectSelection(
	argv: string[],
	defaults: Parameters<typeof parse>[1],
	model: string,
	explicit: boolean,
) {
	const result = parse(argv, defaults);
	expect(result.model).toBe(model);
	expect(result.modelExplicit).toBe(explicit);
	expect(result.forwarded.model).toBe(model);
	expect(result.forwarded.modelExplicit).toBe(explicit);
}

describe("CLI model provenance", () => {
	it("builtin default is not explicit", () => {
		expectSelection([], {}, "claude-sonnet-4-5", false);
	});

	it("environment selection is not explicit, including startup resume", () => {
		for (const argv of [[], ["--continue"], ["--resume", "session-id"]]) {
			expectSelection(argv, { env: "openai/env-model" }, "openai/env-model", false);
		}
	});

	it("global and trusted project defaults are not explicit", () => {
		expectSelection([], { global: "global-model" }, "global-model", false);
		expectSelection([], { global: "global-model", project: "project-model" }, "project-model", false);
		expectSelection(
			["--no-trust"],
			{ global: "global-model", project: "project-model" },
			"global-model",
			false,
		);
	});

	it.each(["-m", "--model"])(
		"%s marks selection explicit even when equal to the environment default",
		(flag) => {
			expectSelection([flag, "openai/chosen", "--continue"], { env: "openai/chosen" }, "openai/chosen", true);
			expectSelection(
				["--resume", "session-id", flag, "openai/chosen"],
				{ env: "other" },
				"openai/chosen",
				true,
			);
		},
	);

	it("repeated flags preserve explicit provenance and use the last model", () => {
		expectSelection(["-m", "first", "--model", "last"], {}, "last", true);
	});

	it("model-looking prompt values do not count as explicit selection", () => {
		expectSelection(["-p", "--model"], { env: "env-model" }, "env-model", false);
	});

	it.each(["-m", "--model"])("%s still rejects a missing value", (flag) => {
		expect(() => parse([flag])).toThrow("CLI exit 1");
	});
});
