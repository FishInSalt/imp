import { describe, expect, it } from "vitest";
import { commandPreviewText, renderCommandHeader } from "../src/repl/components/tool-block.js";

/** #confirm-prompt Phase 2 (design §6 D7): the byte-exact pins for the
 *  extension-supplied command preview. The TUI test pins the layout (rendered
 *  once, in the call-header idiom, no completion suffix); these pin the bytes —
 *  the TUI splits a styled row across writes, so the two cannot share a pin. */

const preview = (extra: Record<string, unknown> = {}) => ({
	kind: "command",
	tool: "bash",
	text: "rm -rf node_modules && npm i",
	...extra,
});

describe("#confirm-prompt Phase 2: command preview rendering", () => {
	it("renders the transcript's call-header idiom with the alert span styled and closed", () => {
		const line = renderCommandHeader(preview({ warnSpans: [[0, 6]] }));
		expect(line).toBe(
			"\x1b[2m●\x1b[0m" + // dim marker
				" " + // the space between marker and name rides outside the spans
				"\x1b[1mbash\x1b[0m" + // bold tool name
				"  " +
				"\x1b[1;31mrm -rf\x1b[0m" + // the risky fragment, reset-closed
				" node_modules && npm i",
		);
	});

	it("carries no completion suffix — the call has not run", () => {
		const line = renderCommandHeader(preview());
		expect(line).not.toContain("✓");
		expect(line).not.toContain("✗");
	});

	it("clips, sorts and merges hostile offsets into the text", () => {
		const line = renderCommandHeader(
			preview({
				warnSpans: [
					[10, 2],
					[-5, 3],
					[1, 4],
					[1_000_000, 2_000_000],
				],
			}),
		);
		// [-5,3) clips to [0,3), merges with [1,4) → [0,4); [10,2) and the huge
		// range fall away. Exactly one alert pair in the output.
		expect(line.split("\x1b[1;31m")).toHaveLength(2);
		expect(line).toContain("\x1b[1;31mrm -\x1b[0m");
	});

	it("renders nothing for malformed previews (unknown kind, wrong types, empty fields)", () => {
		expect(renderCommandHeader(undefined)).toBe("");
		expect(renderCommandHeader(null)).toBe("");
		expect(renderCommandHeader("command")).toBe("");
		expect(renderCommandHeader({ kind: "diff", tool: "bash", text: "x" })).toBe("");
		expect(renderCommandHeader({ kind: "command", tool: 7, text: "x" })).toBe("");
		expect(renderCommandHeader({ kind: "command", tool: "bash", text: null })).toBe("");
		expect(renderCommandHeader({ kind: "command", tool: "", text: "x" })).toBe("");
		expect(renderCommandHeader({ kind: "command", tool: "bash", text: "" })).toBe("");
	});

	it("consumes terminal control sequences and keeps a single-line tool name", () => {
		const line = renderCommandHeader(preview({ tool: "ba\nsh", text: "echo \x1b[31mred\x1b[0m ok" }));
		expect(line).not.toContain("\x1b[31m"); // the extension's own color is consumed
		expect(line).not.toContain("\n"); // the name never spans lines
		expect(line).toContain("ba sh");
		expect(line).toContain("echo red ok");
	});

	it("closes every style it opens — no row can end inside the alert span", () => {
		// the alert span reaches the end: the last byte closes it
		expect(renderCommandHeader(preview({ warnSpans: [[10, 28]] })).endsWith("\x1b[0m")).toBe(true);
		// the alert span sits mid-line: nothing is open at the end, no stray reset
		const middle = renderCommandHeader(preview({ warnSpans: [[0, 6]] }));
		expect(middle.endsWith("\x1b[0m")).toBe(false);
		expect(middle.endsWith(" node_modules && npm i")).toBe(true);
		// three opens (marker, name, alert), three closes
		expect(middle.split("\x1b[0m")).toHaveLength(4);
	});

	it("the plain form is the note surface's carrier: no ANSI, same idiom", () => {
		expect(commandPreviewText(preview({ warnSpans: [[0, 16]] }))).toBe(
			"● bash  rm -rf node_modules && npm i",
		);
		expect(commandPreviewText({ kind: "command", tool: "bash", text: "echo \x1b[31mred\x1b[0m" })).toBe(
			"● bash  echo red",
		);
		expect(commandPreviewText(undefined)).toBe("");
		expect(commandPreviewText({ kind: "command", tool: "bash", text: "" })).toBe("");
	});
});

describe("#tool-name-colors: the preview name follows the injected resolver", () => {
	it("paints exactly the name span when the resolver returns a token; legacy bytes otherwise", () => {
		const yellow = renderCommandHeader(preview(), (name) => (name === "bash" ? "yellow" : undefined));
		expect(yellow).toBe("\x1b[2m●\x1b[0m \x1b[1m\x1b[33mbash\x1b[0m  rm -rf node_modules && npm i");
		// no resolver (unit hosts), unknown name, and none keep the plain bold bytes
		expect(renderCommandHeader(preview())).toContain("\x1b[1mbash\x1b[0m");
		expect(renderCommandHeader(preview(), () => undefined)).toContain("\x1b[1mbash\x1b[0m");
		expect(renderCommandHeader(preview(), () => "none")).toContain("\x1b[1mbash\x1b[0m");
		expect(renderCommandHeader(preview(), () => "none")).not.toContain("\x1b[33m");
		// the warn span is untouched by the name color
		expect(renderCommandHeader(preview(), () => "#d97757")).toContain(
			"\x1b[1m\x1b[38;2;217;119;87mbash\x1b[0m",
		);
		const warn = renderCommandHeader(preview({ warnSpans: [[0, 6]] }), () => "yellow");
		expect(warn).toContain("\x1b[1;31mrm -rf\x1b[0m");
		expect(warn).toContain("\x1b[1m\x1b[33mbash\x1b[0m");
	});
});
