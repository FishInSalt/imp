/**
 * Minimal SSE parser (M19 D5, docs/design/m19-mcp-http-design.md) for
 * text/event-stream responses. Server-sent events split on blank lines;
 * `data:` lines join with \n; comments (`:`) are ignored; `event:`/`id:`
 * are parsed but unused in v1 (no Last-Event-ID resumability).
 *
 * Byte-level care mirrors the NDJSON reader: lines are decoded only when
 * complete, so a multi-byte UTF-8 char straddling a chunk boundary cannot
 * corrupt a line (the P2-4 lesson). One event's data accumulates to a 10MB
 * cap — exceeding it throws (the transport treats that as fatal, like the
 * stdio line cap). A trailing event without a final blank line is flushed
 * at EOF (tolerant; pinned by tests).
 */
export interface SseEvent {
	event?: string;
	id?: string;
	data: string;
}

const MAX_EVENT_BYTES = 10 * 1024 * 1024;

export class SseLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SseLimitError";
	}
}

export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
	let buf: Buffer = Buffer.alloc(0);
	let dataLines: string[] = [];
	let event: string | undefined;
	let id: string | undefined;
	let dataBytes = 0;

	const dispatch = (): SseEvent | undefined => {
		if (dataLines.length === 0) {
			// an event block without data yields nothing (spec: dispatch only
			// when data is present); clear the field state either way
			event = undefined;
			id = undefined;
			return undefined;
		}
		const out: SseEvent = { data: dataLines.join("\n") };
		if (event !== undefined) out.event = event;
		if (id !== undefined) out.id = id;
		dataLines = [];
		event = undefined;
		id = undefined;
		dataBytes = 0;
		return out;
	};

	const handleLine = (raw: string): SseEvent | undefined => {
		let line = raw;
		if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); // leading BOM
		if (line === "") return dispatch();
		if (line.startsWith(":")) return undefined; // comment
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			dataBytes += Buffer.byteLength(value, "utf-8") + 1;
			if (dataBytes > MAX_EVENT_BYTES) {
				throw new SseLimitError("SSE event over 10MB — connection dropped (M19 D5)");
			}
			dataLines.push(value);
		} else if (field === "event") {
			event = value;
		} else if (field === "id") {
			if (!value.includes("\0")) id = value; // spec: ignore ids with NUL
		}
		// other fields (retry, etc.) are ignored
		return undefined;
	};

	for await (const chunk of stream) {
		buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
		let nl = buf.indexOf(0x0a);
		while (nl >= 0) {
			let line = buf.subarray(0, nl).toString("utf-8");
			if (line.endsWith("\r")) line = line.slice(0, -1);
			buf = buf.subarray(nl + 1);
			const ev = handleLine(line);
			if (ev !== undefined) yield ev;
			nl = buf.indexOf(0x0a);
		}
		if (buf.length > MAX_EVENT_BYTES) {
			throw new SseLimitError("SSE line over 10MB — connection dropped (M19 D5)");
		}
	}
	// EOF: a trailing line without \n is still a line (tolerant), and a
	// pending event without a final blank line is flushed.
	if (buf.length > 0) {
		let line = buf.toString("utf-8");
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const ev = handleLine(line);
		if (ev !== undefined) yield ev;
	}
	const last = dispatch();
	if (last !== undefined) yield last;
}
