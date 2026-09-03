import type { TSchema } from "typebox";

export interface ToolExecuteResult {
	/** Text fed back to the model as the tool result. */
	output: string;
	isError?: boolean;
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
