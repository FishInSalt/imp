import { describe, expect, it } from "vitest";
import { parseSse, SseLimitError } from "../src/mcp/sse.js";

async function* streamOf(...chunks: (string | Buffer)[]): AsyncGenerator<Uint8Array> {
	for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
}

async function collect(chunks: (string | Buffer)[]) {
	const events = [];
	for await (const event of parseSse(streamOf(...chunks))) events.push(event);
	return events;
}

describe("parseSse (M19 D5)", () => {
	it("dispatches one event per blank line and joins multi-line data", async () => {
		expect(await collect(["data: one\ndata: two\n\n"])).toEqual([{ data: "one\ntwo" }]);
		expect(await collect(["data: x\n\n", "data: y\n\n"])).toEqual([{ data: "x" }, { data: "y" }]);
	});

	it("handles CRLF, comments and the no-space data form", async () => {
		expect(await collect([": keep-alive\r\ndata: a\r\n\r\n"])).toEqual([{ data: "a" }]);
		expect(await collect(["data:x\n\n"])).toEqual([{ data: "x" }]);
	});

	it("parses event/id fields and only dispatches events that carry data", async () => {
		expect(await collect(["event: e\nid: 7\ndata: d\n\n"])).toEqual([{ event: "e", id: "7", data: "d" }]);
		expect(await collect(["event: note\n\n"])).toEqual([]); // no data → no dispatch
	});

	it("decodes a multi-byte char split across chunks (P2-4 lesson)", async () => {
		const whole = Buffer.from("data: 中文\n\n", "utf-8");
		// split inside the first multibyte char ("data: " is 6 bytes, 中 is 3)
		const events = await collect([whole.subarray(0, 7), whole.subarray(7)]);
		expect(events).toEqual([{ data: "中文" }]);
	});

	it("flushes a trailing event without the final blank line at EOF", async () => {
		expect(await collect(["data: last"])).toEqual([{ data: "last" }]);
		expect(await collect(["data: a\n"])).toEqual([{ data: "a" }]);
	});

	it("throws on an event whose data exceeds the 10MB cap", async () => {
		const big = "x".repeat(1024 * 1024);
		const lines: string[] = [];
		for (let i = 0; i < 11; i++) lines.push(`data: ${big}\n`);
		await expect(collect([lines.join("")])).rejects.toBeInstanceOf(SseLimitError);
	});
});
