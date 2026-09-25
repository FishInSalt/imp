import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createTaskTool, taskResult } from "../src/core/tools/task.js";
import type { Tool, ToolExecuteResult } from "../src/core/tools/types.js";
import { createWriteTool } from "../src/core/tools/write.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import { createToolSink, sanitizeDisplay, type ToolBlock } from "../src/repl/tool-presentation.js";
import { assistant, scriptedProvider } from "./helpers/fakes.js";

const roots: string[] = [];
const signal = new AbortController().signal;
async function scratch() {
	const root = await mkdtemp(path.join(tmpdir(), "imp-builtin-presentation-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
function task(cwd: string) {
	return createTaskTool({
		cwd,
		getProvider: () => scriptedProvider([assistant([{ type: "text", text: "answer" }])]),
		getModel: () => "fake",
		getSystem: () => "",
		getTools: () => [],
		getSession: () => null,
		agents: [],
		childSessions: false,
	});
}
function blocksFor(
	tool: Tool,
	args: Record<string, unknown>,
	result: ToolExecuteResult,
	replay = false,
	enabled = true,
) {
	const blocks: ToolBlock[] = [];
	const sink = createToolSink((b) => blocks.push(b));
	sink.setResolver((name) => (name === tool.name && enabled ? tool.presentation : undefined));
	sink.start("id", tool.name, args);
	sink.end(
		{
			toolCallId: "id",
			toolName: tool.name,
			content: result.content ?? result.output,
			isError: result.isError ?? false,
			...(result.display === undefined ? {} : { display: result.display }),
		},
		replay,
	);
	return blocks;
}
function unchanged(tool: Tool, args: Record<string, unknown>, result: ToolExecuteResult) {
	const saved = structuredClone(result);
	for (const replay of [false, true]) {
		const enabled = blocksFor(tool, args, result, replay);
		const disabled = blocksFor(tool, args, result, replay, false);
		expect(enabled[1]).toEqual(disabled[1]);
		expect(enabled[1]?.semantic).toBeUndefined();
	}
	expect(result).toEqual(saved);
}
describe("actual builtin presentation integration", () => {
	it("uses actual factories, activity preparation once, reverse completions, replay and raw toggles", async () => {
		const cwd = await scratch();
		const tools = [
			createWriteTool({ cwd }),
			createReadTool({ cwd }),
			createGrepTool({ cwd }),
			createFindTool({ cwd }),
			createLsTool({ cwd }),
			task(cwd),
		];
		const args = [
			{ path: "f", content: 'const x = "\\n";\nnext' },
			{ path: "f" },
			{ pattern: "x" },
			{ pattern: "*" },
			{},
			{ prompt: "inspect\nthen report" },
		];
		const hooks = tools.map((tool) => {
			expect(tool.presentation?.call).toBeTypeOf("function");
			expect(tool.presentation?.result).toBeUndefined();
			const hook = vi.fn(tool.presentation!.call!);
			tool.presentation = { call: hook };
			return hook;
		});
		const blocks: ToolBlock[] = [];
		const sink = createToolSink((b) => blocks.push(b));
		sink.setResolver((name) => tools.find((t) => t.name === name)?.presentation);
		tools.forEach((tool, i) => {
			sink.prepare(String(i), tool.name, { ...args[i], extra: "visible" });
			sink.start(String(i), tool.name, args[i]!);
		});
		for (let i = tools.length - 1; i >= 0; i--)
			sink.end(
				{ toolCallId: String(i), toolName: tools[i]!.name, content: "raw result", isError: false },
				true,
			);
		expect(blocks.filter((_, i) => i % 2 === 0).map((b) => b.id)).toEqual(["5", "4", "3", "2", "1", "0"]);
		for (const block of blocks) {
			const fold = new ToolBlockFold(block);
			for (const width of [1, 20, 80, 120]) {
				fold.render(width);
				fold.setExpanded(true);
				fold.render(width);
				fold.setRawArguments(true);
				fold.render(width);
				fold.setRawArguments(false);
				fold.toggle();
			}
		}
		for (const hook of hooks) expect(hook).toHaveBeenCalledTimes(1);
		const fold = new ToolBlockFold(blocks[10]!);
		fold.setExpanded(true);
		let rendered = sanitizeDisplay(fold.render(120).join("\n"));
		expect(rendered).toContain('const x = "\\n";');
		expect(rendered).toContain("Other arguments");
		expect(rendered).toContain("visible");
		fold.setRawArguments(true);
		rendered = sanitizeDisplay(fold.render(120).join("\n"));
		expect(rendered).toContain('"content":');
		sink.end({ toolCallId: "orphan", toolName: "read", content: "error", isError: true }, true);
		expect(blocks.at(-1)?.error).toBe(true);
	});
	it.each([
		"",
		"\n",
		"a\r\n",
		"你好😀\n",
		'const s = "\\n";\n',
		"x".repeat(16384),
		"x".repeat(16385),
		"a\n".repeat(1001),
	])("keeps actual write bytes and read results unchanged: %#", async (content) => {
		const cwd = await scratch();
		const write = createWriteTool({ cwd });
		const args = { path: "file", content };
		const result = await write.execute(args, signal);
		expect(await readFile(path.join(cwd, "file"))).toEqual(Buffer.from(content));
		const lines = content === "" ? 0 : content.split("\n").length - Number(content.endsWith("\n"));
		expect(result.output).toBe(`Created file (${lines} lines, ${Buffer.byteLength(content)} bytes)`);
		unchanged(write, args, result);
		const read = createReadTool({ cwd });
		const output = await read.execute({ path: "file" }, signal);
		expect(output.output).toBe(content.endsWith("\n") ? content.slice(0, -1) : content);
		unchanged(read, { path: "file" }, output);
	});
	it("preserves read caps, notice-shaped text and image descriptors", async () => {
		const cwd = await scratch();
		const tool = createReadTool({ cwd });
		for (const content of [
			"a\n".repeat(2001),
			`a\n${"é".repeat(25600)}`,
			"x".repeat(51201),
			"[Showing lines 1-2 of 2]\n",
		]) {
			await writeFile(path.join(cwd, "f"), content);
			unchanged(tool, { path: "f" }, await tool.execute({ path: "f" }, signal));
		}
		const fixture = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
		try {
			await writeFile(path.join(cwd, "image.png"), fixture.get_bytes());
		} finally {
			fixture.free();
		}
		const image = await tool.execute({ path: "image.png" }, signal);
		expect(image.content?.some((b) => b.type === "image")).toBe(true);
		unchanged(tool, { path: "image.png" }, image);
	});
	it("retains actual ls dotfiles, symlinks, newline names and caps", async () => {
		const cwd = await scratch();
		const tool = createLsTool({ cwd });
		expect((await tool.execute({}, signal)).output).toContain("(empty directory)");
		await mkdir(path.join(cwd, "dir"));
		await symlink(path.join(cwd, "absent"), path.join(cwd, "dangling"));
		await symlink(path.join(cwd, "dir"), path.join(cwd, "linked"));
		for (const name of [".hidden", "a\nb", "[entries omitted]"]) await writeFile(path.join(cwd, name), "");
		for (const args of [{}, { limit: 1 }]) {
			const result = await tool.execute(args, signal);
			unchanged(tool, args, result);
		}
		const result = await tool.execute({}, signal);
		expect(result.output).toContain("linked/");
		expect(result.output).toContain(".hidden");
		expect(result.output).toContain("Directory type unavailable");
	});
	it("retains fake executable search output byte-for-byte without parsing counts", async () => {
		const cwd = await scratch();
		for (const name of ["rg", "fd"])
			await writeFile(
				path.join(cwd, name),
				`#!${process.execPath}\nif(process.argv.includes('--version'))process.exit(0);process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(cwd, "stdout"))}));process.stderr.write('diagnostic');`,
				{ mode: 0o755 },
			);
		vi.stubEnv("PATH", cwd);
		for (const text of [
			"a:1:x\n--\nb:3:y\n",
			"",
			"a\n".repeat(101),
			"é\n".repeat(20000),
			"x\n".repeat(600000),
		]) {
			await writeFile(path.join(cwd, "stdout"), text);
			for (const tool of [createGrepTool({ cwd }), createFindTool({ cwd })]) {
				const result = await tool.execute({ pattern: "*" }, signal);
				expect(result.output).toContain("diagnostic");
				unchanged(tool, { pattern: "*" }, result);
				if (text.length > 1048576) expect(result.output).toContain("total unknown");
			}
		}
	});
	it("uses a fake provider and preserves actual task outcome metadata and tails", async () => {
		const tool = task(await scratch());
		const result = await tool.execute({ prompt: "answer", worktree: false }, signal);
		expect(result.output).toContain("answer");
		unchanged(tool, { prompt: "answer", worktree: false }, result);
		for (const status of ["completed", "timeout", "aborted", "crash", "max_iterations"] as const)
			for (const text of [undefined, "partial", `${"x".repeat(60000)}TAIL`]) {
				const result = taskResult(
					{ status, text, turns: 2, usage: { inputTokens: 10, outputTokens: 5 }, reason: "test" },
					null,
				);
				unchanged(tool, { prompt: "original" }, result);
				if (text?.endsWith("TAIL") && status !== "timeout" && status !== "aborted")
					expect(result.output).toContain("TAIL");
			}
	});
});
