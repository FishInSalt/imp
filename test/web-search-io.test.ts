import { describe, expect, it, vi } from "vitest";

const modulePath = "../examples/extensions/web-search/_lib/io.mjs";
const { readBounded, clip, cancelBody } = (await import(modulePath)) as {
	readBounded: (
		response: { body: ReadableStream<Uint8Array> | null },
		limit: number,
		options?: { truncate?: boolean },
	) => Promise<{ text: string; truncated: boolean }>;
	clip: (text: string, limit: number) => string;
	cancelBody: (response: { body: ReadableStream<Uint8Array> | null }) => Promise<void>;
};
const encoder = new TextEncoder();

function stream(chunks: Uint8Array[], cancel = vi.fn()) {
	let index = 0;
	const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
		if (index < chunks.length) controller.enqueue(chunks[index++]!);
		else controller.close();
	});
	const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
	return { body, pull, cancel };
}

describe("web search bounded I/O", () => {
	it("handles absent and empty bodies", async () => {
		expect(await readBounded({ body: null }, 0)).toEqual({ text: "", truncated: false });
		expect(await readBounded(stream([]), 0)).toEqual({ text: "", truncated: false });
	});

	it("does not label exact-limit EOF as truncated", async () => {
		const response = stream([encoder.encode("abcd")]);
		expect(await readBounded(response, 4, { truncate: true })).toEqual({
			text: "abcd",
			truncated: false,
		});
		expect(response.pull).toHaveBeenCalledTimes(2);
		expect(response.cancel).not.toHaveBeenCalled();
		expect(response.body.locked).toBe(false);
	});

	it("stops an infinite producer immediately on overflow", async () => {
		const cancel = vi.fn();
		const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
			controller.enqueue(encoder.encode("ab"));
		});
		const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
		await expect(readBounded({ body }, 4)).rejects.toMatchObject({ code: "TOO_LARGE" });
		expect(pull).toHaveBeenCalledTimes(3);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
	});

	it("accepts only a bounded prefix of a large chunk", async () => {
		const response = stream([new Uint8Array(2 ** 20).fill(97), encoder.encode("unread")]);
		expect(await readBounded(response, 3, { truncate: true })).toEqual({
			text: "aaa",
			truncated: true,
		});
		expect(response.pull).toHaveBeenCalledTimes(1);
		expect(response.cancel).toHaveBeenCalledTimes(1);
	});

	it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])("handles UTF-8 boundary at byte %i", async (limit) => {
		const bytes = encoder.encode("aé€😀z");
		const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
		const expected = limit < 1 ? "" : limit < 3 ? "a" : limit < 6 ? "aé" : limit < 10 ? "aé€" : "aé€😀";
		expect(await readBounded(stream(chunks), limit, { truncate: true })).toEqual({
			text: expected,
			truncated: true,
		});
		// Exercise the same boundary inside one chunk as well.
		expect(await readBounded(stream([bytes]), limit, { truncate: true })).toEqual({
			text: expected,
			truncated: true,
		});
	});

	it("decodes split UTF-8 at exact EOF and flushes malformed EOF normally", async () => {
		const chunks = Array.from(encoder.encode("😀"), (byte) => new Uint8Array([byte]));
		expect(await readBounded(stream(chunks), 4)).toEqual({ text: "😀", truncated: false });
		expect(await readBounded(stream([new Uint8Array([0xc3])]), 1)).toEqual({
			text: "�",
			truncated: false,
		});
	});

	it("preserves read errors and releases errored streams", async () => {
		const error = new Error("private upstream failure");
		const body = new ReadableStream<Uint8Array>({
			pull() {
				throw error;
			},
		});
		await expect(readBounded({ body }, 10)).rejects.toBe(error);
		expect(body.locked).toBe(false);
	});

	it("ignores cancellation rejection for truncation and overflow errors", async () => {
		for (const truncate of [false, true]) {
			const response = stream(
				[encoder.encode("abc")],
				vi.fn(async () => {
					throw new Error("cleanup failure");
				}),
			);
			const result = readBounded(response, 1, { truncate });
			if (truncate) await expect(result).resolves.toEqual({ text: "a", truncated: true });
			else await expect(result).rejects.toMatchObject({ code: "TOO_LARGE" });
			expect(response.body.locked).toBe(false);
		}
	});

	it("cancels unused bodies best effort including locked and absent bodies", async () => {
		const response = stream(
			[],
			vi.fn(async () => {
				throw new Error("cleanup failure");
			}),
		);
		await expect(cancelBody(response)).resolves.toBeUndefined();
		expect(response.cancel).toHaveBeenCalledTimes(1);
		await expect(cancelBody({ body: null })).resolves.toBeUndefined();
		const locked = stream([]);
		const reader = locked.body.getReader();
		await expect(cancelBody(locked)).resolves.toBeUndefined();
		await expect(readBounded(locked, 1)).rejects.toBeInstanceOf(TypeError);
		reader.releaseLock();
	});

	it("clips UTF-16 without splitting surrogate pairs", () => {
		expect(clip("a😀b", 2)).toBe("a");
		expect(clip("a😀b", 3)).toBe("a😀");
		expect(clip("a😀b", 4)).toBe("a😀b");
		expect(clip("abc", 0)).toBe("");
		expect(clip("é€", 1)).toBe("é");
	});
});
