import { EventEmitter } from "node:events";
import { readFile, unlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), detect: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/core/tools/bin-detect.js", () => ({ detectBinary: mocks.detect }));
// #bash-abort: the abort/timeout paths call killProcessTree(pid) — the
// real one would process.kill(±424242) on a live machine (review P1-1;
// Linux PID_MAX reaches it). The fake pid exists for track/untrack shape.
vi.mock("../src/core/process-tree.js", () => ({
	trackDetachedChildPid: () => {},
	untrackDetachedChildPid: () => {},
	killTrackedDetachedChildren: () => {},
	killProcessTree: () => {},
}));

import { createBashTool } from "../src/core/tools/bash.js";
import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool, runSearch } from "../src/core/tools/grep.js";

class FakeStream extends EventEmitter {
	destroy = vi.fn(() => {
		this.emit("close");
	});
}
class Child extends EventEmitter {
	stdout = new FakeStream();
	stderr = new FakeStream();
	kill = vi.fn();
	// #bash-abort: the real tool now spawns detached and tracks the pid —
	// a stable fake pid keeps the tracked-set bookkeeping symmetrical
	// (track + untrack), never reaching a real kill (kill is mocked).
	pid = 424242;
}
let child: Child;
const artifacts: string[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	child = new Child();
	mocks.spawn.mockReset().mockReturnValue(child);
	mocks.detect.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
	expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
	for (const file of artifacts.splice(0)) await unlink(file);
});
const signal = () => new AbortController().signal;
function search(bin = "rg", limit = 100) {
	return runSearch(bin, [], "/tmp", {
		limit,
		context: 0,
		timeoutMs: 30000,
		label: "fixture",
		signal: signal(),
	});
}
function feed(stream: EventEmitter, bytes: Buffer, size: number) {
	for (let i = 0; i < bytes.length; i += size) stream.emit("data", bytes.subarray(i, i + size));
}
function artifact(output: string) {
	const file = output.match(/(?:Full|Partial) output saved to (\S+)/)![1]!;
	artifacts.push(file);
	return file;
}

describe("search controlled streams", () => {
	it.each([1, 2, 7, 10000])("decodes across %i byte chunks without manufacturing lines", async (size) => {
		const pending = search();
		feed(child.stdout, Buffer.from("α😀\n\n--\nlast"), size);
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		expect((await pending).output).toBe("α😀\n\n--\nlast");
	});
	it("counts byte-limited complete records", async () => {
		const pending = search();
		child.stdout.emit("data", Buffer.from(`a\n${"é".repeat(25600)}\n`));
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		expect((await pending).output).toContain("showing first 1 of 2 lines, 50KB limit");
	});
	it.each([false, true])("does not stop at exactly the collection cap; extra=%s", async (extra) => {
		const pending = search();
		child.stdout.emit("data", Buffer.alloc(1048576, 120));
		expect(child.kill).not.toHaveBeenCalled();
		if (extra) child.stdout.emit("data", Buffer.from("x"));
		child.emit("exit", extra ? null : 0, extra ? "SIGTERM" : null);
		child.emit("close", extra ? null : 0, extra ? "SIGTERM" : null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(result.output).not.toContain("No matches");
		expect(result.output).toContain(
			extra ? "at least 0 complete lines observed; total unknown" : "showing first 0 of 1 lines, 50KB limit",
		);
		expect(child.kill).toHaveBeenCalledTimes(Number(extra));
	});
	it("retains the crossing prefix and only counts its terminated records", async () => {
		const pending = search();
		child.stdout.emit("data", Buffer.from(`a\n${"x".repeat(1048573)}é\nignored\n`));
		child.stdout.emit("data", Buffer.from("later\n"));
		vi.advanceTimersByTime(2000);
		child.emit("exit", null, "SIGKILL");
		child.emit("close", null, "SIGKILL");
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(result.output).toContain(
			"showing first 1 lines; at least 1 complete lines observed; total unknown",
		);
		expect(result.output).not.toContain("�");
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	});
	it.each([1, 10000])("bounds all stderr chunks (%i bytes)", async (size) => {
		const pending = search();
		feed(child.stderr, Buffer.from("é".repeat(5000)), size);
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(result.output).toContain(
			`stderr:\n${"é".repeat(1000)}\n[stderr truncated: showing first 2000 bytes or fewer.]`,
		);
		expect(child.kill).not.toHaveBeenCalled();
	});
	it.each([
		["rg", 1, null, false],
		["fd", 1, null, true],
		["rg", 2, null, true],
		["rg", null, "SIGINT", true],
		["fd", null, null, true],
	] as const)("handles %s code %s signal %s", async (bin, code, closeSignal, failed) => {
		const pending = search(bin);
		child.emit("exit", code, closeSignal);
		child.emit("close", code, closeSignal);
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(Boolean(result.isError)).toBe(failed);
		if (failed) expect(result.output).not.toContain("No matches");
	});
	it.each([createGrepTool, createFindTool])(
		"prevents launch when abort occurs during detection",
		async (create) => {
			let done!: (value: boolean) => void;
			mocks.detect.mockReturnValue(
				new Promise<boolean>((resolve) => {
					done = resolve;
				}),
			);
			const controller = new AbortController();
			const listen = vi.spyOn(controller.signal, "addEventListener");
			const pending = create().execute({ pattern: "fixture" }, controller.signal);
			controller.abort();
			done(true);
			expect((await pending).output).toBe("Error: search aborted by user.");
			expect(mocks.spawn).not.toHaveBeenCalled();
			expect(listen).not.toHaveBeenCalled();
		},
	);
	it.each([createGrepTool, createFindTool])("prevents already-aborted launches", async (create) => {
		const controller = new AbortController();
		controller.abort();
		expect((await create().execute({ pattern: "fixture" }, controller.signal)).isError).toBe(true);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it("cleans timers on timeout and on spawn error followed by close", async () => {
		const pending = search();
		vi.advanceTimersByTime(30000);
		child.emit("exit", null, "SIGTERM");
		child.emit("close", null, "SIGTERM");
		child.stdout.emit("end");
		child.stderr.emit("end");
		expect((await pending).output).toContain("timed out");
		const next = search();
		child.emit("error", new Error("fixture"));
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		expect((await next).output).toContain("failed to run");
	});
});

describe("bash controlled streams", () => {
	it.each([1, 2, 3, 100])("preserves unicode, spaces and LF across %i byte chunks", async (size) => {
		const pending = createBashTool().execute({ command: "fixture" }, signal());
		feed(child.stdout, Buffer.from("é€😀 \n \n"), size);
		child.stderr.emit("data", Buffer.from(" \t\n"));
		child.emit("exit", 3, null);
		child.emit("close", 3, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(result.output).toBe("stdout:\né€😀 \n \n\n\nstderr:\n \t\n\n\nExit code: 3");
		expect(result.isError).toBe(false);
		expect(result.exitCode).toBe(3);
	});
	it.each([500, 501])("counts %i terminal-LF records", async (count) => {
		const pending = createBashTool().execute({ command: "fixture" }, signal());
		child.stdout.emit("data", Buffer.from("x\n".repeat(count)));
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		if (count === 501) {
			expect(await readFile(artifact(result.output), "utf8")).toContain("x\n".repeat(count));
		} else expect(result.output).toBe(`stdout:\n${"x\n".repeat(count)}`);
	});
	it.each([51200, 51201, 262144, 262145, 10485760, 10485761])(
		"bounds each stream for %i source bytes",
		async (size) => {
			const pending = createBashTool().execute({ command: "fixture" }, signal());
			const bytes = Buffer.alloc(size, 120);
			for (const stream of [child.stdout, child.stderr]) stream.emit("data", bytes);
			child.emit("exit", 0, null);
			child.emit("close", 0, null);
			child.stdout.emit("end");
			child.stderr.emit("end");
			const result = await pending;
			expect(result.output).toContain(`stdout:\n${"x".repeat(Math.min(size, 51200))}`);
			expect(result.output).toContain(`stderr:\n${"x".repeat(Math.min(size, 51200))}`);
			if (size > 51200) {
				const saved = await readFile(artifact(result.output));
				const start = Buffer.byteLength("$ fixture\n[stdout]\n");
				expect(
					saved.subarray(start, start + Math.min(size, 10485760)).equals(bytes.subarray(0, 10485760)),
				).toBe(true);
				expect(result.output).toContain("[stdout preview starts within a line.]");
				expect(result.output).toContain(size > 10485760 ? "Partial output saved" : "Full output saved");
				if (size > 10485760)
					expect(saved.toString()).toContain("retained first 10485760 of 10485761 observed bytes");
			}
		},
	);
	it("marks exact-full prefix followed by a byte incomplete", async () => {
		const pending = createBashTool().execute({ command: "fixture" }, signal());
		child.stdout.emit("data", Buffer.alloc(10485760, 120));
		child.stdout.emit("data", Buffer.from("!"));
		child.emit("exit", null, "SIGINT");
		child.emit("close", null, "SIGINT");
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("command interrupted; artifact prefix capped");
		expect(await readFile(artifact(result.output), "utf8")).toContain(
			"retained first 10485760 of 10485761 observed bytes",
		);
	});
	it("removes a rolling fragment when line limiting discards it", async () => {
		const pending = createBashTool().execute({ command: "fixture" }, signal());
		child.stdout.emit("data", Buffer.from(`${"x".repeat(262144)}\n${"ok\n".repeat(501)}`));
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(result.output).not.toContain("preview starts within");
		artifact(result.output);
	});
	it.each(["signal", "missing", "timeout", "abort"])("reports interrupted artifacts: %s", async (mode) => {
		const controller = new AbortController();
		const pending = createBashTool().execute({ command: "fixture", timeout: 0.5 }, controller.signal);
		child.stdout.emit("data", Buffer.alloc(51201, 120));
		if (mode === "timeout") vi.advanceTimersByTime(500);
		if (mode === "abort") controller.abort();
		child.emit("exit", null, mode === "missing" ? null : "SIGTERM");
		child.emit("close", null, mode === "missing" ? null : "SIGTERM");
		child.stdout.emit("end");
		child.stderr.emit("end");
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(result.output).toContain("command interrupted; all observed bytes retained");
		expect(await readFile(artifact(result.output), "utf8")).toContain("[command interrupted:");
	});
	it("pre-abort never spawns and late close after error never creates an artifact", async () => {
		const controller = new AbortController();
		controller.abort();
		await createBashTool().execute({ command: "fixture" }, controller.signal);
		expect(mocks.spawn).not.toHaveBeenCalled();
		const pending = createBashTool().execute({ command: "fixture" }, signal());
		child.stdout.emit("data", Buffer.alloc(51201, 120));
		child.emit("error", new Error("fixture"));
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
		child.stdout.emit("end");
		child.stderr.emit("end");
		expect((await pending).output).toBe("Error: failed to spawn command: fixture");
	});
});
