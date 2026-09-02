import type { AgentMessage } from "../core/messages.js";
import type { SessionStore } from "../core/session/store.js";
import { firstLine, summarizeArgs } from "../format.js";
import { Renderer } from "./render.js";

export interface ReplayOptions {
	write: (text: string) => void;
	ansi: boolean;
	/** Render assistant text with markdown-lite (matches the live REPL). */
	markdown: boolean;
}

/** Compaction summary frames start with this marker (see summaryToMessage). */
const SUMMARY_MARK = "[Conversation summary —";

/**
 * Replays a resumed session's history through a non-live Renderer so the
 * user sees exactly what the model sees on the next request (the crash-
 * recovery loop's missing half: "your work is saved" now shows the work).
 *
 * Reuses the live render pipeline (tool lines, ⎿ summaries, markdown-lite)
 * with spinners off — history is settled, nothing is running. Returns the
 * number of messages replayed (0 for a fresh session).
 */
export function replaySession(options: ReplayOptions, session: SessionStore): number {
	const renderer = new Renderer({
		write: options.write,
		ansi: options.ansi,
		liveTools: false,
		toolStyle: "one-line",
		markdown: options.markdown,
	});
	const { messages } = session.buildContext();
	if (messages.length === 0) return 0;
	const unmatchedTools = new Map<string, { name: string; args: unknown }>(); // dangling tool_use
	for (const message of messages) {
		renderMessage(renderer, message, unmatchedTools);
	}
	renderer.raw("\n"); // settle any markdown tail; blank line before the prompt
	renderer.endRun();
	// Session ended mid-run (Ctrl+C / crash / force-quit): the tool line was
	// never finalized. Show it honestly — the next request self-heals the
	// context via synthesizeMissingToolResults; this is display only.
	for (const { name, args } of unmatchedTools.values()) {
		renderer.writeLine(`${renderer.dim(`● ${name} ${summarizeArgs(name, args)}`)} … no result (interrupted)`);
	}
	return messages.length;
}

function renderMessage(
	renderer: Renderer,
	message: AgentMessage,
	unmatchedTools: Map<string, { name: string; args: unknown }>,
): void {
	switch (message.role) {
		case "user": {
			if (message.content.startsWith(SUMMARY_MARK)) {
				renderer.note("▪ conversation summary (earlier messages were compacted):");
				const body = message.content.split("]\n\n", 2)[1] ?? message.content;
				renderer.raw(`${renderer.dim(body.trim())}\n\n`);
				return;
			}
			const lines = message.content.split("\n");
			const more = lines.length > 1 ? ` ${renderer.dim(`(+${lines.length - 1} lines)`)}` : "";
			renderer.writeLine(`> ${firstLine(message.content, 200)}${more}`);
			return;
		}
		case "assistant": {
			for (const block of message.blocks) {
				if (block.type === "text") {
					const text = block.text.trim();
					if (text !== "") renderer.raw(`${text}\n\n`);
				} else {
					unmatchedTools.set(block.id, { name: block.name, args: block.arguments });
					renderer.event({
						type: "tool_start",
						toolCallId: block.id,
						name: block.name,
						args: block.arguments,
					});
				}
			}
			return;
		}
		case "toolResult": {
			for (const result of message.results) {
				unmatchedTools.delete(result.toolCallId);
				renderer.event({ type: "tool_end", result });
			}
			return;
		}
	}
}
