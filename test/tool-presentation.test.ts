import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, ToolResult } from "../src/core/messages.js";
import type { SessionStore } from "../src/core/session/store.js";
import type { SubagentOutcome } from "../src/core/subagent.js";
import { taskResult } from "../src/core/tools/task.js";
import { buildWorktreeTrailer } from "../src/core/worktree.js";
import { Renderer } from "../src/render.js";
import { ToolActivity, ToolBlockFold } from "../src/repl/components/tool-block.js";
import { replaySession } from "../src/repl/replay.js";
import * as presentation from "../src/repl/tool-presentation.js";
import {
	createToolSink,
	inputBlock,
	outputBlock,
	sanitizeDisplay,
	type ToolBlock,
} from "../src/repl/tool-presentation.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { visibleWidth } from "../src/tui.js";

const result = (content: string, toolName = "bash", extra: Partial<ToolResult> = {}): ToolResult => ({
	toolCallId: "a",
	toolName,
	content,
	isError: false,
	...extra,
});
const plain = (fold: ToolBlockFold, width = 80): string => sanitizeDisplay(fold.render(width).join("\n"));

describe("semantic tool presentation", () => {
	it("caches payload sanitization and layout across elapsed updates, invalidating on resize, label and reset", () => {
		const scan = vi.spyOn(presentation, "sanitizeDisplay");
		try {
			const label = "\x1b[2Jpayload".repeat(10000);
			const activity = new ToolActivity("running 1s", label);
			const first = activity.render(40);
			activity.update("running 2s");
			expect(activity.render(40).slice(1)).toEqual(first.slice(1));
			expect(scan.mock.calls.filter(([text]) => text === label)).toHaveLength(1);
			expect(activity.render(10).slice(1)).not.toEqual(first.slice(1));
			expect(scan.mock.calls.filter(([text]) => text === label)).toHaveLength(1);
			activity.update("running 3s", "changed");
			expect(activity.render(40).join("")).toContain("changed");
			activity.invalidate();
			activity.render(40);
			expect(scan.mock.calls.filter(([text]) => text === "changed")).toHaveLength(2);
		} finally {
			scan.mockRestore();
		}
	});
	it.each([
		["[task] child failed after 4 turns: provider disconnected; partial result above.", "partial"],
		["[task] hit the 4-turn cap; this is the child's wrap-up answer, not a confirmed completion.", "limited"],
	])("preserves task qualifier beyond 1000 lines live and replay: %s", (qualifier, status) => {
		const content = `${"answer\n".repeat(1001)}\n${qualifier}\n\n[task] 4 turns`;
		const messages: AgentMessage[] = [{ role: "toolResult", results: [result(content, "task")] }];
		const live = new TranscriptSink();
		live.toolSink.end(result(content, "task"));
		const replay = new TranscriptSink();
		replaySession({ write: replay.feed, ansi: true, markdown: true, toolSink: replay.toolSink }, {
			buildContext: () => ({ messages }),
		} as unknown as SessionStore);
		for (const transcript of [live, replay]) {
			const fold = transcript.toolFolds[1];
			expect(fold?.block.title).toBe(status);
			expect(fold?.block.error).toBe(true);
			expect(fold?.block.metadata).toContain(qualifier);
			expect(fold?.block.lines).toHaveLength(1000);
			for (const expanded of [false, true]) {
				fold?.setExpanded(expanded);
				expect(sanitizeDisplay(transcript.render(200).join("\n"))).toContain(qualifier);
			}
		}
		expect(outputBlock(result(content, "other")).metadata).toEqual([]);
	});
	it.each(["persisted", "unpersisted", "absent"] as const)(
		"recognizes producer task contracts live and replay with %s session",
		(persistence) => {
			const session =
				persistence === "absent"
					? null
					: ({
							isPersisted: persistence === "persisted",
							filePath: "/tmp/child.jsonl",
						} as SessionStore);
			const cases: [SubagentOutcome["status"], string | undefined, string][] = [
				["max_iterations", undefined, "limited"],
				["max_iterations", "best effort", "limited"],
				["timeout", undefined, "failed"],
				["aborted", undefined, "failed"],
				["crash", undefined, "failed"],
				["crash", "partial answer", "partial"],
				["completed", undefined, "completed"],
			];
			for (const [status, text, expected] of cases) {
				const produced = taskResult(
					{ status, text, turns: 4, usage: { inputTokens: 1, outputTokens: 1 }, reason: "disconnected" },
					session,
					5000,
					"test task",
				);
				expect(typeof produced.output).toBe("string");
				const content = produced.output as string;
				const toolResult = result(content, "task", { isError: produced.isError });
				const live = new TranscriptSink();
				live.toolSink.end(toolResult);
				const replay = new TranscriptSink();
				const messages: AgentMessage[] = [{ role: "toolResult", results: [toolResult] }];
				replaySession({ write: replay.feed, ansi: true, markdown: true, toolSink: replay.toolSink }, {
					buildContext: () => ({ messages }),
				} as unknown as SessionStore);
				for (const transcript of [live, replay]) {
					const block = transcript.toolFolds[1]?.block;
					expect(block?.title).toBe(expected === "completed" ? "" : expected);
					expect(block?.error).toBe(expected !== "completed");
					if (text === undefined && expected !== "completed") {
						const qualifier = content.split("\n")[0] ?? "";
						expect(block?.metadata).toContain(qualifier);
						expect(block?.metadata.includes("Transcript: /tmp/child.jsonl")).toBe(
							persistence === "persisted",
						);
						if (status === "max_iterations") {
							for (const altered of [
								`prefix ${qualifier}`,
								`${qualifier} extra`,
								qualifier.replace("4 turns", "four turns"),
							]) {
								expect(outputBlock(result(altered, "task")).title).toBe("");
							}
							expect(outputBlock(result(qualifier, "other")).metadata).toEqual([]);
						}
					}
				}
			}
		},
	);
	it("preserves exact worktree recovery trailer beyond retention", () => {
		const trailer = buildWorktreeTrailer(
			{ path: "/tmp/child", branch: "task/child" } as Parameters<typeof buildWorktreeTrailer>[0],
			"2 files changed",
		).trim();
		expect(outputBlock(result("x\n".repeat(1001) + trailer, "task")).metadata).toContain(trailer);
	});
	it("sanitizes complete controls before escaping malformed controls", () => {
		expect(
			sanitizeDisplay(
				"a\x1b[2J\x1b[4A\x1b[31mB\x1b[0m\x1b]52;c;secret\x07\x1b]8;;url\x1b\\C\x1b]8;;\x1b\\\r\n\r\t\0\x7f\x85\x1b[",
			),
		).toBe("aBC\n\\r    \\x00\\x7f\\x85\\x1b[");
		expect(sanitizeDisplay("\x1b]incomplete\x1b")).toBe("\\x1b]incomplete\\x1b");
		expect(sanitizeDisplay("\x9b2J\x9dtitle\x9cok")).toBe("ok");
	});
	it("serializes full arguments and snapshots before mutation", () => {
		const args = { command: "echo one\necho two", timeout: 5 };
		const blocks: ToolBlock[] = [];
		const sink = createToolSink((b) => blocks.push(b));
		sink.start("a", "bash", args);
		args.command = "changed";
		sink.end(result("ok"));
		expect(blocks[0]?.lines.join("\n")).toBe('echo one\necho two\n{\n  "timeout": 5\n}');
		for (const value of [
			null,
			4,
			"string",
			[1, 2],
			{ path: "a", content: "full content", edits: [{ oldText: "a", newText: "b" }] },
		]) {
			expect(JSON.parse(inputBlock("a", "write", value).lines.join("\n"))).toEqual(value);
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(inputBlock("a", "x", cyclic).lines[0]).toContain("could not be safely serialized");
	});
	it.each([999, 1000, 1001])("retains exactly 1000 source lines: %i", (n) => {
		const block = outputBlock(result(`${Array(n).fill("x").join("\n")}\n`));
		expect(block.lines).toHaveLength(Math.min(n, 1000));
		expect(block.discarded).toBe(Math.max(0, n - 1000));
		const fold = new ToolBlockFold(block);
		expect(plain(fold, 300)).toContain("… more · Ctrl+O");
		fold.setExpanded(true);
		expect(plain(fold, 300).includes("source lines omitted")).toBe(n > 1000);
	});
	it.each([999, 1000, 1001])("caps expanded wrapped rows independently: %i", (n) => {
		const fold = new ToolBlockFold(outputBlock(result("x".repeat(n * 10))));
		fold.setExpanded(true);
		const rows = fold.render(14);
		expect(rows.filter((r) => r.includes("xxxxxxxxxx"))).toHaveLength(Math.min(n, 1000));
		expect(
			rows
				.map((r) => sanitizeDisplay(r).trimStart())
				.join("")
				.includes("wrapped rows omitted"),
		).toBe(n > 1000);
	});
	it("promotes narrow diagnostics beyond retention and from hidden persisted content", () => {
		const path = `/tmp/${"long/".repeat(30)}`;
		const note = `[output truncated: only the tail is shown above. Full output saved to ${path} — read it with the read tool if you need more (tip: pipe through head/tail or narrow the grep to keep output small)]`;
		const b = outputBlock(
			result(`${"ordinary error /path\n".repeat(1001)}Exit code: -9\n${note}`, "bash", {
				display: "preview",
			}),
		);
		expect(b.title).toContain("exit -9");
		expect(b.metadata).toEqual(["Exit code: -9", note]);
		expect(plain(new ToolBlockFold(b), 2).replaceAll("\n", "")).toContain(path);
	});
	it.each([
		["read", "[Showing lines 1-2 of 99 (50KB limit). Use offset=3 to continue.]"],
		["read", "[90 more lines in file. Use offset=11 to continue.]"],
		[
			"find",
			"[Truncated: showing first 10 of 90 lines. Narrow the search (subdirectory path, glob, or more specific pattern) instead of raising the limit.]",
		],
		[
			"grep",
			"[Truncated: 50KB limit. Narrow the search (subdirectory path, glob, or more specific pattern) instead of raising the limit.]",
		],
		["ls", "[500 entries limit reached. Use limit=1000 for more. 50KB limit reached]"],
		[
			"task",
			"[task] result truncated to its last 50KB (dropped 500 bytes). For large output, have the subagent write a file and report its path instead.",
		],
		["server_tool", "[truncated — kept the last 50KB]"],
	])("preserves %s truncation contract", (name, note) => {
		expect(outputBlock(result("x\n".repeat(1001) + note, name)).metadata).toEqual([note]);
	});
	it("shows failure, empty output, images, replay diff honesty and actual diff only", () => {
		expect(outputBlock(result("", "read")).lines).toEqual(["(no output)"]);
		expect(outputBlock(result("\nBAD", "read", { isError: true })).metadata).toEqual(["BAD"]);
		const historical = outputBlock(result("edited", "edit"), true);
		expect(historical.metadata).toContain("Diff unavailable in saved history");
		const diff = outputBlock(
			result("edited", "edit", { display: "edited:\n@@ line 3 @@\n+ abcdefghijklmnop\n- old" }),
		);
		expect(diff.kind).toBe("diff");
		const fold = new ToolBlockFold(diff);
		fold.setExpanded(true);
		expect(plain(fold, 10).match(/^ {4}3 /gm)).toHaveLength(1);
		expect(
			new ToolBlockFold(outputBlock(result("+ ordinary\n- ordinary\n@@"))).render(80).join(""),
		).not.toContain("\x1b[32m");
		const image = outputBlock(
			result("", "read", { content: [{ type: "image", mimeType: "image/png", data: "abcd" }] }),
		);
		expect(image.metadata).toEqual(["▪ image [image/png, 3 B]"]);
		expect(JSON.stringify(image)).not.toContain("abcd");
	});
	it.each([1, 2, 5, 40, 120])("sanitizes every visible field and obeys width %i", (width) => {
		const hostile = "\x1b[2J\x1b]52;c;bad\x07中🙂\t\r\n";
		const blocks = [
			inputBlock("a", hostile, { path: hostile, content: hostile }),
			outputBlock(result(hostile.repeat(10), hostile, { isError: true })),
		];
		for (const block of blocks) {
			const fold = new ToolBlockFold(block);
			for (const expanded of [true, false]) {
				fold.setExpanded(expanded);
				for (const row of fold.render(width)) {
					expect(visibleWidth(row)).toBeLessThanOrEqual(width);
					expect(row).not.toContain("\x1b[2J");
					expect(row).not.toContain("\x1b]52");
				}
			}
		}
		const activity = new ToolActivity("running 12s", hostile.repeat(200));
		expect(activity.render(width)).toHaveLength(3);
		for (const row of activity.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(sanitizeDisplay(activity.render(width)[2] ?? "")).toContain("…");
	});
	it("previews use 3/3/8 body rows, resize counts and expanded cap", () => {
		const input = new ToolBlockFold(inputBlock("a", "bash", { command: "x".repeat(20000) }));
		const output = new ToolBlockFold(outputBlock(result("x\n".repeat(10))));
		const diff = new ToolBlockFold(
			outputBlock(result("ok", "edit", { display: `Edited:\n@@ line 1 @@\n${"+ x\n".repeat(20)}` })),
		);
		expect(input.render(40).filter((r) => r.includes("xxx"))).toHaveLength(3);
		expect(output.render(40).filter((r) => / {4}x|⎿ x/.test(sanitizeDisplay(r)))).toHaveLength(3);
		expect(diff.render(80).filter((r) => r.includes("+ x"))).toHaveLength(6); // summary + hunk occupy two body rows
		const wide = plain(input, 80);
		const narrow = plain(input, 40);
		expect(wide).not.toBe(narrow);
		input.setExpanded(true);
		expect(
			plain(input, 12)
				.split("\n")
				.map((line) => line.trimStart())
				.join(""),
		).toContain("1504 wrapped rows omitted from this view");
	});
	it("sanitizes known paths and preserves task recovery artifacts", () => {
		const b = inputBlock("a", "read", { path: "a\x1b[2J\tb\r\nnext" });
		expect(b.metadata).toEqual(["Path: a    b\nnext"]);
		const task = outputBlock(
			result(
				"task timed out after 5s (2 turns ran). work is preserved in the full transcript:\n  /tmp/child.jsonl\nthe child's task was: test",
				"task",
				{ isError: true },
			),
		);
		expect(task.metadata).toContain("Transcript: /tmp/child.jsonl");
	});
	it("pairs by id in received completion order, flushes text, finalizes once and clears", () => {
		const transcript = new TranscriptSink();
		const renderer = new Renderer({
			write: transcript.feed,
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
			markdown: true,
			toolSink: transcript.toolSink,
		});
		renderer.raw("before");
		for (const id of ["a", "b", "c"])
			renderer.event({ type: "tool_start", toolCallId: id, name: "bash", args: { command: id } });
		for (const id of ["b", "a", "orphan"])
			renderer.event({ type: "tool_end", result: result(id, "bash", { toolCallId: id }) });
		renderer.endRun();
		renderer.endRun();
		expect(transcript.toolFolds.map((f) => f.block.id)).toEqual([
			"b",
			"b",
			"a",
			"a",
			"orphan",
			"orphan",
			"c",
		]);
		expect(transcript.toolFolds[4]?.block.lines).toEqual(["Arguments unavailable"]);
		expect(transcript.toolFolds[6]?.block.title).toContain("interrupted");
		const text = sanitizeDisplay(transcript.render(80).join("\n"));
		expect(text.indexOf("before")).toBeLessThan(text.indexOf("● bash"));
		expect(text).toContain("●");
		expect(text).toContain("⎿");
		transcript.clear();
		renderer.endRun();
		expect(transcript.toolFolds).toHaveLength(0);
	});
	it("replays semantic blocks without mutating stored data or duplicate interruption", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				blocks: [
					{ type: "toolCall", id: "a", name: "edit", arguments: { path: "a", edits: [] } },
					{ type: "toolCall", id: "b", name: "bash", arguments: { command: "pending" } },
				],
				usage: { inputTokens: 1, outputTokens: 1 },
				stopReason: "tool_use",
			},
			{ role: "toolResult", results: [result("Edited a", "edit")] },
		];
		const before = structuredClone(messages);
		const transcript = new TranscriptSink();
		replaySession({ write: transcript.feed, ansi: true, markdown: true, toolSink: transcript.toolSink }, {
			buildContext: () => ({ messages }),
		} as unknown as SessionStore);
		expect(messages).toEqual(before);
		expect(transcript.toolFolds).toHaveLength(3);
		expect(transcript.toolFolds[1]?.block.metadata).toContain("Diff unavailable in saved history");
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).toContain("●");
	});
});
