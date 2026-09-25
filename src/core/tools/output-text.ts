/** LF records: a terminal LF terminates a record, not an extra empty one. */
export function logicalLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

export function wholeLinePrefix(lines: string[], limit: number, bytes: number) {
	const accepted: string[] = [];
	let size = 0;
	let byteLimited = false;
	for (const line of lines.slice(0, limit)) {
		const next = Buffer.byteLength(line) + (accepted.length > 0 ? 1 : 0);
		if (size + next > bytes) {
			byteLimited = true;
			break;
		}
		accepted.push(line);
		size += next;
	}
	return { text: accepted.join("\n"), count: accepted.length, byteLimited };
}

/** Remove only incomplete UTF-8 boundary sequences; invalid source still decodes normally. */
export function decodePrefix(bytes: Buffer, cut: boolean): string {
	let end = bytes.length;
	if (cut && end > 0) {
		let start = end - 1;
		while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
		const lead = bytes[start]!;
		const width =
			lead >= 0xc2 && lead <= 0xdf
				? 2
				: lead >= 0xe0 && lead <= 0xef
					? 3
					: lead >= 0xf0 && lead <= 0xf4
						? 4
						: 1;
		if (width > end - start) end = start;
	}
	return bytes.subarray(0, end).toString("utf8");
}

export function renderedHead(text: string, cap: number): string {
	const bytes = Buffer.from(text);
	return decodePrefix(bytes.subarray(0, cap), bytes.length > cap);
}

export function tailStart(bytes: Buffer, start: number): number {
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return start;
}
