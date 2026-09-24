import { type AgentMessage, contentText } from "../core/messages.js";
import type { SessionStore } from "../core/session/store.js";
import { BRANCH_MARK, SUMMARY_MARK } from "../core/session/store.js";
import { skillBlockSummary } from "../core/skills.js";
import { firstLine, summarizeArgs } from "../format.js";
import { Renderer } from "../render.js";
import type { ThinkingSink } from "../thinking-sink.js";

export interface ReplayOptions {
	write: (text: string) => void;
	ansi: boolean;
	/** Render assistant text with markdown-lite (matches the live REPL). */
	markdown: boolean;
	/** TUI mode: user messages render as full-width background blocks (pi
	 *  parity) instead of the truncated `> first-line` preview. */
	userSink?: (text: string) => void;
	/** Pi-style dim status lines (replay itself emits none; the option
	 *  rides along so the Renderer wiring stays uniform). */
	statusSink?: (text: string) => void;
	/** pi's hideThinkingBlock: replays render the "Thinking..." label. */
	hideThinking?: boolean;
	thinkingSink?: ThinkingSink;
}

/** Compaction summary frames start with this marker (see summaryToMessage). */

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
		userSink: options.userSink,
		statusSink: options.statusSink,
		hideThinking: options.hideThinking,
		thinkingSink: options.thinkingSink,
	});
	const { messages } = session.buildContext();
	if (messages.length === 0) return 0;
	const unmatchedTools = new Map<string, { name: string; args: unknown }>(); // dangling tool_use
	for (const message of messages) {
		renderMessage(renderer, message, unmatchedTools, options.userSink, options.thinkingSink !== undefined);
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
	userSink?: (text: string) => void,
	semanticThinking = false,
): void {
	switch (message.role) {
		case "user": {
			// Blocked content (M13) has no summary/branch/skill markers by
			// construction — collapse to its text for the marker checks.
			const userText = contentText(message.content);
			if (userText.startsWith(SUMMARY_MARK)) {
				renderer.note("▪ conversation summary (earlier messages were compacted):");
				const body = userText.split("]\n\n", 2)[1] ?? userText;
				renderer.raw(`${renderer.dim(body.trim())}\n\n`);
				return;
			}
			if (userText.startsWith(BRANCH_MARK)) {
				renderer.note("▪ branch summary (a direction you left, kept for context):");
				const body = userText.split("]\n\n", 2)[1] ?? userText;
				renderer.raw(`${renderer.dim(body.trim())}\n\n`);
				return;
			}
			// M12 §11.3: an expanded skill block (possibly hundreds of lines)
			// collapses to the same summary line the live echo showed — display
			// normalization only; the session record keeps the full text.
			const skillLine = skillBlockSummary(userText);
			if (skillLine !== null) {
				renderer.note(skillLine);
				return;
			}
			if (semanticThinking) {
				renderer.user(userText);
				return;
			}
			if (userSink !== undefined) {
				// TUI: the full message body as a background block — the live
				// echo and the replay show the same shape (pi parity).
				userSink(userText);
				return;
			}
			const lines = userText.split("\n");
			const more = lines.length > 1 ? ` ${renderer.dim(`(+${lines.length - 1} lines)`)}` : "";
			renderer.writeLine(`> ${firstLine(userText, 200)}${more}`);
			return;
		}
		case "assistant": {
			for (const block of message.blocks) {
				if (block.type === "text") {
					const text = block.text.trim();
					if (text !== "") renderer.raw(`${text}\n\n`);
				} else if (block.type === "thinking") {
					// dim like the live stream (#thinking-levels): runs of
					// thinking render as one dim section above the text
					const thinking = semanticThinking ? block.thinking : block.thinking.trim();
					if (semanticThinking || thinking !== "") renderer.thinking(thinking);
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
			if (semanticThinking) renderer.completeAssistantMessage();
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
