import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { withFileLock } from "./file-lock.js";
import type { Tool } from "./types.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full content to write to the file" }),
});

export interface WriteToolOptions {
	cwd?: string;
}

export function createWriteTool(options: WriteToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "write",
		description:
			"Write full content to a file. Creates the file (and parent directories) if missing, overwrites if present. " +
			"For new files this is the right tool; to change part of an existing file prefer edit — never rewrite a whole file just to change a few lines.",
		parameters: writeSchema,
		async execute(args, signal) {
			const requested = String(args.path ?? "");
			const content = String(args.content ?? "");
			const absolute = path.resolve(cwd, requested);

			return withFileLock(absolute, async () => {
				if (signal.aborted) return { output: "Error: aborted before write", isError: true };

				let existed = false;
				try {
					existed = (await stat(absolute)).isFile();
				} catch {
					existed = false;
				}

				try {
					await mkdir(path.dirname(absolute), { recursive: true });
					if (signal.aborted) return { output: "Error: aborted before write", isError: true };
					await writeFile(absolute, content, "utf8");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { output: `Error writing ${requested}: ${message}`, isError: true };
				}

				const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
				return {
					output: `${existed ? "Overwrote" : "Created"} ${requested} (${lines} lines, ${Buffer.byteLength(content)} bytes)`,
				};
			});
		},
	};
}
