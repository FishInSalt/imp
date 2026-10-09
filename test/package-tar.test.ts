import { describe, expect, it } from "vitest";
// @ts-expect-error The package smoke script is JavaScript without declarations.
import { parseTar } from "../scripts/package-smoke.mjs";

const blockSize = 512;
const endBlocks = Buffer.alloc(2 * blockSize);
const paths = [
	"package.json",
	"README.md",
	"README.zh-CN.md",
	"LICENSE",
	"bin/ink.js",
	"CHANGELOG.md",
	"docs/index.md",
	"docs/cli.md",
	"docs/zh-CN/index.md",
	"examples/agents/scout.md",
	"dist/cli.js",
];
const permittedPaths = new Set([...paths, "dist/format.js"]);

interface TarFile {
	path: string;
	mode: number;
	size: number;
	data: Buffer;
}

function inspect(tar: Buffer): TarFile[] {
	return parseTar(tar, permittedPaths);
}

function octal(header: Buffer, start: number, length: number, value: number) {
	header.fill(0, start, start + length);
	header.write(`${value.toString(8).padStart(length - 2, "0")} \0`, start, length, "latin1");
}

function checksum(header: Buffer) {
	header.fill(0x20, 148, 156);
	const sum = [...header].reduce((total, byte) => total + byte, 0);
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
}

/** Independent POSIX ustar byte fixture, not npm's JSON pack report. */
function entry(path: string, data = Buffer.from("fixture\n"), type = "0") {
	const header = Buffer.alloc(blockSize);
	header.write(path, 0, 100, "latin1");
	octal(header, 100, 8, path === "package/bin/ink.js" ? 0o755 : 0o644);
	// npm pack leaves uid/gid empty and encodes zero device IDs in octal.
	octal(header, 124, 12, data.length);
	octal(header, 136, 12, 499_162_500);
	header.write(type, 156, 1, "latin1");
	header.write("ustar\0" + "00", 257, 8, "latin1");
	octal(header, 329, 8, 0);
	octal(header, 337, 8, 0);
	checksum(header);
	return Buffer.concat([header, data, Buffer.alloc((blockSize - (data.length % blockSize)) % blockSize)]);
}

function entries() {
	return paths.map((path) => entry(`package/${path}`));
}

function archive() {
	return Buffer.concat([...entries(), endBlocks]);
}

function withHeader(change: (header: Buffer) => void, reseal = true) {
	const tar = archive();
	const header = tar.subarray(0, blockSize);
	change(header);
	if (reseal) checksum(header);
	return tar;
}

const numericFields = [
	[100, 8, "mode"],
	[108, 8, "uid"],
	[116, 8, "gid"],
	[124, 12, "size"],
	[136, 12, "mtime"],
	[148, 8, "checksum"],
	[329, 8, "device major"],
	[337, 8, "device minor"],
] as const;

function replaceNumber(start: number, length: number, value: string | Buffer) {
	return withHeader((header) => {
		header.fill(0, start, start + length);
		if (typeof value === "string") header.write(value, start, length, "latin1");
		else value.copy(header, start, 0, length);
	}, start !== 148);
}

describe("strict package tar bytes", () => {
	it("exports a parser that returns the real file bytes, sizes and modes", () => {
		const files = inspect(archive());
		expect(files.map(({ path }) => path)).toEqual(paths);
		for (const file of files) {
			expect(file.data).toEqual(Buffer.from("fixture\n"));
			expect(file.size).toBe(file.data.length);
			expect(file.mode).toBe(file.path === "bin/ink.js" ? 0o755 : 0o644);
		}
	});

	it.each([1, 511, 512, 513, 1024])(
		"reads a %i-byte body without treating body zeroes as end blocks",
		(size) => {
			const data = Buffer.alloc(size);
			const tar = Buffer.concat([entry("package/package.json", data), ...entries().slice(1), endBlocks]);
			expect(inspect(tar)[0]?.data).toEqual(data);
		},
	);

	it("allows additional whole zero blocks only after both end blocks", () => {
		expect(inspect(Buffer.concat([archive(), Buffer.alloc(3 * blockSize)]))).toHaveLength(paths.length);
	});

	it("accepts valid nonempty optional octal fields", () => {
		const tar = withHeader((header) => {
			octal(header, 108, 8, 123);
			octal(header, 116, 8, 456);
			octal(header, 329, 8, 0);
			octal(header, 337, 8, 0);
		});
		expect(inspect(tar)).toHaveLength(paths.length);
	});

	it.each(["package/.env", "package/dist/format.js", "package/package.json"])(
		"rejects an entry after a single zero block, including a duplicate: %s",
		(path) => {
			// npm can continue parsing after just one zero header. A first-zero
			// scanner would wrongly approve the earlier, completely valid files.
			const tar = Buffer.concat([...entries(), Buffer.alloc(blockSize), entry(path), endBlocks]);
			expect(() => inspect(tar)).toThrow(/Nonzero bytes after tar end marker/);
		},
	);

	it("rejects an injected entry after two end blocks as well", () => {
		expect(() => inspect(Buffer.concat([archive(), entry("package/.ink/auth.json"), endBlocks]))).toThrow(
			/Nonzero bytes after tar end marker/,
		);
	});

	it("rejects a nonzero byte anywhere in the end-block remainder", () => {
		const tar = Buffer.concat([archive(), Buffer.alloc(blockSize)]);
		tar[tar.length - 1] = 1;
		expect(() => inspect(tar)).toThrow(/Nonzero bytes after tar end marker/);
	});

	it("rejects a duplicate before the end marker", () => {
		expect(() => inspect(Buffer.concat([...entries(), entry("package/package.json"), endBlocks]))).toThrow(
			/Duplicate packed path: package.json/,
		);
	});

	it.each([
		".env",
		".env.production",
		".ink/auth.json",
		".imp/sessions/history.jsonl",
		"bin/imp.js",
		"src/cli.ts",
		"test/x.test.ts",
		"docs/design/x.md",
		"docs/zh-CN/nested/x.md",
		"scripts/package-smoke.mjs",
		"dist/.env",
		"dist/../../auth.json",
		"dist/credentials.js",
		"dist/stale-extra.js",
		"dist/config.json",
		"../auth.json",
		"/tmp/auth.json",
		"dist\\auth.js",
	])("rejects an injected disallowed or source-unknown path: %s", (path) => {
		expect(() => inspect(Buffer.concat([...entries(), entry(`package/${path}`), endBlocks]))).toThrow(
			/Unexpected packed path/,
		);
	});

	it.each(["other/package.json", "/package/package.json", "package.json"])("rejects root %s", (path) => {
		expect(() => inspect(Buffer.concat([entry(path), ...entries().slice(1), endBlocks]))).toThrow(
			/Unexpected tar root/,
		);
	});

	it.each(["1", "2", "3", "4", "5", "6", "7", "x", "g", "L", "K", "S"])(
		"rejects nonregular entry type %s, including links and extension headers",
		(type) => {
			expect(() =>
				inspect(Buffer.concat([entry("package/package.json", undefined, type), endBlocks])),
			).toThrow(/Non-regular tar entry/);
		},
	);

	it("accepts the legacy NUL regular-file type only with the strict ustar header", () => {
		const tar = withHeader((header) => {
			header[156] = 0;
		});
		expect(inspect(tar)).toHaveLength(paths.length);
	});

	it.each([157, 345, 500])("rejects link paths, prefixes and extension bytes at offset %i", (start) => {
		const tar = withHeader((header) => {
			header[start] = 65;
		});
		expect(() => inspect(tar)).toThrow(/Unexpected tar (link path|prefix or extension bytes)/);
	});

	it.each([257, 263])("rejects unsupported ustar magic/version at offset %i", (start) => {
		expect(() =>
			inspect(
				withHeader((header) => {
					header[start] = 88;
				}),
			),
		).toThrow(/Unsupported tar header format/);
	});

	it("rejects an incorrect header checksum before trusting the path or size", () => {
		const tar = withHeader((header) => {
			header[0] = 88;
		}, false);
		expect(() => inspect(tar)).toThrow(/Invalid tar header checksum/);
	});

	for (const [start, length, label] of numericFields) {
		it.each(["000008", "-1", "+1", "1\0junk", "1 2"])(
			`rejects invalid ${label} field %j even with a valid checksum`,
			(raw) => {
				expect(() => inspect(replaceNumber(start, length, raw))).toThrow(`Invalid tar ${label}`);
			},
		);

		it.each([10, 13])(`rejects a final line-ending byte %i in ${label}`, (byte) => {
			const raw = Buffer.alloc(length, 0x20);
			raw[0] = 49;
			raw[length - 1] = byte;
			expect(() => inspect(replaceNumber(start, length, raw))).toThrow(`Invalid tar ${label}`);
		});

		it(`rejects base-256 ${label} encoding rather than decoding a partial octal prefix`, () => {
			const raw = Buffer.alloc(length);
			raw[0] = 0x80;
			expect(() => inspect(replaceNumber(start, length, raw))).toThrow(`Invalid tar ${label}`);
		});
	}

	it.each([
		[100, 8, "mode"],
		[124, 12, "size"],
		[136, 12, "mtime"],
		[148, 8, "checksum"],
	] as const)(
		"rejects an empty required numeric field at offset %i (width %i, %s)",
		(start, length, label) => {
			expect(() => inspect(replaceNumber(start, length, ""))).toThrow(`Invalid tar ${label}`);
		},
	);

	it.each([0, 265, 297])("rejects invalid string bytes at offset %i", (start) => {
		expect(() =>
			inspect(
				withHeader((header) => {
					header[start] = 0xff;
				}),
			),
		).toThrow(/Invalid tar (path|owner|group)/);
	});

	it.each([0, 265, 297])("rejects a line ending immediately before a string's NUL at offset %i", (start) => {
		const tar = withHeader((header) => {
			const end = header.indexOf(0, start);
			header[end] = 10;
		});
		expect(() => inspect(tar)).toThrow(/Invalid tar (path|owner|group)/);
	});

	it.each([50, 275, 307])("rejects hidden bytes after a string's NUL terminator at offset %i", (start) => {
		expect(() =>
			inspect(
				withHeader((header) => {
					header[start] = 65;
				}),
			),
		).toThrow(/Invalid tar (path|owner|group) padding/);
	});

	it("rejects nonzero padding between the declared body and the next header", () => {
		const tar = archive();
		tar[blockSize + "fixture\n".length] = 1;
		expect(() => inspect(tar)).toThrow(/Nonzero tar file padding/);
	});

	it("rejects zero-size files rather than satisfying the required path contract", () => {
		const tar = Buffer.concat([
			entry("package/package.json", Buffer.alloc(0)),
			...entries().slice(1),
			endBlocks,
		]);
		expect(() => inspect(tar)).toThrow(/Empty\/invalid packed file/);
	});

	it.each([0o600, 0o755, 0o4755])("rejects unexpected regular-file mode %i", (mode) => {
		expect(() =>
			inspect(
				withHeader((header) => {
					octal(header, 100, 8, mode);
				}),
			),
		).toThrow(/Unexpected mode/);
	});

	it("rejects a missing required file", () => {
		expect(() => inspect(Buffer.concat([...entries().slice(0, -1), endBlocks]))).toThrow(
			/Missing packed file: dist\/cli.js/,
		);
	});

	it.each([0, 511, 513])("rejects an empty or partial stream of %i bytes", (size) => {
		expect(() => inspect(archive().subarray(0, size))).toThrow(/Truncated or unaligned tar archive/);
	});

	it("requires a second zero end block", () => {
		expect(() => inspect(archive().subarray(0, -blockSize))).toThrow(/Tar requires two zero end blocks/);
	});

	it("rejects a stream ending immediately after complete file bodies", () => {
		expect(() => inspect(Buffer.concat(entries()))).toThrow(/Missing tar end markers/);
	});

	it("rejects a partial last block, even when it is zero", () => {
		expect(() => inspect(archive().subarray(0, -1))).toThrow(/Truncated or unaligned tar archive/);
	});

	it("rejects an aligned stream whose declared body is truncated", () => {
		const tar = entry("package/package.json", Buffer.alloc(1024)).subarray(0, 1024);
		expect(() => inspect(tar)).toThrow(/Truncated tar file data or padding/);
	});

	it("rejects a huge declared size without skipping entries or end checks", () => {
		expect(() => inspect(replaceNumber(124, 12, "777777777777"))).toThrow(
			/Truncated tar file data or padding/,
		);
	});

	it("rejects a truncated body padding block", () => {
		const tar = Buffer.concat([
			entry("package/package.json", Buffer.alloc(513)).subarray(0, 512 + 513),
			endBlocks,
		]);
		expect(() => inspect(tar)).toThrow(/Truncated or unaligned tar archive/);
	});
});
