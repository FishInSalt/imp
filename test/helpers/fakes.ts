import { PassThrough } from "node:stream";
import { Type } from "typebox";
import type { AgentMessage, AssistantMessage, Usage } from "../../src/core/messages.js";
import type { Tool } from "../../src/core/tools/types.js";
import type { LLMProvider, LLMRequest } from "../../src/provider/types.js";
import { Renderer } from "../../src/repl/render.js";

/**
 * Shared fakes for runner/REPL tests — no network, no real providers.
 * Streams are PassThrough so readline behaves exactly as with real stdio.
 */

export interface FakeConsole {
	stdin: PassThrough & { isTTY?: boolean; setRawMode?: (m: boolean) => void };
	stdout: { chunks: string[]; isTTY?: boolean; write(s: string): void };
	send(text: string): void;
	interrupt(): void;
	eof(): void;
	output(): string;
}

/** TTY mode attaches isTTY/setRawMode so readline enables terminal mode. */
export function makeConsole(options?: { tty?: boolean }): FakeConsole {
	const tty = options?.tty ?? false;
	const stdin = new PassThrough() as FakeConsole["stdin"];
	const chunks: string[] = [];
	const stdout: FakeConsole["stdout"] = {
		chunks,
		isTTY: tty ? true : undefined,
		write(s: string): void {
			chunks.push(s);
		},
	};
	if (tty) {
		stdin.isTTY = true;
		stdin.setRawMode = () => {};
	}
	return {
		stdin,
		stdout,
		send: (text: string) => {
			stdin.write(text);
		},
		interrupt: () => {
			stdin.write("\x03");
		},
		eof: () => {
			stdin.end();
		},
		output: () => chunks.join(""),
	};
}

/** A plain renderer with a collector — ansi-free output for exact assertions. */
export function makeRenderer(
	options?: Partial<{ ansi: boolean; liveTools: boolean; toolStyle: "one-line" | "two-line"; clock: () => number }>,
): { renderer: Renderer; output(): string } {
	const chunks: string[] = [];
	const renderer = new Renderer({
		write: (text: string) => {
			chunks.push(text);
		},
		ansi: options?.ansi ?? false,
		liveTools: options?.liveTools ?? false,
		toolStyle: options?.toolStyle ?? "one-line",
		clock: options?.clock,
	});
	return { renderer, output: () => chunks.join("") };
}

/** Let queued stream events / microtasks settle before asserting. */
export async function ticks(count = 8): Promise<void> {
	for (let i = 0; i < count; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** Poll until `cond()` holds (bounded); for orchestrating async runs. */
export async function waitUntil(cond: () => boolean, maxMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > maxMs) throw new Error("waitUntil: condition not met in time");
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
}

// --- scripted providers / messages (pattern from test/loop.test.ts) ---

export function assistant(
	blocks: AssistantMessage["blocks"],
	stopReason: AssistantMessage["stopReason"] = "end_turn",
	usage: Usage = { inputTokens: 10, outputTokens: 5 },
): AssistantMessage {
	return { role: "assistant", blocks, usage, stopReason };
}

export function user(content: string): AgentMessage {
	return { role: "user", content };
}

/** A script step is a fixed message, or a thunk (for delayed/throwing calls). */
export type ScriptStep = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

/** Replays scripted assistant messages in order; repeats the last if called again. */
export function scriptedProvider(scripts: ScriptStep[], sink?: LLMRequest[]): LLMProvider {
	let call = 0;
	return {
		name: "mock",
		async *stream(request) {
			if (sink) sink.push({ ...request, messages: [...request.messages] });
			const step = scripts[Math.min(call, scripts.length - 1)];
			if (step === undefined) throw new Error("scriptedProvider: no scripts provided");
			call++;
			const message = typeof step === "function" ? await step() : step;
			for (const block of message.blocks) {
				if (block.type === "text") yield { type: "text_delta", text: block.text };
				if (block.type === "toolCall") {
					yield { type: "tool_call_start", id: block.id, name: block.name };
				}
			}
			yield { type: "message_end", message };
		},
	};
}

/** Test-controlled latch for gating tool execution (steering/interrupt timing). */
export interface Gate {
	promise: Promise<void>;
	resolve(): void;
}

export function gate(): Gate {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A tool whose execution waits on `g.promise` — the "slow tool" under test. */
export function gatedTool(g: Gate, name = "gated"): Tool {
	return {
		name,
		description: "resolves only when the test gate opens",
		parameters: Type.Object({ message: Type.String() }),
		async execute(args) {
			await g.promise;
			return { output: `${name}: ${String(args.message)}` };
		},
	};
}
