import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	open: vi.fn(),
	unlink: vi.fn(),
	readdir: vi.fn(),
	stat: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({
	open: mocks.open,
	unlink: mocks.unlink,
	readdir: mocks.readdir,
	stat: mocks.stat,
}));

import { createBashTool } from "../src/core/tools/bash.js";
import { createLsTool } from "../src/core/tools/ls.js";

class Child extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn();
}
let child: Child;
const signal = new AbortController().signal;
beforeEach(() => {
	vi.resetAllMocks();
	child = new Child();
	mocks.spawn.mockReturnValue(child);
	mocks.unlink.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it.each(["create", "write", "close"])("does not promise an artifact when %s fails", async (failure) => {
	const writeFile = vi.fn().mockResolvedValue(undefined);
	const close = vi.fn().mockResolvedValue(undefined);
	if (failure === "create") mocks.open.mockRejectedValue(new Error("fixture"));
	else mocks.open.mockResolvedValue({ writeFile, close });
	if (failure === "write") writeFile.mockRejectedValueOnce(new Error("fixture"));
	if (failure === "close") close.mockRejectedValueOnce(new Error("fixture"));
	const pending = createBashTool().execute({ command: "fixture" }, signal);
	child.stdout.emit("data", Buffer.alloc(51201, 120));
	child.emit("close", 0, null);
	child.emit("close", 0, null);
	const result = await pending;
	expect(result.output).toContain("saving the output artifact failed");
	expect(result.output).not.toContain("output saved to");
	expect(mocks.open).toHaveBeenCalledTimes(1);
	expect(mocks.open.mock.calls[0]![1]).toBe("wx");
	expect(mocks.unlink).toHaveBeenCalledTimes(failure === "create" ? 0 : 1);
	if (failure !== "create") expect(mocks.unlink.mock.calls[0]![0]).toBe(mocks.open.mock.calls[0]![0]);
});

it("writes concurrent unique artifacts sequentially with raw prefix segments", async () => {
	const calls: (string | Buffer)[][] = [];
	mocks.open.mockImplementation(async () => {
		const segments: (string | Buffer)[] = [];
		calls.push(segments);
		let writing = false;
		return {
			writeFile: async (data: string | Buffer) => {
				expect(writing).toBe(false);
				writing = true;
				await Promise.resolve();
				segments.push(data);
				writing = false;
			},
			close: async () => {
				expect(writing).toBe(false);
			},
		};
	});
	const bytes = Buffer.alloc(51201, 255);
	const first = createBashTool().execute({ command: "fixture" }, signal);
	child.stdout.emit("data", bytes);
	child.emit("close", 0, null);
	child = new Child();
	mocks.spawn.mockReturnValue(child);
	const second = createBashTool().execute({ command: "fixture" }, signal);
	child.stdout.emit("data", bytes);
	child.emit("close", 0, null);
	const results = await Promise.all([first, second]);
	expect(mocks.open.mock.calls[0]![0]).not.toBe(mocks.open.mock.calls[1]![0]);
	for (let i = 0; i < 2; i++) {
		expect(results[i]!.output).toContain("Full output saved to");
		expect(Buffer.isBuffer(calls[i]![1])).toBe(true);
		expect((calls[i]![1] as Buffer).equals(bytes)).toBe(true);
		const text = results[i]!.output.split("stdout:\n")[1]!.split("\n\n")[0]!;
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(51200);
	}
});

it.each(["EACCES", "ENOENT"])("retains every name when all stats fail with %s", async (code) => {
	mocks.readdir.mockResolvedValue(["b", "a"]);
	mocks.stat.mockRejectedValue(Object.assign(new Error("fixture"), { code }));
	const result = await createLsTool({ cwd: "/tmp" }).execute({}, signal);
	expect(result.output).toBe(
		"a\nb\n\n[Directory type unavailable for 2 displayed entries; names shown without a directory suffix.]",
	);
});

it("does not count unknown names omitted by either listing cap", async () => {
	mocks.readdir.mockResolvedValue(["a", "b"]);
	mocks.stat.mockResolvedValueOnce({ isDirectory: () => false }).mockRejectedValue(new Error("fixture"));
	const entry = await createLsTool({ cwd: "/tmp" }).execute({ limit: 1 }, signal);
	expect(entry.output).not.toContain("type unavailable");
	expect(mocks.stat).toHaveBeenCalledTimes(1);
	mocks.readdir.mockResolvedValue(["a".repeat(51200), "b"]);
	mocks.stat.mockRejectedValue(new Error("fixture"));
	const byte = await createLsTool({ cwd: "/tmp" }).execute({}, signal);
	expect(byte.output).toContain("50KB limit reached");
	expect(byte.output).not.toContain("type unavailable");
	expect(byte.output).not.toContain("empty directory");
});
