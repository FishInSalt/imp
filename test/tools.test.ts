import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.js";
import { createReadTool } from "../src/core/tools/read.js";

const noSignal = new AbortController().signal;

describe("bash tool", () => {
	it("returns stdout", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "echo hello-from-imp" }, noSignal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("hello-from-imp");
	});

	it("captures stderr and non-zero exit code", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "echo oops >&2; exit 3" }, noSignal);
		expect(result.output).toContain("oops");
		expect(result.output).toContain("Exit code: 3");
	});

	it("kills the command on timeout", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "sleep 30", timeout: 0.5 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("timed out");
	}, 10_000);

	it("aborts via AbortSignal", async () => {
		const tool = createBashTool();
		const controller = new AbortController();
		const promise = tool.execute({ command: "sleep 30" }, controller.signal);
		setTimeout(() => controller.abort(), 100);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(result.output).toContain("aborted");
	}, 10_000);

	it("truncates large output and says so", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "seq 1 5000" }, noSignal);
		expect(result.output).toContain("truncated");
		expect(result.output).toContain("5000");
		// tail kept: early lines must be gone
		expect(result.output).not.toMatch(/^\s*1\n/);
		const lineCount = result.output.split("\n").length;
		expect(lineCount).toBeLessThan(560);
	});

	it("saves truncated full output to a temp file and names it", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "seq 1 5000" }, noSignal);
		expect(result.output).toMatch(/Full output saved to \/.*imp-output-.*\.log/);
		// the temp file actually contains the beginning that was cut from the tail
		const match = result.output.match(/Full output saved to (\S+)/);
		const full = await readFile(match![1]!, "utf8");
		expect(full).toContain("1\n2\n");
	});

	it("rejects an empty command", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "   " }, noSignal);
		expect(result.isError).toBe(true);
	});

	it("rejects an invalid timeout", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "true", timeout: -1 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("invalid timeout");
	});
});

describe("read tool", () => {
	let dir: string;

	async function setupFile(name: string, lines: number): Promise<string> {
		dir ??= await mkdtemp(path.join(tmpdir(), "imp-test-"));
		const file = path.join(dir, name);
		const content = Array.from({ length: lines }, (_, i) => `line-${i + 1}`).join("\n");
		await writeFile(file, content, "utf8");
		return file;
	}

	it("reads a whole small file", async () => {
		const file = await setupFile("small.txt", 3);
		const tool = createReadTool();
		const result = await tool.execute({ path: file }, noSignal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line-1");
		expect(result.output).toContain("line-3");
	});

	it("supports offset/limit and reports the remainder", async () => {
		const file = await setupFile("offset.txt", 100);
		const tool = createReadTool();
		const result = await tool.execute({ path: file, offset: 10, limit: 5 }, noSignal);
		expect(result.output).toContain("line-10");
		expect(result.output).toContain("line-14");
		expect(result.output).not.toContain("line-15\n");
		expect(result.output).toContain("[86 more lines in file. Use offset=15 to continue.]");
	});

	it("truncates at 2000 lines and suggests the next offset", async () => {
		const file = await setupFile("big.txt", 3000);
		const tool = createReadTool();
		const result = await tool.execute({ path: file }, noSignal);
		expect(result.output).toContain("line-1");
		expect(result.output).not.toContain("line-2001");
		expect(result.output).toContain("Use offset=2001 to continue.");
	});

	it("errors on missing files", async () => {
		const tool = createReadTool();
		const result = await tool.execute({ path: "definitely-not-here.txt" }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Error reading");
	});

	it("refuses binary files", async () => {
		dir ??= await mkdtemp(path.join(tmpdir(), "imp-test-"));
		const file = path.join(dir, "binary.bin");
		await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x00]));
		const tool = createReadTool();
		const result = await tool.execute({ path: file }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("binary");
	});

	it("errors when offset is beyond EOF", async () => {
		const file = await setupFile("eof.txt", 5);
		const tool = createReadTool();
		const result = await tool.execute({ path: file, offset: 99 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("beyond the end");
	});
});
