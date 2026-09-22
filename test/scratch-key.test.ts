import { describe, expect, it } from "vitest";
import { TreeSelectorComponent } from "../src/repl/components/tree-selector.js";

describe("scratch", () => {
	it("exact replica", () => {
		let cancelled = false;
		const selector = new TreeSelectorComponent(
			[
				{
					entry: {
						type: "message",
						id: "u",
						parentId: null,
						timestamp: "t",
						message: { role: "user", content: "x" },
					},
					children: [],
				},
			],
			null,
			10,
			() => {},
			() => {
				cancelled = true;
			},
		);
		selector.handleInput("\t");
		console.log("TAB rows:", selector.rows().length);
		selector.handleInput("\x1b");
		console.log("ESC cancelled:", cancelled);
	});
});
