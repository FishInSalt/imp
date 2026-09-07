import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalizeDir,
	defaultTrustStorePath,
	nearestTrustEntry,
	readTrustFile,
	removeTrust,
	setTrust,
	trustRequiringResources,
	writeTrustFile,
} from "../src/core/trust.js";

let home: string;
let store: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "imp-trust-home-"));
	store = defaultTrustStorePath(home);
});

afterEach(() => {
	// tmpdir cleanup is the OS's job; nothing persists under the real ~/.imp
});

describe("trust store round-trip", () => {
	it("a missing store reads as empty", () => {
		expect(readTrustFile(store)).toEqual({});
	});

	it("setTrust records, nearestTrustEntry finds — exact directory", () => {
		setTrust(store, "/definitely/not/recorded/yet", true);
		const data = readTrustFile(store);
		expect(nearestTrustEntry(data, "/definitely/not/recorded/yet")).toEqual({
			path: "/definitely/not/recorded/yet",
			trusted: true,
		});
	});

	it("the file is sorted, tab-indented JSON with a trailing newline", () => {
		setTrust(store, "/b", true);
		setTrust(store, "/a", false);
		const raw = readFileSync(store, "utf8");
		expect(raw).toBe('{\n\t"/a": false,\n\t"/b": true\n}\n');
	});

	it("records are canonicalized through realpath — symlinked lookups hit the record", () => {
		const real = mkdtempSync(join(tmpdir(), "imp-trust-real-"));
		const link = join(home, "link");
		symlinkSync(real, link);
		setTrust(store, link, true);
		// query by the real path must find the record written via the symlink
		expect(nearestTrustEntry(readTrustFile(store), real)?.trusted).toBe(true);
		expect(canonicalizeDir(link)).toBe(canonicalizeDir(real));
	});

	it("removeTrust deletes exactly one record and reports misses", () => {
		setTrust(store, "/x", true);
		expect(removeTrust(store, "/x")).toBe(true);
		expect(readTrustFile(store)).toEqual({});
		expect(removeTrust(store, "/x")).toBe(false);
	});

	it("a malformed store is a hard teaching error, not silent reinterpretation", () => {
		mkdirSync(join(home, ".imp"), { recursive: true });
		writeFileSync(store, "{ not json", "utf8");
		expect(() => readTrustFile(store)).toThrow(/failed to read the trust store/);
		writeFileSync(store, '{"a": "yes"}', "utf8");
		expect(() => readTrustFile(store)).toThrow(/must be true or false/);
	});
});

describe("nearest-ancestor inheritance (monorepo ergonomics)", () => {
	it("a subdirectory inherits the nearest recorded ancestor", () => {
		const data = { "/repo": true, "/repo/deep": false };
		expect(nearestTrustEntry(data, "/repo/packages/a")?.trusted).toBe(true); // inherits root
		expect(nearestTrustEntry(data, "/repo/deep/src")?.trusted).toBe(false); // nearer record wins
		expect(nearestTrustEntry(data, "/elsewhere")).toBeNull();
	});
});

describe("trustRequiringResources", () => {
	it("only .imp extensions and agents count; AGENTS.md never does", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-trust-proj-"));
		expect(trustRequiringResources(dir)).toEqual([]);
		writeFileSync(join(dir, "AGENTS.md"), "# untrusted but prompt-level — not gated\n");
		expect(trustRequiringResources(dir)).toEqual([]);
		mkdirSync(join(dir, ".imp", "agents"), { recursive: true });
		expect(trustRequiringResources(dir)).toEqual([".imp/agents"]);
		mkdirSync(join(dir, ".imp", "extensions"), { recursive: true });
		expect(trustRequiringResources(dir)).toEqual([".imp/extensions", ".imp/agents"]);
	});
});
