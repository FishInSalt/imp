import type { TSchema } from "typebox";
import type { ContentBlock } from "../messages.js";

export interface ToolExecuteResult {
	/** Text fed back to the model as the tool result. */
	output: string;
	isError?: boolean;
	/** Structured content blocks (M13 images). When set, the loop stores
	 *  these as the ToolResult content and `output` is display-only —
	 *  used today by read's image path (text note + image attachment).
	 *  Absent for every other tool: content stays the `output` string. */
	content?: ContentBlock[];
	/** The process exit status, when the tool ran one (bash). Structured —
	 *  never parsed back out of `output`: the display layer used to strip a
	 *  trailing "Exit code: N" section textually, which a command's own
	 *  stdout could forge (debt clearance). Absent for non-process tools. */
	exitCode?: number;
}

/**
 * A tool is pure data + one async function. No hidden coupling to the loop,
 * the provider, or the UI. AbortSignal must be honored (Ctrl+C kills tools).
 */
export interface Tool {
	name: string;
	/** Written for the model. Quality of this text is prompt engineering. */
	description: string;
	/**
	 * True: calls to this tool may run concurrently with each other (M5
	 * design §6). The loop batches maximal runs of consecutive safe calls in
	 * one assistant message and executes each batch in capped chunks; every
	 * other tool stays strictly serial. Absent = serial.
	 */
	concurrencySafe?: boolean;
	parameters: TSchema;
	execute(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecuteResult>;
}
