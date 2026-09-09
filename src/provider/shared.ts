/**
 * Transport plumbing shared by every wire-protocol implementation
 * (anthropic-messages, openai-completions, …). Extracted verbatim from
 * anthropic.ts in the #openai batch so the second protocol pays zero
 * re-derivation cost for SSE framing, abort semantics, and retry policy.
 */

/** Transient, idempotent-to-retry failures (nothing yielded yet). */
export const RETRY_DELAYS_MS = [600, 1500];
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export const delay = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

/**
 * Undici rejects the fetch body reader when its request is aborted; without
 * this wrapper that rejection escapes the provider as a thrown DOMException
 * and the agent loop mistakes a user abort for a provider failure.
 */
export async function* abortSafe<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
	try {
		for await (const item of source) yield item;
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

export interface SseEvent {
	event: string;
	data: unknown;
}

function parseFrame(frame: string): SseEvent | undefined {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) {
			event = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart());
		}
	}
	if (dataLines.length === 0) return undefined;
	try {
		return { event, data: JSON.parse(dataLines.join("\n")) };
	} catch {
		// Not JSON — e.g. OpenAI's terminating `data: [DONE]` sentinel.
		return undefined;
	}
}

/** Parse an SSE byte stream into events. Frames are separated by a blank line. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const parsed = parseFrame(frame);
				if (parsed) yield parsed;
				sep = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return { _parseError: "tool arguments were not valid JSON", raw: raw.slice(0, 500) };
	}
}

/**
 * Connection-level drops and 429/5xx are safe to retry: nothing has been
 * yielded and the request body is unchanged. Real usage shows compatible
 * endpoints drop connections occasionally (three live incidents during M4
 * acceptance alone) — one quiet retry saves whole turns. Mid-stream failures
 * after events started flowing are NOT retried (see abortSafe / truncation
 * handling in each provider).
 */
export async function postJsonWithRetry(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal?: AbortSignal,
	label = "LLM",
): Promise<Response | null> {
	let networkError: Error | null = null;
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
		if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1] ?? 0, signal);
		try {
			const r = await fetch(url, {
				method: "POST",
				headers,
				body,
				signal,
			});
			if (!RETRYABLE_STATUS.has(r.status) || attempt === RETRY_DELAYS_MS.length) {
				return r;
			}
			await r.text().catch(() => ""); // drain so the socket is released before retrying
		} catch (err) {
			// null, not a throw: an aborted request must end the provider's
			// stream silently (no message_end) — same contract as abortSafe
			if (signal?.aborted) return null;
			networkError = err instanceof Error ? err : new Error(String(err));
		}
	}
	throw new Error(`${label} request failed: ${networkError?.message ?? "retries exhausted"}`);
}
