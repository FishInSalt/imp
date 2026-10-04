// Explicit static checks for the CommonJS preload (excluded by repository Biome includes).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const preload = path.join(repoRoot, "test/helpers/network-blocker.cjs");
execFileSync(process.execPath, ["--check", preload], { stdio: "inherit" });
const program = ts.createProgram([preload], {
	allowJs: true,
	checkJs: true,
	noEmit: true,
	skipLibCheck: true,
	target: ts.ScriptTarget.ES2023,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	types: ["node"],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
	throw new Error(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCurrentDirectory: () => repoRoot,
			getCanonicalFileName: (file) => file,
			getNewLine: () => "\n",
		}),
	);
}
console.log("CommonJS preload: syntax passed; 0 TypeScript checkJs diagnostics");

const scratch = mkdtempSync(path.join(tmpdir(), "ink-isolation-static-"));
try {
	// Preserve the project's lint rules, but actually include the CJS guard
	// and this checker without changing the shared repository configuration.
	const config = JSON.parse(readFileSync(path.join(repoRoot, "biome.json"), "utf8"));
	config.files.includes = ["**/*.cjs", "**/*.mjs"];
	writeFileSync(path.join(scratch, "biome.json"), JSON.stringify(config));
	execFileSync(
		process.execPath,
		[
			path.join(repoRoot, "node_modules/@biomejs/biome/bin/biome"),
			"check",
			"--config-path",
			scratch,
			preload,
			fileURLToPath(import.meta.url),
		],
		{ cwd: repoRoot, stdio: "inherit" },
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
