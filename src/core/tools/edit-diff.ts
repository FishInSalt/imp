/**
 * Exact-match multi-edit machinery for the edit tool.
 *
 * Semantics (inherited from pi): every edits[].oldText is matched against the
 * ORIGINAL file content — not incrementally. Each must match exactly once and
 * must not overlap any other edit. Either all edits apply or none do.
 */

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEdit {
	oldText: string;
	newText: string;
	/** Index of the replacement in the ORIGINAL content. */
	start: number;
	end: number;
	/** 1-indexed line of `start` in the original content. */
	line: number;
}

export type ApplyResult =
	| { ok: true; content: string; applied: AppliedEdit[] }
	| { ok: false; error: string };

export function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** Teach, don't just fail: errors explain what to do next. */
function describeFailure(index: number, edit: Edit, count: number): string {
	if (count === 0) {
		return `edits[${index}].oldText was not found in the file. The match is exact — whitespace, indentation, and line breaks all matter. Read the file again, copy the text exactly (including leading whitespace), and make sure it is unique. If the file uses CRLF line endings, match them or keep oldText to a single line.`;
	}
	return `edits[${index}].oldText matches ${count} times. Include more surrounding lines (comments, blank lines) to make it unique.`;
}

export function applyEdits(original: string, edits: Edit[]): ApplyResult {
	const applied: AppliedEdit[] = [];

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (!edit) continue;
		const { oldText, newText } = edit;
		if (oldText === "") {
			return { ok: false, error: `edits[${i}].oldText is empty — provide the exact text to replace.` };
		}
		if (oldText === newText) {
			return { ok: false, error: `edits[${i}].newText is identical to oldText — nothing would change.` };
		}
		const count = countOccurrences(original, oldText);
		if (count !== 1) {
			return { ok: false, error: describeFailure(i, edit, count) };
		}
		const start = original.indexOf(oldText);
		const line = original.slice(0, start).split("\n").length;
		applied.push({ oldText, newText, start, end: start + oldText.length, line });
	}

	// Overlap check (sorted by start, adjacent pairs).
	applied.sort((a, b) => a.start - b.start);
	for (let i = 1; i < applied.length; i++) {
		const prev = applied[i - 1];
		const cur = applied[i];
		if (prev && cur && cur.start < prev.end) {
			return {
				ok: false,
				error:
					`edits overlap around original line ${cur.line}. Overlapping or nested edits are not allowed — ` +
					`merge them into a single edit that covers the whole region once.`,
			};
		}
	}

	// Rebuild the file from the original plus non-overlapping sorted ranges.
	let content = "";
	let cursor = 0;
	for (const edit of applied) {
		content += original.slice(cursor, edit.start) + edit.newText;
		cursor = edit.end;
	}
	content += original.slice(cursor);

	return { ok: true, content, applied };
}

/** Simple line diff (LCS) between two small text fragments. */
export function diffLines(before: string, after: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	// LCS table. Edit fragments are small; for pathological sizes, degrade gracefully.
	if (a.length * b.length > 1_000_000) {
		return `- ${a.length} lines\n+ ${b.length} lines (diff elided)`;
	}
	const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
		}
	}
	const lines: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
		} else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
			lines.push(`- ${a[i] ?? ""}`);
			i++;
		} else {
			lines.push(`+ ${b[j] ?? ""}`);
			j++;
		}
	}
	while (i < a.length) lines.push(`- ${a[i++] ?? ""}`);
	while (j < b.length) lines.push(`+ ${b[j++] ?? ""}`);
	return lines.join("\n");
}

/** BOM helpers: strip for processing, restore on write. */
export function stripBom(text: string): { bom: string; text: string } {
	return text.charCodeAt(0) === 0xfeff ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

/** Detect the dominant line ending so CRLF files round-trip unchanged. */
export function detectLineEnding(text: string): "\r\n" | "\n" {
	const crlf = countOccurrences(text, "\r\n");
	const lf = countOccurrences(text, "\n") - crlf;
	return crlf > lf ? "\r\n" : "\n";
}

export function replaceLineEndings(text: string, ending: "\r\n" | "\n"): string {
	// Normalize any \r variant first, then apply the target ending exactly once.
	const lf = text.replace(/\r\n?/g, "\n");
	return ending === "\n" ? lf : lf.split("\n").join(ending);
}
