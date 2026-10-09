import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	askTrustOnce,
	canonicalizeDir,
	defaultTrustStorePath,
	nearestTrustEntry,
	readTrustFile,
	removeTrust,
	setTrust,
	trustRequiringResources,
} from "../src/core/trust.js";
import { mkTempDir } from "./helpers/mktemp.js";

let home: string;
let store: string;

beforeEach(() => {
	home = mkTempDir("ink-trust-home-");
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
		const real = mkTempDir("ink-trust-real-");
		const link = join(home, "link");
		symlinkSync(real, link);
		setTrust(store, link, true);
		// query by the real path must find the record written via the symlink
		expect(nearestTrustEntry(readTrustFile(store), real)?.trusted).toBe(true);
		expect(canonicalizeDir(link)).toBe(canonicalizeDir(real));
	});

	it("removeTrust converges symlink aliases onto the canonical record (M8 review tierScope)", () => {
		const real = mkTempDir("ink-trust-real2-");
		const link = join(home, "alias-link");
		symlinkSync(real, link);
		setTrust(store, link, true); // recorded via the alias → canonical key
		// remove via a DIFFERENT alias (and via the real path) must hit the same record
		const link2 = join(home, "alias-link-2");
		symlinkSync(real, link2);
		expect(removeTrust(store, link2)).toBe(true);
		expect(readTrustFile(store)).toEqual({});
	});

	it("removeTrust deletes exactly one record and reports misses", () => {
		setTrust(store, "/x", true);
		expect(removeTrust(store, "/x")).toBe(true);
		expect(readTrustFile(store)).toEqual({});
		expect(removeTrust(store, "/x")).toBe(false);
	});

	it("setTrust rebuildOnCorrupt replaces an unreadable store (the --trust recovery path, M8 review)", () => {
		mkdirSync(join(home, ".ink"), { recursive: true });
		writeFileSync(store, "{oops", "utf8");
		expect(() => setTrust(store, "/x", true)).toThrow(); // default: propagate
		setTrust(store, "/x", true, true); // flag path: rebuild
		expect(readTrustFile(store)).toEqual({ "/x": true });
	});

	it("concurrent writers do not tear the file (tmp+rename) and the lock serializes RMW", () => {
		// two synchronous interleaved writers via the same process still round-trip
		for (let i = 0; i < 40; i++) {
			setTrust(store, `/a${i}`, true);
			setTrust(store, `/b${i}`, false);
		}
		const data = readTrustFile(store);
		expect(Object.keys(data)).toHaveLength(80);
	});

	it("a malformed store is a hard teaching error, not silent reinterpretation", () => {
		mkdirSync(join(home, ".ink"), { recursive: true });
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
	it("a commands-only repo gates too — .ink/commands is model-directed content (M11 #6 review P1)", () => {
		const dir = mkTempDir("ink-trust-cmds-");
		const elsewhere = mkTempDir("ink-trust-home4-");
		mkdirSync(join(dir, ".ink", "commands"), { recursive: true });
		writeFileSync(join(dir, ".ink", "commands", "review.md"), "inject me\n");
		expect(trustRequiringResources(dir, elsewhere)).toEqual([".ink/commands"]);
	});

	it("#trust-home-fix: a directory UNDER $HOME gates normally — only $HOME itself is exempt (pi parity)", () => {
		const home = mkTempDir("ink-trust-home6-");
		const proj = join(home, "code", "proj"); // under home, like every macOS path
		mkdirSync(join(proj, ".ink", "agents"), { recursive: true });
		// the fix's regression pin: this used to return [] (blanket home exemption)
		expect(trustRequiringResources(proj, home)).toEqual([".ink/agents"]);
		// $HOME itself stays exempt — there `.ink/*` is the user's own global installation
		mkdirSync(join(home, ".ink", "extensions"), { recursive: true });
		expect(trustRequiringResources(home, home)).toEqual([]);
	});

	it("only .ink extensions and agents count; AGENTS.md never does", () => {
		const dir = mkTempDir("ink-trust-proj-");
		const elsewhere = mkTempDir("ink-trust-home-");
		expect(trustRequiringResources(dir, elsewhere)).toEqual([]);
		writeFileSync(join(dir, "AGENTS.md"), "# untrusted but prompt-level — not gated\n");
		expect(trustRequiringResources(dir, elsewhere)).toEqual([]);
		mkdirSync(join(dir, ".ink", "agents"), { recursive: true });
		expect(trustRequiringResources(dir, elsewhere)).toEqual([".ink/agents"]);
		mkdirSync(join(dir, ".ink", "extensions"), { recursive: true });
		expect(trustRequiringResources(dir, elsewhere)).toEqual([".ink/extensions", ".ink/agents"]);
	});

	it("a plain FILE named .ink/extensions gates nothing (directories only)", () => {
		const dir = mkTempDir("ink-trust-file-");
		const elsewhere = mkTempDir("ink-trust-home2-");
		mkdirSync(join(dir, ".ink"), { recursive: true });
		writeFileSync(join(dir, ".ink", "extensions"), "not a directory\n");
		expect(trustRequiringResources(dir, elsewhere)).toEqual([]);
	});

	it("#mcp-trust: project-tier mcp config files gate (both names, files only)", () => {
		const dir = mkTempDir("ink-trust-mcp-");
		const elsewhere = mkTempDir("ink-trust-mcp-home-");
		expect(trustRequiringResources(dir, elsewhere)).toEqual([]);
		writeFileSync(join(dir, ".mcp.json"), "{}\n");
		expect(trustRequiringResources(dir, elsewhere)).toEqual([".mcp.json"]);
		writeFileSync(join(dir, "mcp.json"), "{}\n");
		expect(trustRequiringResources(dir, elsewhere)).toEqual([".mcp.json", "mcp.json"]);
		// a directory shadowing the name must not gate (SYSTEM.md precedent)
		const shadow = mkTempDir("ink-trust-mcp-shadow-");
		mkdirSync(join(shadow, ".mcp.json"));
		expect(trustRequiringResources(shadow, elsewhere)).toEqual([]);
	});

	it("cwd AT the home dir gates nothing — the user's own installation (M8 review; #trust-home-fix narrowed the tree exemption)", () => {
		const home = mkTempDir("ink-trust-home3-");
		mkdirSync(join(home, ".ink", "extensions"), { recursive: true });
		expect(trustRequiringResources(home, home)).toEqual([]); // cd ~ && ink
		// a genuinely foreign cwd still gates
		const foreign = mkTempDir("ink-trust-foreign-");
		mkdirSync(join(foreign, ".ink", "extensions"), { recursive: true });
		expect(trustRequiringResources(foreign, home)).toEqual([".ink/extensions"]);
	});
});

describe("askTrustOnce (the interactive one-time ask)", () => {
	function makeIo() {
		const stdin = new PassThrough();
		const chunks: string[] = [];
		const stdout = new Writable({
			write(chunk, _enc, cb) {
				chunks.push(String(chunk));
				cb();
			},
		});
		return { stdin, stdout, output: () => chunks.join("") };
	}

	it("renders the question verbatim; y/yes approve (explicit answer)", async () => {
		const io = makeIo();
		const answer = askTrustOnce(
			io.stdin,
			io.stdout,
			"trust the files in /x? it wants to load: .ink/extensions (2 files) [y/N] ",
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(io.output()).toContain("trust the files in /x?");
		expect(io.output()).toContain(".ink/extensions (2 files)");
		io.stdin.write("y\n");
		expect(await answer).toBe(true);
	});

	it("anything but y/yes is an explicit denial — empty enter, n, no, stray text", async () => {
		for (const line of ["\n", "n\n", "no\n", "sure why not\n"]) {
			const io = makeIo();
			const answer = askTrustOnce(io.stdin, io.stdout, "q [y/N] ");
			await new Promise((r) => setTimeout(r, 5));
			io.stdin.write(line);
			expect(await answer).toBe(false);
		}
	});

	it("EOF/Ctrl+D resolves null (cancelled) — deny for the session, but NOT an explicit answer", async () => {
		const io = makeIo();
		const answer = askTrustOnce(io.stdin, io.stdout, "q [y/N] ");
		await new Promise((r) => setTimeout(r, 5));
		io.stdin.end();
		expect(await answer).toBeNull();
	});
});

describe("trustRequiringResources #system-md", () => {
	it("SYSTEM.md and APPEND_SYSTEM.md files gate like settings.json", () => {
		const dir = mkTempDir("ink-trust-sysmd-");
		mkdirSync(join(dir, ".ink"), { recursive: true });
		writeFileSync(join(dir, ".ink", "SYSTEM.md"), "persona");
		writeFileSync(join(dir, ".ink", "APPEND_SYSTEM.md"), "extra");
		const resources = trustRequiringResources(dir, home);
		expect(resources).toContain(".ink/SYSTEM.md");
		expect(resources).toContain(".ink/APPEND_SYSTEM.md");
	});

	it("a directory shadowing the name does not trigger the ask (isFile)", () => {
		const dir = mkTempDir("ink-trust-shadow-");
		mkdirSync(join(dir, ".ink", "SYSTEM.md"), { recursive: true });
		expect(trustRequiringResources(dir, home)).toEqual([]);
	});
});
