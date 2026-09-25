import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createReadTool } from "../src/core/tools/read.js";
import { outputBlock } from "../src/repl/tool-presentation.js";

const signal = new AbortController().signal;
const roots: string[] = [];
async function fixture(text: string, name = "file") {
	const root = await mkdtemp(path.join(tmpdir(), "imp-integrity-"));
	roots.push(root);
	await writeFile(path.join(root, name), text);
	return { root, tool: createReadTool({ cwd: root }) };
}
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
// Fixtures are confined to the test-created runtime directories; no user files are read.
describe("read integrity", () => {
	it.each(["", "a", "a\n", "\n", "a\n\n", "a\r\n"])("counts logical records in %j", async (text) => {
		const { tool } = await fixture(text);
		const result = await tool.execute({ path: "file" }, signal);
		expect(result.output).toBe(text.endsWith("\n") ? text.slice(0, -1) : text);
		const count = text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
		expect((await tool.execute({ path: "file", offset: Math.max(2, count + 1) }, signal)).output).toContain(
			`(${count} lines total)`,
		);
	});
	it.each([0, -1, 1.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid integers before IO: %s",
		async (value) => {
			for (const key of ["offset", "limit"]) {
				const result = await createReadTool().execute({ path: "does-not-exist", [key]: value }, signal);
				expect(result.output).toContain(`${key} must be a positive safe integer`);
			}
		},
	);
	it("keeps complete records at byte boundaries and never skips the oversized record", async () => {
		const { root, tool } = await fixture(`a\n${"é".repeat(25600)}`);
		const first = await tool.execute({ path: "file", limit: 2 }, signal);
		expect(first.output).toBe("a\n\n[Showing lines 1-1 of 2 (50KB limit). Use offset=2 to continue.]");
		expect((await tool.execute({ path: "file", offset: 2 }, signal)).output).toBe("é".repeat(25600));
		await writeFile(path.join(root, "file"), `\n${"x".repeat(51200)}`);
		expect((await tool.execute({ path: "file" }, signal)).output).toContain("Showing lines 1-1");
		await writeFile(path.join(root, "file"), `a\n${"x".repeat(51201)}`);
		expect((await tool.execute({ path: "file", offset: 2 }, signal)).output).toContain("[Line 2 is 51KB");
	});
	it("uses 2000 actual records, not a terminal empty record", async () => {
		const { root, tool } = await fixture("a\n".repeat(2000));
		expect((await tool.execute({ path: "file" }, signal)).output).not.toContain("limit)");
		await writeFile(path.join(root, "file"), "a\n".repeat(2001));
		expect((await tool.execute({ path: "file" }, signal)).output).toContain("offset=2001");
	});
	it.each([
		["space name", "space name"],
		["it's here", "it's here"],
		["-option", "-option"],
		["file", "~/file"],
		["file", "@file"],
		["shot 1\u202fPM.png", "@shot 1 PM.png"],
		["Capture d’écran", "Capture d'écran"],
		["cafe\u0301", "café"],
	])("executes the hint against the resolved file %s", async (actual, requested) => {
		const source = "é".repeat(30000);
		const { root, tool } = await fixture(source, actual);
		vi.stubEnv("HOME", root);
		const result = await tool.execute({ path: requested }, signal);
		const command = result.output.match(/Use bash: (.*)\]$/)![1]!;
		expect(execFileSync("/bin/bash", ["-c", command], { cwd: root })).toEqual(
			Buffer.from(source).subarray(0, 51200),
		);
		expect(await readFile(path.join(root, actual), "utf8")).toBe(source);
	});
});

it("preserves dangling names and directory symlink suffixes", async () => {
	const { root } = await fixture("x");
	await symlink(path.join(root, "absent"), path.join(root, "dangling"));
	await symlink(root, path.join(root, "directory"));
	const tool = createLsTool({ cwd: root });
	const result = await tool.execute({}, signal);
	expect(result.output).toContain("dangling\ndirectory/\nfile\n");
	expect(result.output).toContain("Directory type unavailable for 1 displayed entries");
});

it("matches multiline LF against CRLF+BOM and preserves the original encoding", async () => {
	const { root } = await fixture("\ufeffa\r\nb\r\nc\r\n");
	const tool = createEditTool({ cwd: root });
	const result = await tool.execute({ path: "file", edits: [{ oldText: "a\nb", newText: "A\nB" }] }, signal);
	expect(result.isError).toBeFalsy();
	expect(await readFile(path.join(root, "file"), "utf8")).toBe("\ufeffA\r\nB\r\nc\r\n");
	const failed = await tool.execute({ path: "file", edits: [{ oldText: "missing", newText: "x" }] }, signal);
	expect(failed.output).not.toContain("CRLF");
	expect(await readFile(path.join(root, "file"), "utf8")).toBe("\ufeffA\r\nB\r\nc\r\n");
});

it.each([
	["read", "[Line 1 is 51KB, exceeds the 50KB limit. Use bash: sed -n '1p' '/tmp/file' | head -c 51200]"],
	[
		"grep",
		"[Truncated: showing first 0 lines; at least 0 complete lines observed; total unknown; 1048576-byte collection limit. Narrow the search (subdirectory path, glob, or more specific pattern) instead of raising the limit.]",
	],
	["find", "[stderr truncated: showing first 2000 bytes or fewer.]"],
	["ls", "[Directory type unavailable for 2 displayed entries; names shown without a directory suffix.]"],
	["bash", "[stdout preview starts within a line.]"],
	[
		"bash",
		"[stderr artifact incomplete: retained first 10485760 of 10485761 observed bytes (10485760-byte per-stream limit).]",
	],
	[
		"bash",
		"[output truncated: only the tail is shown above. Partial output saved to /tmp/file (command interrupted; artifact prefix capped; per-stream limit 10485760 bytes) — read it with the read tool if you need more (tip: pipe through head/tail or narrow the grep to keep output small)]",
	],
])("promotes exact %s notices beyond retention in live and replay", (toolName, notice) => {
	for (const replay of [false, true]) {
		const block = outputBlock(
			{ toolCallId: "x", toolName, content: `${"body\n".repeat(1001)}${notice}`, isError: false },
			replay,
		);
		expect(block.metadata).toContain(notice);
	}
});

it.each([
	["bash", "Error: command terminated by signal SIGINT. Partial output:"],
	["bash", "Error: command ended without an exit status. Partial output:"],
	["bash", "Error: command timed out after 0.5s and was killed. Partial output:"],
	["grep", "Error: rg terminated by signal SIGINT."],
	["find", "Error: fd ended without an exit status."],
])("retains exact failure headers for %s", (toolName, header) => {
	for (const replay of [false, true]) {
		const block = outputBlock(
			{ toolCallId: "x", toolName, content: `${header}\n${"body\n".repeat(1001)}`, isError: false },
			replay,
		);
		expect(block.title).toBe("failed");
		expect(block.metadata).toContain(header);
		const near = outputBlock(
			{ toolCallId: "x", toolName, content: `prefix ${header}`, isError: false },
			replay,
		);
		expect(near.metadata).not.toContain(`prefix ${header}`);
	}
});
