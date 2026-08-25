import { Type } from "typebox";
import { detectBinary } from "./bin-detect.js";
import { clampInt, runSearch } from "./grep.js";
import type { Tool } from "./types.js";

const DEFAULT_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 30;

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern for file/dir names, e.g. '*.ts' or 'test*'. Use '*' to list everything.",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	type: Type.Optional(Type.String({ description: "Restrict to 'file' or 'directory' (default: both)" })),
	limit: Type.Optional(Type.Number({ description: `Max results (default: ${DEFAULT_LIMIT})` })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
});

export interface FindToolOptions {
	cwd?: string;
}

export function createFindTool(options: FindToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "find",
		description:
			"Find files and directories by name (backed by fd; respects .gitignore, includes hidden files). " +
			"Pattern is a glob. Results are absolute-ish paths, truncated to the first results — " +
			"narrow with path/pattern instead of raising the limit. This is the right tool for 'where is the X file'.",
		parameters: findSchema,
		async execute(args, signal) {
			if (!(await detectBinary("fd"))) {
				return {
					output: "Error: fd is not installed. Install it first: brew install fd (or apt install fd-find).",
					isError: true,
				};
			}

			const pattern = String(args.pattern ?? "");
			if (pattern === "") return { output: "Error: empty pattern", isError: true };
			const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, 1000);
			const timeoutMs = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1, 600) * 1000;

			const argv = ["--color", "never", "--hidden", "--glob"];
			const type = String(args.type ?? "");
			if (type === "file") argv.push("--type", "file");
			else if (type === "directory") argv.push("--type", "directory");
			argv.push("--", pattern, typeof args.path === "string" && args.path !== "" ? args.path : ".");

			return runSearch("fd", argv, cwd, { limit, context: 0, timeoutMs, label: pattern, signal });
		},
	};
}
