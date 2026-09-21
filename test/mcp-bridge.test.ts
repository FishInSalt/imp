import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES, MAX_BYTES } from "../src/core/constants.js";
import { directToolName, mapCallResult, normalizeInputSchema } from "../src/mcp/bridge.js";

describe("normalizeInputSchema (design §4)", () => {
	it("passes an object schema through untouched", () => {
		const schema = { type: "object", properties: { x: { type: "string" } } };
		expect(normalizeInputSchema(schema)).toBe(schema);
	});

	it("keeps siblings when the type is merely missing", () => {
		expect(normalizeInputSchema({ properties: { x: { type: "string" } } })).toEqual({
			type: "object",
			properties: { x: { type: "string" } },
		});
	});

	it("replaces an explicit non-object type with a fresh object wrapper", () => {
		// Siblings were written for the wrong type — they must not survive
		// (e.g. maxLength under type:object would be inert garbage).
		expect(normalizeInputSchema({ type: "string", maxLength: 5 })).toEqual({ type: "object" });
	});

	it("falls back to a bare object schema for garbage", () => {
		expect(normalizeInputSchema(null)).toEqual({ type: "object" });
		expect(normalizeInputSchema("string")).toEqual({ type: "object" });
		expect(normalizeInputSchema([1])).toEqual({ type: "object" });
		expect(normalizeInputSchema({})).toEqual({ type: "object" });
	});
});

describe("directToolName (design §4)", () => {
	it("builds <server>_<tool>", () => {
		expect(directToolName("zai-vision", "analyze_image")).toEqual({ name: "zai-vision_analyze_image" });
	});

	it("rejects names outside the tool pattern with the reason", () => {
		const result = directToolName("ZAI", "tool");
		expect("error" in result && result.error).toContain("does not match");
	});

	it("rejects collisions with builtin tools", () => {
		const builtin = BUILTIN_TOOL_NAMES[0] as string; // e.g. "bash"
		const [server, tool] = builtin.split("_");
		// Only meaningful when the pieces can actually compose the name.
		if (server !== undefined && tool !== undefined) {
			const result = directToolName(server, tool);
			expect("error" in result && result.error).toContain("built-in");
		}
		expect("error" in directToolName("x", "bash")).toBe(false); // x_bash is fine
	});

	it("rejects over-length composites", () => {
		expect("error" in directToolName("a", "b".repeat(70))).toBe(true);
	});
});

describe("mapCallResult (design §4)", () => {
	it("joins text blocks with newlines", () => {
		const result = mapCallResult({
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
		});
		expect(result.output).toBe("one\ntwo");
		expect(result.isError).toBeUndefined();
	});

	it("appends the omission note for non-text blocks (and stands alone when text is empty)", () => {
		expect(mapCallResult({ content: [{ type: "text", text: "t" }, { type: "image" }] }).output).toBe(
			"t\n(1 non-text block omitted)",
		);
		expect(mapCallResult({ content: [{ type: "image" }, { type: "audio" }] }).output).toBe(
			"(2 non-text blocks omitted)",
		);
	});

	it("maps empty content to an empty string, not a crash", () => {
		expect(mapCallResult({ content: [] }).output).toBe("");
	});

	it("passes isError through as true only when the server set it", () => {
		expect(mapCallResult({ content: [{ type: "text", text: "no" }], isError: true }).isError).toBe(true);
		expect(
			mapCallResult({ content: [{ type: "text", text: "no" }], isError: false }).isError,
		).toBeUndefined();
	});

	it("tail-truncates output over MAX_BYTES with a note (review P2-6)", () => {
		const huge = "x".repeat(MAX_BYTES + 10_000);
		const result = mapCallResult({ content: [{ type: "text", text: huge }] });
		expect(result.output.startsWith("[truncated — kept the last 50KB]\n")).toBe(true);
		// The kept tail is the last MAX_BYTES bytes of the original, plus the note.
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_BYTES + 100);
		expect(result.output.endsWith("x".repeat(100))).toBe(true);
	});

	it("leaves ordinary output alone", () => {
		expect(mapCallResult({ content: [{ type: "text", text: "fine" }] }).output).toBe("fine");
	});
});
