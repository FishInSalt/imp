/** Cancel an unused response body without exposing cleanup failures. */
export async function cancelBody(response) {
	try {
		await response?.body?.cancel();
	} catch {
		// Cleanup is best effort, including already locked or errored bodies.
	}
}

/** Clip by UTF-16 code units without leaving a trailing high surrogate. */
export function clip(text, limit) {
	const end = Math.max(0, Math.trunc(limit));
	if (text.length <= end) return text;
	const result = text.slice(0, end);
	const last = result.charCodeAt(result.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? result.slice(0, -1) : result;
}

/** Read at most limit body bytes, retaining only complete UTF-8 at truncation. */
export async function readBounded(response, limit, { truncate = false } = {}) {
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new RangeError("Body byte limit must be a nonnegative safe integer.");
	}
	if (!response.body) return { text: "", truncated: false };

	let reader;
	let done = false;
	try {
		reader = response.body.getReader();
		const decoder = new TextDecoder();
		const parts = [];
		let bytes = 0;
		while (true) {
			const next = await reader.read();
			if (next.done) {
				done = true;
				parts.push(decoder.decode());
				return { text: parts.join(""), truncated: false };
			}
			const remaining = limit - bytes;
			const overflow = next.value.byteLength > remaining;
			// Decode only the accepted prefix, even if a producer emits a huge chunk.
			const part = decoder.decode(
				overflow ? next.value.subarray(0, remaining) : next.value,
				{ stream: true },
			);
			if (part) parts.push(part);
			if (overflow) {
				if (!truncate) {
					const error = new Error("Response body exceeds the byte limit.");
					error.code = "TOO_LARGE";
					throw error;
				}
				// Do not flush: a pending UTF-8 suffix is incomplete at this boundary.
				return { text: parts.join(""), truncated: true };
			}
			bytes += next.value.byteLength;
		}
	} finally {
		if (reader) {
			if (!done) {
				try {
					await reader.cancel();
				} catch {
					// Never mask the original read failure or overflow result.
				}
			}
			try {
				reader.releaseLock();
			} catch {
				// Cleanup failures must not replace the result.
			}
		} else {
			await cancelBody(response);
		}
	}
}
