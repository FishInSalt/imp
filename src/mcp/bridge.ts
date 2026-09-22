/**
 * MCP tool → imp Tool bridge (M18, docs/m18-mcp-design.md §4).
 *
 * Flat direct registration (D2): every MCP tool becomes one imp tool named
 * `<server>_<tool>` (the shape the pi adapter's directTools mode produces —
 * e.g. zai-vision_analyze_image). MCP inputSchema is JSON Schema and imp's
 * Tool.parameters is a TypeBox TSchema — the same thing at runtime — so the
 * schema passes through with minimal normalization.
 *
 * execute() deliberately never throws: timeouts, dead connections and
 * server-side errors all come back as isError results (the bash contract —
 * the model reads the failure and adapts). Calls route through the manager
 * (not a captured client) so a mid-session reconnect is transparent.
 */
import type { TSchema } from "typebox";
import { BUILTIN_TOOL_NAMES, MAX_BYTES, NAME_PATTERN } from "../core/constants.js";
import type { Tool, ToolExecuteResult } from "../core/tools/types.js";
import type { McpCallResult, McpToolInfo } from "./client.js";

/** Normalize a server inputSchema into a JSON Schema `parameters` object.
 *  MCP arguments are always an object per spec. A schema whose type is
 *  explicitly NOT object is replaced with a fresh `{type:"object"}` — its
 *  siblings were written for the wrong type (design §4: 包一层). A schema
 *  with no type keeps its siblings and gains `type:"object"`. */
export function normalizeInputSchema(inputSchema: unknown): TSchema {
	if (inputSchema !== null && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
		const schema = inputSchema as Record<string, unknown>;
		if (schema.type === "object") return inputSchema as TSchema;
		if (typeof schema.type === "string") return { type: "object" } as TSchema;
		if (Object.keys(schema).length > 0) return { ...schema, type: "object" } as TSchema;
	}
	return { type: "object" } as TSchema;
}

/** Build the flat direct tool name `<server>_<tool>`; null + reason when the
 *  name cannot live in imp's tool table (pattern/length — design §4). */
export function directToolName(server: string, toolName: string): { name: string } | { error: string } {
	const name = `${server}_${toolName}`;
	if (!NAME_PATTERN.test(name)) {
		return { error: `tool name "${name}" does not match ^[a-z][a-z0-9_-]{0,63}$` };
	}
	if (BUILTIN_TOOL_NAMES.includes(name)) {
		return { error: `"${name}" collides with a built-in tool` };
	}
	return { name };
}

/** Map an MCP call result into imp's ToolExecuteResult (design §4). Output
 *  is tail-capped at MAX_BYTES like every builtin (a chatty server must not
 *  flood the next provider request). */
export function mapCallResult(result: McpCallResult): ToolExecuteResult {
	const texts: string[] = [];
	let nonText = 0;
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		else nonText++;
	}
	let output = texts.join("\n");
	if (nonText > 0) {
		const note = `(${nonText} non-text block${nonText === 1 ? "" : "s"} omitted)`;
		output = output === "" ? note : `${output}\n${note}`;
	}
	if (Buffer.byteLength(output) > MAX_BYTES) {
		const buf = Buffer.from(output);
		output = `[truncated — kept the last 50KB]\n${buf.subarray(buf.length - MAX_BYTES).toString("utf-8")}`;
	}
	return { output, isError: result.isError === true ? true : undefined };
}

/** prompt-audit P7 (pi adapter parity): a catalog one-liner for an MCP tool,
 *  cut at a word boundary to ≤ max chars. The full description still rides
 *  the tools array; this line exists for the system-prompt routing catalog. */
export function truncateAtWord(text: string, max: number): string {
	if (text.length <= max) return text;
	const slice = text.slice(0, max + 1);
	const lastSpace = slice.lastIndexOf(" ");
	const cut = lastSpace > 0 ? lastSpace : max;
	return `${text.slice(0, cut).trimEnd()}…`;
}

/** Bridge one server tool. `call` is the manager route (reconnect-aware). */
export function bridgeTool(
	server: string,
	info: McpToolInfo,
	call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolExecuteResult>,
): { tool?: Tool; error?: string } {
	const named = directToolName(server, info.name);
	if ("error" in named) return { error: `mcp ${server}: skipping "${info.name}" — ${named.error}` };
	const description =
		typeof info.description === "string" && info.description !== ""
			? info.description
			: `MCP tool ${info.name} from server "${server}"`;
	return {
		tool: {
			name: named.name,
			description,
			// prompt-audit P7: routing catalog line (supersedes M18-D6 — the
			// catalog is now the routing table; see the design's D10) plus the
			// owning server's name for the catalog's total-budget degradation.
			promptSnippet: truncateAtWord(description, 100),
			mcpServer: server,
			parameters: normalizeInputSchema(info.inputSchema),
			async execute(args, signal): Promise<ToolExecuteResult> {
				try {
					return await call(args, signal);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { output: `MCP call failed: ${message}`, isError: true };
				}
			},
		},
	};
}
