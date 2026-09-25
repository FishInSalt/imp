import { describe, expect, it, vi } from "vitest";
import type { ToolPresentationHooks } from "../src/core/tools/types.js";
import {
	prepareCall,
	prepareResult,
	UNAVAILABLE_ARGUMENTS_TEXT,
} from "../src/repl/tool-presentation-hooks.js";

const result = { toolCallId: "id", toolName: "custom", content: "original", display: "live", isError: true };
const resolver = (hooks: unknown) => () => hooks as ToolPresentationHooks;

describe("safe tool presentation", () => {
	it("captures hooks and freezes detached inputs and returned semantics", () => {
		const args = { nested: { value: "before" } };
		const output = { summary: "summary", preview: ["before"] };
		const call = vi.fn((context) => {
			expect(Object.isFrozen(context)).toBe(true);
			expect(Object.isFrozen(context.args.nested)).toBe(true);
			return output;
		});
		const end = vi.fn((context) => {
			expect(context.args.nested.value).toBe("before");
			expect(context.result).toEqual({ text: "original", display: "live", isError: true, images: [] });
			expect(Object.isFrozen(context.result.images)).toBe(true);
			return { summary: "end" };
		});
		const hooks = { call, result: end };
		const record = prepareCall("id", "custom", args, resolver(hooks));
		args.nested.value = "after";
		output.preview[0] = "after";
		hooks.result = vi.fn();
		expect(record.callSemantic?.preview).toEqual(["before"]);
		expect(
			prepareResult(record, result, false, () => {
				throw Error();
			}),
		).toEqual({ summary: "end" });
		expect(call).toHaveBeenCalledTimes(1);
		expect(end).toHaveBeenCalledTimes(1);
	});

	it("distinguishes null from unsafe and orphan arguments", () => {
		const hook = vi.fn((c) => ({ summary: `${c.argsAvailable}:${c.args}` }));
		expect(prepareCall("id", "custom", null, resolver({ call: hook })).callSemantic?.summary).toBe(
			"true:null",
		);
		expect(prepareResult(undefined, result, true, resolver({ result: hook }))?.summary).toBe("false:null");
		expect(prepareCall("id", "custom", undefined).argsAvailable).toBe(false);
	});

	it("never invokes getters, toJSON or retries unsafe values", () => {
		const getter = vi.fn(() => "secret");
		const toJSON = vi.fn(() => ({}));
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const inputs = [
			Object.defineProperty({}, "x", { get: getter }),
			{ toJSON },
			cyclic,
			new Date(),
			1n,
			Symbol(),
			() => 1,
			NaN,
			Infinity,
			[undefined],
			Array(3),
			new Proxy(
				{},
				{
					ownKeys() {
						throw Error("trap");
					},
				},
			),
		];
		const call = vi.fn();
		for (const args of inputs) {
			const record = prepareCall("id", "custom", args, resolver({ call }));
			expect(record.serializationStatus).toBe("unavailable");
			expect(record.rawArgsText).toBe(UNAVAILABLE_ARGUMENTS_TEXT);
		}
		expect(getter).not.toHaveBeenCalled();
		expect(toJSON).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
	});

	it("preserves prototype-like keys without prototype mutation", () => {
		const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"ok","prototype":1}');
		const record = prepareCall("id", "custom", input);
		expect(record.argsAvailable).toBe(true);
		expect(JSON.parse(record.rawArgsText)).toEqual(input);
		expect(Object.getPrototypeOf(record.args)).toBe(null);
	});

	it("disables semantic hooks at limits but retains ordinary raw data", () => {
		const call = vi.fn();
		let deep: unknown = null;
		for (let i = 0; i < 66; i++) deep = { next: deep };
		for (const args of [
			{ text: "x".repeat(1_000_001) },
			{ ["k".repeat(1_000_001)]: 1 },
			Array(100_001).fill(1),
			deep,
		]) {
			const record = prepareCall("id", "custom", args, resolver({ call }));
			expect(record.argsAvailable).toBe(false);
			expect(record.serializationStatus).toBe("available");
			expect(JSON.parse(record.rawArgsText)).toEqual(args);
		}
		expect(call).not.toHaveBeenCalled();
	});

	it("rejects malformed semantic output without invoking accessors or thenables", () => {
		const spy = vi.fn();
		const outputs = [
			null,
			"text",
			{ summary: 1 },
			{ summary: "x", other: true },
			{ summary: "x".repeat(4097) },
			{ summary: "x", preview: [1] },
			{ summary: "x", detail: Array(1001).fill("x") },
			{ summary: "x", preview: ["x".repeat(16385)] },
			{ summary: "x", detail: Array(7).fill("x".repeat(16000)) },
			Object.defineProperty({}, "summary", { get: spy }),
			// biome-ignore lint/suspicious/noThenProperty: hostile thenable fixture
			{ summary: "x", then: spy },
			// biome-ignore lint/suspicious/noThenProperty: hostile accessor fixture
			Object.defineProperty({ summary: "x" }, "then", { get: spy }),
			{ summary: "x", preview: Object.defineProperty(["x"], "0", { get: spy }) },
		];
		for (const output of outputs)
			expect(prepareCall("id", "custom", {}, resolver({ call: () => output })).callSemantic).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});

	it("guards resolver, hook and property failures", () => {
		expect(
			prepareCall("id", "custom", {}, () => {
				throw Error();
			}).callSemantic,
		).toBeUndefined();
		expect(
			prepareCall(
				"id",
				"custom",
				{},
				resolver({
					call() {
						throw Error();
					},
				}),
			).callSemantic,
		).toBeUndefined();
		const spy = vi.fn();
		expect(
			prepareCall("id", "custom", {}, resolver(Object.defineProperty({}, "call", { get: spy }))).callSemantic,
		).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});

	it("handles rejected native promises using the intrinsic, never overridden methods", async () => {
		const spy = vi.fn(() => {
			throw Error("should not run");
		});
		const promise = Promise.reject(Error("async"));
		// biome-ignore lint/suspicious/noThenProperty: intrinsic rejection-handler regression
		Object.defineProperties(promise, { then: { get: spy }, catch: { get: spy } });
		expect(prepareCall("id", "custom", {}, resolver({ call: () => promise })).callSemantic).toBeUndefined();
		expect(
			prepareCall(
				"id",
				"custom",
				{},
				resolver({
					call: async () => {
						throw Error("async");
					},
				}),
			).callSemantic,
		).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(spy).not.toHaveBeenCalled();
	});

	it("detaches image descriptors without exposing bytes", () => {
		const hook = vi.fn((c) => {
			expect(c.result.images).toEqual([{ mimeType: "image/png", encodedLength: 4 }]);
			expect(Object.isFrozen(c.result.images[0])).toBe(true);
			expect(c.result.text).toBe("text");
			return undefined;
		});
		prepareResult(
			undefined,
			{
				...result,
				content: [
					{ type: "text", text: "text" },
					{ type: "image", data: "abcd", mimeType: "image/png" },
				],
			},
			false,
			resolver({ result: hook }),
		);
		expect(hook).toHaveBeenCalledOnce();
	});
});
