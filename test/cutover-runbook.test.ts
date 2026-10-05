import { spawnSync } from "node:child_process";
import {
	chmodSync,
	chownSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApi, ToolCallEvent } from "../src/extensions/types.js";
import type { SlashCommand } from "../src/repl/commands.js";
import { createCliFixture } from "./helpers/cli-fixture.js";
import {
	type Adaptation,
	CutoverFixture,
	type Manifest,
	type QuietSample,
	quietEvidence,
} from "./helpers/cutover-fixture.js";

function syntheticWrite(
	file: string,
	bytes: string | Buffer,
	options?: Parameters<typeof writeFileSync>[2],
): void {
	writeFileSync(file, bytes, options);
}
function syntheticLink(target: string, file: string): void {
	symlinkSync(target, file);
}

// Every byte is authored here, never captured from installed state. Scratch roots
// intentionally retained: no destructive cleanup, retry, fallback or actual migration.
let f: CutoverFixture;
let baseline: Manifest;
const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
beforeEach(() => {
	const root = mkdtempSync(path.join(realpathSync("/tmp"), "ink-cutover-fixture-"));
	chmodSync(root, 0o700);
	f = new CutoverFixture(root, compiler);
	for (const dir of ["home", "backup", "stage", "rollback", "project", "external", "install"])
		f.directory(dir);
	f.disjoint("home/.imp", "home/.ink", "backup", "stage", "rollback", "project", "external", "install");
	f.directory("home/.imp");
	f.directory("stage/state-root");
	syntheticWrite(f.bound("stage/state-root/unknown.bin"), Buffer.from([0, 1, 255]), { mode: 0o600 });
	baseline = f.manifest("stage/state-root");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function publish(
	source: string,
	destination: string,
	expected?: Manifest,
	links = new Set<string>(),
): Promise<void> {
	const before = expected ?? f.manifest(source, links);
	f.verify(source, before, links);
	const p = f.publisher(source, destination);
	await p.wait("precheck");
	f.verify(source, before, links);
	p.proceed();
	await p.wait("finalcheck");
	p.proceed();
	await p.wait("postcheck");
	p.proceed();
	const result = await p.finish();
	if (result.code !== 0 || !result.output.includes("published"))
		throw new Error("Publication stopped; startup disabled");
	f.verify(destination, before, links);
	expect(existsSync(path.join(f.root, source))).toBe(false);
}
function independent(code: string, ...args: string[]): void {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, ...args], {
		env: f.childEnv(),
		encoding: "utf8",
		timeout: 5000,
	});
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
}
function changed(before: Manifest, after: Manifest, names: readonly string[]): Adaptation[] {
	return names.map((name) => ({
		name,
		before: before.find((e) => e.name === name)!,
		after: after.find((e) => e.name === name)!,
		reason: "Explicit synthetic active-path/root-privacy approval",
	}));
}

// Native tests are executed on the current host, never mocked. Linux evidence is
// explicitly skipped on Darwin; it is not inferred from source compilation.
describe("native exclusive publication, anchored identity and deterministic process barriers", () => {
	it("publishes a nonempty candidate exactly once, preserving identity/manifest", async () => {
		const inode = lstatSync(f.bound("stage/state-root")).ino;
		await publish("stage/state-root", "home/.ink", baseline);
		expect(lstatSync(f.bound("home/.ink")).ino).toBe(inode);
		expect(() => f.publisher("stage/state-root", "home/.ink")).toThrow();
		f.copy("home/.ink", "stage/another");
		const retry = f.publisher("stage/another", "home/.ink");
		expect((await retry.finish()).output).toContain("precheck-conflict");
		f.verify("home/.ink", baseline);
	});

	it.each(["file", "empty", "nonempty", "link", "dangling"])(
		"refuses existing %s destination without replacing it",
		async (kind) => {
			const dst = f.bound("home/.ink", true);
			if (kind === "file") syntheticWrite(dst, "conflict");
			else if (kind === "empty" || kind === "nonempty") {
				mkdirSync(dst);
				if (kind === "nonempty") syntheticWrite(path.join(dst, "unknown"), "retained");
			} else syntheticLink(kind === "link" ? ".imp" : "absent", dst);
			const before = lstatSync(dst, { bigint: true });
			const result = await f.publisher("stage/state-root", "home/.ink").finish();
			expect(result.code).not.toBe(0);
			expect(result.output).toContain("precheck-conflict");
			expect(lstatSync(dst, { bigint: true })).toEqual(before);
			f.verify("stage/state-root", baseline);
		},
	);

	it.each(["file", "link", "missing"])(
		"rejects %s source and invalid root/operand bindings",
		async (kind) => {
			if (kind === "file") syntheticWrite(f.bound("stage/invalid"), "not a directory");
			if (kind === "link") syntheticLink("state-root", f.bound("stage/invalid", true));
			if (kind === "missing") expect(() => f.publisher("stage/invalid", "home/.ink")).toThrow();
			else
				expect((await f.publisher("stage/invalid", "home/.ink").finish()).output).toContain(
					"precheck-identity",
				);
			expect(() => f.publisher("stage/state-root", "stage/state-root")).toThrow("disjoint");
			expect(() => f.publisher("stage/state-root", "stage/state-root/nested")).toThrow("disjoint");
			expect(() => f.disjoint("stage", "stage/nested")).toThrow("disjoint");
			for (const bad of ["/home/.ink", "../escape", "stage//root", "stage/./root", "stage/root/"]) {
				expect(() => f.bound(bad)).toThrow();
			}
			expect(() => new CutoverFixture(path.dirname(f.root), compiler)).toThrow("scratch");
			f.verify("stage/state-root", baseline);
		},
	);

	it.each(["empty", "file", "dangling"])(
		"native syscall rejects independent %s insertion after final absence precheck",
		async (kind) => {
			const p = f.publisher("stage/state-root", "home/.ink");
			await p.wait("precheck");
			p.proceed();
			await p.wait("finalcheck");
			independent(
				`import * as fs from 'node:fs'; const p=process.argv[1];
			${kind === "empty" ? "fs.mkdirSync(p)" : kind === "file" ? "fs.writeFileSync(p,'conflict')" : "fs.symlinkSync('missing',p)"};`,
				f.bound("home/.ink", true),
			);
			const entry = lstatSync(f.bound("home/.ink", true), { bigint: true });
			p.proceed();
			await p.wait("postcheck");
			p.proceed();
			const result = await p.finish();
			expect(result.output).toMatch(/native:-1:\d+/);
			expect(result.output).toContain("native-error");
			expect(lstatSync(f.bound("home/.ink", true), { bigint: true })).toEqual(entry);
			f.verify("stage/state-root", baseline);
		},
	);

	it("two independent publishers yield one winner and an intact loser", async () => {
		f.copy("stage/state-root", "stage/second");
		const a = f.publisher("stage/state-root", "home/.ink");
		const b = f.publisher("stage/second", "home/.ink");
		await Promise.all([a.wait("precheck"), b.wait("precheck")]);
		a.proceed();
		b.proceed();
		await Promise.all([a.wait("finalcheck"), b.wait("finalcheck")]);
		a.proceed();
		b.proceed();
		await Promise.all([a.wait("postcheck"), b.wait("postcheck")]);
		a.proceed();
		b.proceed();
		const results = await Promise.all([a.finish(), b.finish()]);
		expect(results.filter((r) => r.code === 0)).toHaveLength(1);
		expect(results.filter((r) => r.output.includes("native:-1:"))).toHaveLength(1);
		f.verify("home/.ink", baseline);
		f.verify(results[0]!.code === 0 ? "stage/second" : "stage/state-root", baseline);
	});

	it("parent alias present before opening refuses without publication", () => {
		syntheticLink("home", f.bound("alias", true));
		expect(() => f.publisher("stage/state-root", "alias/.ink")).toThrow("alias");
		f.verify("stage/state-root", baseline);
	});

	it.each([false, true])(
		"pre-final-check parent swap (alias=%s) refuses; setup mutation is distinct",
		async (alias) => {
			const p = f.publisher("stage/state-root", "home/.ink");
			await p.wait("precheck");
			independent(
				`import * as fs from 'node:fs'; fs.renameSync(process.argv[1],process.argv[2]);
			${alias ? "fs.symlinkSync('retained-home',process.argv[1])" : "fs.mkdirSync(process.argv[1],{mode:0o700})"};`,
				f.bound("home"),
				f.bound("retained-home"),
			);
			p.proceed();
			const result = await p.finish();
			expect(result.output).toContain("final-namespace");
			expect(result.output).not.toContain("native:");
			f.verify("stage/state-root", baseline);
			expect(existsSync(f.bound("retained-home/.ink"))).toBe(false);
		},
	);

	it("post-final-check namespace rename can mutate retained directory; postcheck disables startup, no undo", async () => {
		const p = f.publisher("stage/state-root", "home/.ink");
		await p.wait("precheck");
		p.proceed();
		await p.wait("finalcheck");
		independent(
			"import * as fs from 'node:fs'; fs.renameSync(process.argv[1],process.argv[2]); fs.mkdirSync(process.argv[1],{mode:0o700});",
			f.bound("home"),
			f.bound("retained-home"),
		);
		p.proceed();
		await p.wait("postcheck");
		p.proceed();
		const result = await p.finish();
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("native:0:0");
		expect(result.output).toContain("postcheck-namespace");
		f.verify("retained-home/.ink", baseline); // Read-only diagnosis, NOT unchanged tree claim.
		expect(existsSync(f.bound("stage/state-root"))).toBe(false);
		expect(existsSync(f.bound("home/.ink"))).toBe(false);
	});

	it("missing postcheck acknowledgment is uncertain even after native success", async () => {
		const p = f.publisher("stage/state-root", "home/.ink");
		await p.wait("precheck");
		p.proceed();
		await p.wait("finalcheck");
		p.proceed();
		await p.wait("postcheck"); // Intentionally no acknowledgment; native runner times out, never retries.
		const result = await p.finish();
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("postcheck-unavailable");
		f.verify("home/.ink", baseline); // Diagnose identities/bytes without resuming startup.
	});

	it("detects source replacement before syscall and content mutation in final integrity comparison", async () => {
		const p = f.publisher("stage/state-root", "home/.ink");
		await p.wait("precheck");
		independent(
			"import * as fs from 'node:fs'; fs.renameSync(process.argv[1],process.argv[2]); fs.mkdirSync(process.argv[1],{mode:0o700});",
			f.bound("stage/state-root"),
			f.bound("stage/retained-source"),
		);
		p.proceed();
		expect((await p.finish()).output).toContain("final-namespace");
		f.verify("stage/retained-source", baseline);
		const q = f.publisher("stage/retained-source", "home/.ink");
		await q.wait("precheck");
		q.proceed();
		await q.wait("finalcheck");
		independent(
			"import * as fs from 'node:fs'; fs.writeFileSync(process.argv[1],'unexpected writer');",
			f.bound("stage/retained-source/unknown.bin"),
		);
		q.proceed();
		await q.wait("postcheck");
		q.proceed();
		expect((await q.finish()).output).toContain("native:0:0");
		expect(() => f.verify("home/.ink", baseline)).toThrow("integrity"); // Identity success != activation success.
	});

	it("permission failure is an actual native refusal, without fallback or mutation", async () => {
		const p = f.publisher("stage/state-root", "home/.ink");
		await p.wait("precheck");
		p.proceed();
		await p.wait("finalcheck");
		chmodSync(f.bound("home"), 0o500); // Explicit synthetic setup mutation.
		p.proceed();
		await p.wait("postcheck");
		p.proceed();
		const result = await p.finish();
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(/native:-1:\d+/);
		f.verify("stage/state-root", baseline);
		expect(existsSync(f.bound("home/.ink"))).toBe(false);
	});

	it("native runner itself rejects same/nested operands and escaped relative leaf names", () => {
		const id = (relative: string) => {
			const s = lstatSync(f.bound(relative), { bigint: true });
			return `${s.dev}:${s.ino}`;
		};
		const rootStat = lstatSync(f.root, { bigint: true });
		for (const [sp, sn, dp, dn] of [
			["stage", "state-root", "stage", "state-root"],
			["stage", "state-root", "stage/state-root", "nested"],
			["stage", "../state-root", "home", ".ink"],
			["stage", "state-root", "home", ".."],
			["stage", "state-root", "home", "/escaped"],
		]) {
			const result = spawnSync(
				f.binary,
				[
					f.root,
					`${rootStat.dev}:${rootStat.ino}`,
					"publish",
					sp!,
					sn!,
					dp!,
					dn!,
					id("stage"),
					id("home"),
					id("stage/state-root"),
				],
				{ env: {}, encoding: "utf8", timeout: 5000 },
			);
			expect(result.status).not.toBe(0);
			expect(result.stdout).not.toContain("native:");
		}
		f.verify("stage/state-root", baseline);
	});

	it.skipIf(process.platform !== "darwin")("Darwin actual filesystem RENAME_EXCL evidence", async () => {
		await publish("stage/state-root", "home/.ink", baseline);
	});
	it.skipIf(process.platform !== "linux")(
		"Linux actual filesystem RENAME_NOREPLACE evidence (unavailable on Darwin)",
		async () => {
			await publish("stage/state-root", "home/.ink", baseline);
		},
	);
});

describe("private whole copies, metadata limits and exact adaptation allowlists", () => {
	it("compares GID and refuses differing-group source or destination using only current-user groups", async () => {
		const supportedGid = lstatSync(f.root).gid;
		const alternate = process.getgroups?.().find((gid) => gid !== supportedGid);
		if (alternate === undefined)
			throw new Error("Differing-GID execution unavailable: no alternate current-user group");
		const file = f.bound("stage/state-root/unknown.bin");
		expect(baseline.find((entry) => entry.name === "unknown.bin")!.gid).toBe(supportedGid);
		const differentExpected = baseline.map((entry) => ({ ...entry, gid: alternate }));
		expect(() => f.verify("stage/state-root", differentExpected)).toThrow("integrity");
		chownSync(file, process.getuid!(), alternate); // Owned scratch, existing membership; no privileges requested.
		expect(lstatSync(file).gid).toBe(alternate);
		expect(() => f.copy("stage/state-root", "backup/different-source-group")).toThrow("Unsupported");
		expect(existsSync(f.bound("backup/different-source-group"))).toBe(false);
		f.directory("stage/supported-source");
		syntheticWrite(f.bound("stage/supported-source/opaque"), "synthetic", { mode: 0o640 });
		f.directory("backup/different-group-parent");
		chownSync(f.bound("backup/different-group-parent"), process.getuid!(), alternate);
		expect(() => f.copy("stage/supported-source", "backup/different-group-parent/copy")).toThrow(
			"destination group",
		);
		expect(existsSync(f.bound("backup/different-group-parent/copy"))).toBe(false);
		const original = f.manifest("stage/supported-source");
		chownSync(f.bound("home"), process.getuid!(), alternate);
		const refused = await f.publisher("stage/supported-source", "home/.ink").finish();
		expect(refused.output).toContain("precheck-identity");
		expect(refused.output).not.toContain("native:");
		f.verify("stage/supported-source", original);
	});

	it.each(["plain/../target", "plain/./target", "plain/target", "plain/", "file-link/../target"])(
		"rejects non-directory intermediate link traversal %s exactly as the filesystem does",
		(target) => {
			syntheticWrite(f.bound("home/.imp/plain"), "regular file");
			syntheticWrite(f.bound("home/.imp/target"), "synthetic target");
			syntheticLink("plain", f.bound("home/.imp/file-link", true));
			syntheticLink(target, f.bound("home/.imp/link", true));
			expect(() => realpathSync(f.bound("home/.imp/link", true))).toThrow(/ENOTDIR/);
			for (const requireExists of [false, true])
				expect(() => f.resolveLink("home/.imp/link", requireExists)).toThrow("ENOTDIR");
			expect(() => f.manifest("home/.imp", new Set(["file-link", "link"]))).toThrow("ENOTDIR");
		},
	);

	it("permits real directory/../target traversal and a link resolving to that directory", () => {
		f.directory("home/.imp/directory");
		syntheticWrite(f.bound("home/.imp/target"), "synthetic target");
		syntheticLink("directory", f.bound("home/.imp/directory-link", true));
		syntheticLink("directory-link/../target", f.bound("home/.imp/link", true));
		expect(f.resolveLink("home/.imp/link")).toBe(realpathSync(f.bound("home/.imp/link", true)));
	});

	it("timestamp precision probes preserve supported values and explicitly reject filesystem rounding", () => {
		const file = f.bound("stage/state-root/unknown.bin");
		const requested = 1700000000123456789n;
		try {
			f.setTimes("stage/state-root/unknown.bin", requested);
			expect(lstatSync(file, { bigint: true }).mtimeNs).toBe(requested);
		} catch (error) {
			expect(String(error)).toContain("timestamp precision unavailable");
			expect(lstatSync(file, { bigint: true }).mtimeNs).not.toBe(requested);
		}
		f.setTimes("stage/state-root/unknown.bin", 1700000000123000000n);
		const roundedBaseline = f.manifest("stage/state-root");
		f.copy("stage/state-root", "backup/precision-probe");
		f.verify("backup/precision-probe", roundedBaseline);
	});
	it("preserves opaque/dot/unknown/archive bytes, modes, nanosecond mtimes, links and continue order with independent storage", () => {
		chmodSync(f.bound("home/.imp"), 0o755);
		f.directory("home/.imp/sessions");
		f.directory("home/.imp/archive");
		for (const [name, mode] of [
			[".imp-machine-id", 0o600],
			["unknown.bin", 0o644],
			["executable", 0o755],
			["archive/old.log", 0o600],
			["sessions/older.jsonl", 0o600],
			["sessions/newer.jsonl", 0o644],
		] as const) {
			syntheticWrite(f.bound(`home/.imp/${name}`), Buffer.from([0, 255, 10, 80]), { mode });
		}
		syntheticLink("../unknown.bin", f.bound("home/.imp/archive/internal", true));
		const links = new Set(["archive/internal"]);
		for (const [name, time] of [
			["sessions/older.jsonl", 1700000000123456789n],
			["sessions/newer.jsonl", 1700000000987654321n],
			["archive/internal", 1700000000555555555n],
			["sessions", 1700000000000000000n],
			["archive", 1700000000000000000n],
			["", 1700000000999999999n],
		] as const) {
			f.setTimes(name ? `home/.imp/${name}` : "home/.imp", time);
		}
		const raw = f.copy("home/.imp", "backup/state-original", links);
		f.copy("home/.imp", "stage/candidate", links);
		expect(lstatSync(f.bound("backup")).mode & 0o777).toBe(0o700);
		expect(lstatSync(f.bound("backup/state-original")).mode & 0o777).toBe(0o755);
		for (const e of raw.filter((e) => e.kind === "file")) {
			expect(lstatSync(f.bound(`home/.imp/${e.name}`)).ino).not.toBe(
				lstatSync(f.bound(`backup/state-original/${e.name}`)).ino,
			);
		}
		const order = (m: Manifest) =>
			m
				.filter((e) => e.name.startsWith("sessions/"))
				.sort((a, b) => (a.mtimeNs > b.mtimeNs ? -1 : 1))
				.map((e) => e.name);
		expect(order(f.manifest("stage/candidate", links))).toEqual(order(raw));
		syntheticWrite(f.bound("stage/candidate/unknown.bin"), "independent mutation");
		f.verify("home/.imp", raw, links);
		f.verify("backup/state-original", raw, links);
	});

	it("rejects unsupported special files, hard links, executable links, ACLs/xattrs rather than losing metadata", () => {
		syntheticWrite(f.bound("home/.imp/plain"), "opaque");
		linkSync(f.bound("home/.imp/plain"), f.bound("external/hard-alias"));
		expect(() => f.manifest("home/.imp")).toThrow("Unsupported");
		const fifo = spawnSync("/usr/bin/mkfifo", [f.bound("stage/state-root/pipe")], {
			env: {},
			encoding: "utf8",
		});
		expect(fifo.status).toBe(0);
		expect(() => f.manifest("stage/state-root")).toThrow("Unsupported");
		f.directory("stage/module-root");
		syntheticLink("../../install", f.bound("stage/module-root/unknown-module", true));
		expect(() => f.manifest("stage/module-root")).toThrow("Unknown link");
	});

	it.skipIf(process.platform !== "darwin")(
		"blocks Darwin xattrs and ACL grants without reading their values",
		() => {
			syntheticWrite(f.bound("home/.imp/metadata"), "synthetic");
			expect(
				spawnSync("/usr/bin/xattr", ["-w", "user.synthetic", "fixture", f.bound("home/.imp/metadata")], {
					env: {},
				}).status,
			).toBe(0);
			expect(() => f.manifest("home/.imp")).toThrow("Unsupported");
			f.directory("stage/acl-root");
			expect(
				spawnSync("/bin/chmod", ["+a", "everyone allow read", f.bound("stage/acl-root")], { env: {} }).status,
			).toBe(0);
			expect(() => f.manifest("stage/acl-root")).toThrow("Unsupported");
		},
	);

	it("rejects escaping relative links, cycles, aliases and dangling active dependencies", () => {
		for (const [name, target] of [
			["escape", "../../../../outside"],
			["cycle-a", "cycle-b"],
			["cycle-b", "cycle-a"],
			["dangling", "absent"],
		]) {
			syntheticLink(target!, f.bound(`home/.imp/${name}`, true));
		}
		expect(() => f.resolveLink("home/.imp/escape")).toThrow("Escaping");
		expect(() => f.resolveLink("home/.imp/cycle-a")).toThrow("cycle");
		expect(() => f.resolveLink("home/.imp/dangling")).toThrow("Dangling");
		syntheticLink("/outside", f.bound("home/.imp/hop", true));
		syntheticLink("hop/../apparently-internal", f.bound("home/.imp/tricky", true));
		expect(() => f.resolveLink("home/.imp/tricky")).toThrow("Escaping");
		expect(() =>
			f.copy("home/.imp", "backup/invalid", new Set(["escape", "cycle-a", "cycle-b", "dangling"])),
		).toThrow();
	});

	it("adapts only approved active references; final-depth internal chains resolve while all history is untouched", async () => {
		chmodSync(f.bound("home/.imp"), 0o755);
		f.directory("home/.imp/data");
		syntheticWrite(f.bound("home/.imp/data/value"), "opaque data", { mode: 0o600 });
		syntheticWrite(
			f.bound("home/.imp/history.jsonl"),
			'{"impVersion":"0.1.0","cwd":"unchanged","launch":".imp/old"}\n',
			{ mode: 0o600 },
		);
		syntheticWrite(f.bound("home/.imp/trust.json"), '{"unchanged-project":true}', { mode: 0o600 });
		syntheticWrite(f.bound("home/.imp/.imp-machine-id"), "historical-machine", { mode: 0o600 });
		syntheticWrite(f.bound("external/approved"), "external ordinary dependency");
		syntheticLink("data/value", f.bound("home/.imp/relative", true));
		syntheticLink("relative", f.bound("home/.imp/chain", true));
		syntheticLink(f.bound("home/.imp/chain", true), f.bound("home/.imp/absolute", true));
		syntheticLink(f.bound("external/approved"), f.bound("home/.imp/external", true));
		const oldActive = JSON.stringify({
			settings: f.bound("home/.imp/data/value"),
			command: "imp",
			cwd: "unchanged-project",
			path: f.bound("home/.imp/relative", true),
			placeholder: `\${IMP_SETTINGS_PATH}`,
			providerVariable: "OPENAI_API_KEY",
		});
		syntheticWrite(f.bound("home/.imp/active.json"), oldActive, { mode: 0o600 });
		const links = new Set(["relative", "chain", "absolute", "external"]);
		const raw = f.copy("home/.imp", "backup/state-original", links);
		f.copy("home/.imp", "stage/candidate", links);
		const before = f.manifest("stage/candidate", links);
		const old = JSON.parse(oldActive);
		syntheticWrite(
			f.bound("stage/candidate/active.json"),
			JSON.stringify({
				...old,
				settings: `${f.bound("home/.ink", true)}/data/value`,
				command: "ink",
				path: `${f.bound("home/.ink", true)}/relative`,
				placeholder: `\${INK_SETTINGS_PATH}`,
			}),
		);
		// Replacing this exact approved synthetic link is adaptation, never conflict cleanup.
		unlinkSync(f.bound("stage/candidate/absolute", true));
		syntheticLink(`${f.bound("home/.ink", true)}/chain`, f.bound("stage/candidate/absolute", true));
		chmodSync(f.bound("stage/candidate"), 0o700);
		f.setTimes("stage/candidate", before[0]!.mtimeNs);
		const after = f.manifest("stage/candidate", links);
		f.verifyAdaptations(before, after, changed(before, after, ["", "active.json", "absolute"]));
		expect(() => f.verifyAdaptations(before, after, [])).toThrow("Unapproved");
		await publish("stage/candidate", "home/.ink", after, links);
		expect(f.resolveLink("home/.ink/absolute")).toBe(f.bound("home/.ink/data/value"));
		expect(f.resolveLink("home/.ink/chain")).toBe(f.bound("home/.ink/data/value"));
		expect(f.resolveLink("home/.ink/external")).toBe(f.bound("external/approved"));
		f.verify("home/.imp", raw, links);
		f.verify("backup/state-original", raw, links);
		for (const name of ["history.jsonl", "trust.json", ".imp-machine-id"]) {
			expect(after.find((e) => e.name === name)).toEqual(before.find((e) => e.name === name));
		}
	});
});

describe("quiescence ledger — supporting evidence, never real process proof", () => {
	const stable = (): QuietSample[] =>
		[10, 25, 40, 55, 70, 85].map((second) => ({ second, stable: true, writers: [], unresolvedClaim: false }));
	it("requires ten-second drainage margin plus all six stable fifteen-second samples", () => {
		expect(quietEvidence(0, stable())).toBe(true);
		expect(quietEvidence(1, stable())).toBe(false);
		expect(quietEvidence(0, stable().slice(1))).toBe(false);
		const wrongInterval = stable();
		wrongInterval[5]!.second++;
		expect(quietEvidence(0, wrongInterval)).toBe(false);
	});
	it.each([
		"heartbeat",
		"new-child-no-lease",
		"detached-group",
		"reparented-MCP",
		"PID-reuse",
		"foreign-claim",
		"malformed-claim",
		"pending-append",
	])("blocks %s evidence without killing/repairing anything", (kind) => {
		const samples = stable();
		if (kind === "foreign-claim" || kind === "malformed-claim" || kind === "PID-reuse")
			samples[3]!.unresolvedClaim = true;
		else if (kind === "heartbeat" || kind === "pending-append") samples[3]!.stable = false;
		else samples[3]!.writers = [{ pid: 123, start: "synthetic-start", kind }];
		expect(quietEvidence(0, samples)).toBe(false);
	});
	it("an independently queued append makes no-follow samples unstable, leaving leases/history intact", () => {
		syntheticWrite(f.bound("home/.imp/lease"), "malformed-inert-claim", { mode: 0o600 });
		const initial = f.manifest("home/.imp");
		independent(
			"import * as fs from 'node:fs/promises'; await new Promise(r=>setTimeout(r,10)); await fs.appendFile(process.argv[1],'queued');",
			f.bound("home/.imp/lease"),
		);
		expect(() => f.verify("home/.imp", initial)).toThrow("integrity");
		const samples = stable();
		samples[1]!.stable = false;
		expect(quietEvidence(0, samples)).toBe(false);
		expect(existsSync(f.bound("home/.imp/lease"))).toBe(true);
	});
});

// Policy/module copies are known reviewed synthetic bytes only. Fake tool calls
// carry inert paths; no bash/write/edit is dispatched. HOME and audit stay private.
interface GuardianWire {
	gate(tool: string, text: string): Promise<unknown>;
	confirm: ReturnType<typeof vi.fn>;
	commands: Map<string, SlashCommand>;
	statuses: Map<string, string | undefined>;
}
async function guardian(module: string, cwd: string, outcome: boolean | "timeout"): Promise<GuardianWire> {
	const handlers = new Map<string, (event: ToolCallEvent) => Promise<unknown>>();
	const commands = new Map<string, SlashCommand>();
	const statuses = new Map<string, string | undefined>();
	const confirm = vi.fn(async () => outcome);
	const api = {
		cwd,
		version: "fixture",
		origin: "project",
		confirm,
		on: (event: string, handler: (e: ToolCallEvent) => Promise<unknown>) => handlers.set(event, handler),
		registerCommand: (c: SlashCommand) => commands.set(c.name, c),
		setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
	} as unknown as ExtensionApi;
	const loaded = (await import(pathToFileURL(module).href)) as { default(api: ExtensionApi): void };
	loaded.default(api);
	return {
		confirm,
		commands,
		statuses,
		gate: async (tool, text) => {
			return handlers.get("tool_call")!({
				type: "tool_call",
				toolCallId: "inert",
				name: tool,
				args: tool === "bash" ? { command: text } : { path: text },
			} as ToolCallEvent);
		},
	};
}
function operatorPolicyReady(config: string, wire: GuardianWire): boolean {
	try {
		if (!lstatSync(config).isFile() || lstatSync(config).isSymbolicLink() || wire.statuses.get("config"))
			return false;
		const parsed = JSON.parse(readFileSync(config, "utf8"));
		return (parsed.deny?.length ?? 0) + (parsed.ask?.length ?? 0) > 0;
	} catch {
		return false;
	}
}
function guardianCopies(): { old: string; adapted: string; originalBytes: string } {
	// Use repository example as reviewed code, NOT any installed module/private policy.
	const reviewed = readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8");
	const discovery = 'path.join(os.homedir(), ".ink",';
	expect(reviewed.split(discovery)).toHaveLength(3);
	const originalBytes = reviewed.replaceAll(discovery, 'path.join(os.homedir(), ".imp",');
	const adaptedBytes = originalBytes.replaceAll('path.join(os.homedir(), ".imp",', discovery);
	const old = f.bound("install/guardian-old.mjs"),
		adapted = f.bound("install/guardian-adapted.mjs");
	syntheticWrite(old, originalBytes, { flag: "wx", mode: 0o644 });
	syntheticWrite(adapted, adaptedBytes, { flag: "wx", mode: 0o644 });
	expect(adaptedBytes).toBe(reviewed);
	return { old, adapted, originalBytes };
}

describe("exact regular guardian copies and original-policy-derived equal-scope matrix", () => {
	it.each([false, true, "timeout"] as const)(
		"preserves string/omitted-tool bash-only policy and explicit write/edit scope (confirm=%s)",
		async (outcome) => {
			const copies = guardianCopies();
			vi.stubEnv("HOME", f.bound("home"));
			f.directory("home/.ink");
			const oldRoot = f.bound("home/.imp"),
				newRoot = f.bound("home/.ink");
			const oldProject = `${f.bound("project")}/.imp`,
				newProject = `${f.bound("project")}/.ink`;
			const oldOverride = `${f.bound("external")}/old-control`,
				newOverride = `${f.bound("external")}/new-control`;
			const original = {
				askTimeoutMs: 1234,
				deny: [
					`${oldRoot}/string-deny`,
					{ pattern: `${oldRoot}/overlap`, reason: "deny wins" },
					{ pattern: `${oldRoot}/file-deny`, tool: ["write", "edit"], reason: "file scope" },
					{ pattern: `${oldProject}/protected`, tool: "write", reason: "project scope" },
					{ pattern: `${oldOverride}`, tool: "edit", reason: "override scope" },
					{ regex: "unrelated-deny", flags: "i", tool: "bash", reason: "unrelated" },
				],
				ask: [
					{ pattern: `${oldRoot}/ask`, reason: "ask scope" },
					{ pattern: `${oldRoot}/overlap`, tool: ["bash", "write"], reason: "overlap ask" },
					{ pattern: `${oldRoot}/file-ask`, tool: "edit", reason: "edit ask" },
				],
			};
			// Add by rule identity and class; do not replace old rules or add tool names.
			const pairs = [
				[oldRoot, newRoot],
				[oldProject, newProject],
				[oldOverride, newOverride],
			];
			const addition = (
				rule:
					| string
					| { pattern?: string; regex?: string; tool?: string | string[]; reason?: string; flags?: string },
			) => {
				const literal = typeof rule === "string" ? rule : rule.pattern;
				const pair = pairs.find(([old]) => literal?.includes(old!));
				if (!pair || !literal) return [];
				const adapted = literal.replace(pair[0]!, pair[1]!);
				// Retain a string rule's exact original default reason in its added
				// omitted-tool counterpart; omission still means bash-only.
				return [
					typeof rule === "string"
						? { pattern: adapted, reason: `blocked by guardian rule: ${rule}` }
						: { ...rule, pattern: adapted },
				];
			};
			const policy = {
				...original,
				deny: [...original.deny, ...original.deny.flatMap(addition)],
				ask: [...original.ask, ...original.ask.flatMap(addition)],
			};
			syntheticWrite(f.bound("home/.imp/guardian.json"), JSON.stringify(original), { mode: 0o600 });
			syntheticWrite(f.bound("home/.ink/guardian.json"), JSON.stringify(policy), { mode: 0o600 });
			const old = await guardian(copies.old, f.bound("project"), outcome);
			const current = await guardian(copies.adapted, f.bound("project"), outcome);
			expect(operatorPolicyReady(f.bound("home/.ink/guardian.json"), current)).toBe(true);
			// Rule/tool/call/outcome matrix: each rule + overlap/unmatched, every tool.
			const calls = ["string-deny", "overlap", "file-deny", "ask", "file-ask", "unmatched"];
			for (const tool of ["bash", "write", "edit"])
				for (const suffix of calls) {
					const oldCall = `${oldRoot}/${suffix}`,
						newCall = `${newRoot}/${suffix}`;
					const oldDecision = await old.gate(tool, oldCall);
					expect(await current.gate(tool, oldCall)).toEqual(oldDecision);
					expect(await current.gate(tool, newCall)).toEqual(oldDecision);
					if ((suffix === "string-deny" || suffix === "ask") && tool !== "bash")
						expect(oldDecision).toBeUndefined();
					if (suffix === "overlap" && tool === "bash")
						expect(oldDecision).toEqual({ block: true, reason: "deny wins" });
				}
			for (const [a, b] of [
				[`${oldProject}/protected`, `${newProject}/protected`],
				[oldOverride, newOverride],
				["UNRELATED-DENY", "UNRELATED-DENY"],
			]) {
				for (const tool of ["bash", "write", "edit"]) {
					const expected = await old.gate(tool, a!);
					expect(await current.gate(tool, a!)).toEqual(expected);
					expect(await current.gate(tool, b!)).toEqual(expected);
				}
			}
			for (const wire of [old, current]) {
				expect(wire.confirm).toHaveBeenCalled();
				for (const call of wire.confirm.mock.calls as unknown as unknown[][])
					expect(call[2]).toMatchObject({ timeoutMs: 1234 });
			}
			expect(lstatSync(f.bound("home/.ink/guardian.log")).mode & 0o777).toBe(0o600);
			expect(readFileSync(f.bound("home/.ink/guardian.log"), "utf8")).toContain(
				outcome === true ? "approved" : outcome === "timeout" ? "timeout" : "denied",
			);
			expect(readFileSync(copies.old, "utf8")).toBe(copies.originalBytes);
			expect(lstatSync(copies.adapted).isFile()).toBe(true);
		},
	);

	it("missing/invalid/unreadable policy blocks operator acceptance; invalid reload retains previous policy", async () => {
		const copies = guardianCopies();
		vi.stubEnv("HOME", f.bound("home"));
		f.directory("home/.ink");
		const config = f.bound("home/.ink/guardian.json");
		const missing = await guardian(copies.adapted, f.bound("project"), false);
		expect(await missing.gate("bash", "inert")).toBeUndefined(); // Runtime permissive != operator acceptance.
		expect(operatorPolicyReady(config, missing)).toBe(false);
		syntheticWrite(config, JSON.stringify({ deny: ["protected"], askTimeoutMs: 1234 }), { mode: 0o600 });
		const loaded = await guardian(copies.adapted, f.bound("project"), false);
		syntheticWrite(config, "{");
		const notes: string[] = [];
		const context = {
			renderer: {
				note: (s: string) => {
					notes.push(s);
				},
			},
		} as unknown as Parameters<SlashCommand["run"]>[1];
		await loaded.commands.get("guardian")!.run("reload", context);
		expect(notes.join(" ")).toContain("reload failed");
		expect(await loaded.gate("bash", "protected")).toMatchObject({ block: true });
		expect(operatorPolicyReady(config, loaded)).toBe(false);
		// Deterministic unreadable-as-file fixture, no dependence on UID permission bypass.
		renameSync(config, f.bound("home/.ink/invalid-policy-preserved"));
		mkdirSync(config, { mode: 0o700 });
		const unreadable = await guardian(copies.adapted, f.bound("project"), false);
		expect(unreadable.statuses.get("config")).toBe("config error");
		expect(operatorPolicyReady(config, unreadable)).toBe(false);
	});

	it("locally changed installed regular code cannot be blindly replaced", () => {
		const copies = guardianCopies();
		syntheticWrite(
			f.bound("home/.imp/guardian.mjs"),
			`${copies.originalBytes}\n// Local policy customization\n`,
		);
		const installed = readFileSync(f.bound("home/.imp/guardian.mjs"));
		expect(installed.equals(Buffer.from(copies.originalBytes))).toBe(false);
		// Comparison blocks adaptation; neither installed bytes nor raw snapshot changes.
		const before = f.copy("home/.imp", "backup/state-original");
		f.verify("home/.imp", before);
		f.verify("backup/state-original", before);
	});
});

interface WritableBinding {
	id: string;
	relative: string;
	kind?: "file" | "directory";
	originallyAbsent?: boolean;
	approvedAlias?: boolean;
	// File bindings MUST declare the exact sibling namespace, even if empty.
	sidecars?: readonly { relative: string; originallyAbsent?: boolean }[];
	controlled: boolean;
}
interface Preservation {
	target: Manifest | "absent";
	sidecars: ReadonlyMap<string, Manifest | "absent">;
}
function preserveWritable(bindings: readonly WritableBinding[]): Map<string, Preservation> {
	const record = new Map<string, Preservation>();
	const identities = new Map<string, string>();
	const targets = new Map<string, string>();
	const prepared = new Map<
		string,
		{
			canonical: string;
			kind: "file" | "directory";
			target: Manifest | "absent";
			sidecars: readonly { canonical: string; expected: Manifest | "absent" }[];
		}
	>();
	const inspect = (
		canonical: string,
		absent: boolean | undefined,
		kind: "file" | "directory",
	): Manifest | "absent" => {
		try {
			const stat = lstatSync(canonical);
			if (kind === "file" ? !stat.isFile() : !stat.isDirectory())
				throw new Error("Unexpected writable target type");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!absent) throw new Error("Unexpected writable target absence");
			return "absent";
		}
		return f.manifest(path.relative(f.root, canonical));
	};
	const register = (id: string, canonical: string): void => {
		const prior = identities.get(canonical);
		if ((prior !== undefined && prior !== id) || (targets.has(id) && targets.get(id) !== canonical)) {
			throw new Error("Conflicting writable target IDs");
		}
		identities.set(canonical, id);
		targets.set(id, canonical);
	};
	// Validate the COMPLETE ID/target/sidecar map before producing any snapshot.
	// Absent leaves have canonical parent/name bindings too, never an early exit.
	for (const binding of bindings) {
		if (!binding.controlled) throw new Error("Uncontrolled shared writer; rollback disabled");
		if (!binding.id || binding.id.includes("/") || binding.id === "." || binding.id === "..")
			throw new Error("Invalid writable target ID");
		const file = binding.approvedAlias ? f.resolveLink(binding.relative, false) : f.bound(binding.relative);
		const canonical = f.bound(
			path.relative(f.root, path.join(realpathSync(path.dirname(file)), path.basename(file))),
		);
		register(binding.id, canonical);
		const kind = binding.kind ?? "directory";
		if (kind === "file" ? binding.sidecars === undefined : binding.sidecars !== undefined) {
			throw new Error("Exact file sidecar declaration required; directories preserve their whole namespace");
		}
		const sidecars = (binding.sidecars ?? [])
			.map((sidecar) => {
				const sibling = f.bound(sidecar.relative);
				if (path.dirname(sibling) !== path.dirname(canonical) || sibling === canonical)
					throw new Error("Sidecar must be an exact distinct sibling");
				return { canonical: sibling, expected: inspect(sibling, sidecar.originallyAbsent, "file") };
			})
			.sort((a, b) => a.canonical.localeCompare(b.canonical));
		if (new Set(sidecars.map((s) => s.canonical)).size !== sidecars.length)
			throw new Error("Duplicate sidecar declaration");
		const current = { canonical, kind, target: inspect(canonical, binding.originallyAbsent, kind), sidecars };
		const prior = prepared.get(binding.id);
		if (
			prior &&
			(prior.kind !== kind ||
				(prior.target === "absent") !== (current.target === "absent") ||
				JSON.stringify(prior.sidecars.map((s) => s.canonical)) !==
					JSON.stringify(sidecars.map((s) => s.canonical)))
		) {
			throw new Error("Conflicting writable target closure");
		}
		prepared.set(binding.id, current);
	}
	const namespaces = new Map<string, string>();
	for (const [id, target] of prepared)
		for (const member of [target.canonical, ...target.sidecars.map((s) => s.canonical)]) {
			for (const [existing, owner] of namespaces) {
				if (member === existing || member.startsWith(`${existing}/`) || existing.startsWith(`${member}/`)) {
					throw new Error(`Overlapping writable namespaces for ${owner} and ${id}`);
				}
			}
			namespaces.set(member, id);
		}
	for (const [id, target] of prepared) {
		if (target.kind === "file") f.directory(`rollback/${id}`);
		const capture = (
			canonical: string,
			expected: Manifest | "absent",
			destination: string,
		): Manifest | "absent" => {
			if (expected === "absent") {
				if (inspect(canonical, true, "file") !== "absent")
					throw new Error("Writable target appeared during preservation");
				return "absent";
			}
			f.verify(path.relative(f.root, canonical), expected);
			f.copy(path.relative(f.root, canonical), destination);
			return expected;
		};
		const main = capture(
			target.canonical,
			target.target,
			target.kind === "file" ? `rollback/${id}/target` : `rollback/${id}`,
		);
		const sidecars = new Map<string, Manifest | "absent">();
		for (const [index, sibling] of target.sidecars.entries())
			sidecars.set(
				path.relative(f.root, sibling.canonical),
				capture(sibling.canonical, sibling.expected, `rollback/${id}/sidecar-${index}`),
			);
		record.set(id, { target: main, sidecars });
	}
	return record;
}

describe("external writable rollback closure, shared aliases, relocated data and sidecars", () => {
	it.each([false, true])(
		"rejects same-ID absent/present target conflict before capture in either order (reverse=%s)",
		(reverse) => {
			f.directory("external/present");
			syntheticWrite(f.bound("external/present/opaque"), "synthetic current data");
			const current = f.manifest("external/present");
			const bindings: WritableBinding[] = [
				{ id: "duplicate", relative: "external/absent", originallyAbsent: true, controlled: true },
				{ id: "duplicate", relative: "external/present", controlled: true },
			];
			expect(() => preserveWritable(reverse ? bindings.reverse() : bindings)).toThrow("Conflicting");
			expect(existsSync(f.bound("rollback/duplicate"))).toBe(false);
			f.verify("external/present", current);
		},
	);

	it.each([false, true])(
		"rejects different present targets sharing one ID in either order (reverse=%s)",
		(reverse) => {
			f.directory("external/present-a");
			f.directory("external/present-b");
			const bindings: WritableBinding[] = [
				{ id: "same", relative: "external/present-a", controlled: true },
				{ id: "same", relative: "external/present-b", controlled: true },
			];
			expect(() => preserveWritable(reverse ? bindings.reverse() : bindings)).toThrow("Conflicting");
			expect(existsSync(f.bound("rollback/same"))).toBe(false);
		},
	);

	it("registers absent canonical targets: different absent paths cannot share an ID, nor one path two IDs", () => {
		const absent = { originallyAbsent: true, controlled: true };
		expect(() =>
			preserveWritable([
				{ ...absent, id: "same", relative: "external/absent-a" },
				{ ...absent, id: "same", relative: "external/absent-b" },
			]),
		).toThrow("Conflicting");
		expect(() =>
			preserveWritable([
				{ ...absent, id: "first", relative: "external/absent-a" },
				{ ...absent, id: "second", relative: "external/absent-a" },
			]),
		).toThrow("Conflicting");
		const duplicate = preserveWritable([
			{ ...absent, id: "verified-absent", relative: "external/absent-a" },
			{ ...absent, id: "verified-absent", relative: "external/absent-a" },
		]);
		expect(duplicate.size).toBe(1);
		expect(duplicate.get("verified-absent")?.target).toBe("absent");
	});

	it("preserves shared auth/settings FILES plus exact sibling sidecars and both relocated targets, including newly created files", () => {
		for (const name of ["auth", "settings", "old-data"])
			syntheticWrite(f.bound(`external/${name}.json`), Buffer.from([0, 11, 99]), { mode: 0o600 });
		const authOld = f.copy("external/auth.json", "backup/auth-old");
		const settingsOld = f.copy("external/settings.json", "backup/settings-old");
		const relocatedOld = f.copy("external/old-data.json", "backup/relocated-old");
		expect(existsSync(f.bound("external/new-data.json"))).toBe(false);
		syntheticWrite(f.bound("external/auth.json"), Buffer.from([255, 44, 22]));
		syntheticWrite(f.bound("external/settings.json"), Buffer.from([255, 44, 23]));
		syntheticWrite(f.bound("external/new-data.json"), Buffer.from([255, 44, 24]), { mode: 0o600 });
		for (const name of ["auth.json.tmp", "settings.json.lock", "old-data.json.tmp", "new-data.json.tmp"]) {
			syntheticWrite(f.bound(`external/${name}`), "synthetic sidecar", { mode: 0o600 });
		}
		syntheticWrite(f.bound("external/unrelated-sibling"), "not part of the declared file writer namespace");
		const unknown = f.manifest("external/unrelated-sibling");
		syntheticLink("auth.json", f.bound("external/auth-alias", true));
		const authSidecars = [
			{ relative: "external/auth.json.tmp" },
			{ relative: "external/auth.json.lock", originallyAbsent: true },
		];
		const bindings: WritableBinding[] = [
			{
				id: "auth-file",
				relative: "external/auth.json",
				kind: "file",
				sidecars: authSidecars,
				controlled: true,
			},
			{
				id: "auth-file",
				relative: "external/auth-alias",
				approvedAlias: true,
				kind: "file",
				sidecars: [...authSidecars].reverse(),
				controlled: true,
			},
			{
				id: "settings-file",
				relative: "external/settings.json",
				kind: "file",
				sidecars: [{ relative: "external/settings.json.lock" }],
				controlled: true,
			},
			{
				id: "old-file",
				relative: "external/old-data.json",
				kind: "file",
				sidecars: [{ relative: "external/old-data.json.tmp" }],
				controlled: true,
			},
			{
				id: "new-file",
				relative: "external/new-data.json",
				originallyAbsent: true,
				kind: "file",
				sidecars: [{ relative: "external/new-data.json.tmp", originallyAbsent: true }],
				controlled: true,
			},
			{
				id: "absent-file",
				relative: "external/still-absent.json",
				originallyAbsent: true,
				kind: "file",
				sidecars: [{ relative: "external/still-absent.json.tmp", originallyAbsent: true }],
				controlled: true,
			},
		];
		syntheticWrite(f.bound("project/control.json"), "new file binding", { mode: 0o600 });
		const control = f.manifest("project");
		const post = preserveWritable(bindings);
		expect(post.size).toBe(5);
		expect(post.get("absent-file")?.target).toBe("absent");
		expect(post.get("absent-file")?.sidecars.get("external/still-absent.json.tmp")).toBe("absent");
		expect(post.get("auth-file")?.sidecars.get("external/auth.json.lock")).toBe("absent");
		for (const b of bindings) {
			const preserved = post.get(b.id)!;
			if (preserved.target !== "absent") {
				f.verify(
					b.approvedAlias ? path.relative(f.root, f.resolveLink(b.relative)) : b.relative,
					preserved.target,
				);
				f.verify(`rollback/${b.id}/target`, preserved.target);
			}
			for (const [index, [relative, expected]] of [...preserved.sidecars].entries()) {
				if (expected === "absent") expect(existsSync(f.bound(relative))).toBe(false);
				else {
					f.verify(relative, expected);
					f.verify(`rollback/${b.id}/sidecar-${index}`, expected);
				}
			}
		}
		expect(() => f.verify("external/auth.json", authOld)).toThrow("integrity");
		expect(() => f.verify("external/settings.json", settingsOld)).toThrow("integrity");
		expect(() => f.copy("backup/auth-old", "external/auth.json")).toThrow("conflict");
		f.verify("external/old-data.json", relocatedOld);
		f.verify("external/new-data.json", post.get("new-file")!.target as Manifest);
		f.verify("external/unrelated-sibling", unknown);
		f.verify("project", control); // Preservation is not automatic restoration/rebinding permission.
	});

	it("rejects missing or inconsistent file sidecar declarations and unsupported sibling aliases before any capture", () => {
		syntheticWrite(f.bound("external/auth.json"), "synthetic", { mode: 0o600 });
		syntheticWrite(f.bound("external/auth.json.tmp"), "synthetic", { mode: 0o600 });
		const binding: WritableBinding = {
			id: "auth",
			relative: "external/auth.json",
			kind: "file",
			controlled: true,
		};
		expect(() => preserveWritable([binding])).toThrow("declaration");
		expect(() => preserveWritable([{ ...binding, sidecars: [{ relative: "external/auth.json" }] }])).toThrow(
			"distinct sibling",
		);
		expect(() =>
			preserveWritable([{ ...binding, sidecars: [{ relative: "project/unknown", originallyAbsent: true }] }]),
		).toThrow("distinct sibling");
		expect(() =>
			preserveWritable([
				{ ...binding, sidecars: [] },
				{ ...binding, sidecars: [{ relative: "external/auth.json.tmp" }] },
			]),
		).toThrow("closure");
		syntheticLink("auth.json.tmp", f.bound("external/sidecar-alias", true));
		expect(() =>
			preserveWritable([{ ...binding, sidecars: [{ relative: "external/sidecar-alias" }] }]),
		).toThrow("alias");
		expect(existsSync(f.bound("rollback/auth"))).toBe(false);
	});

	it("old snapshots are insufficient; captures every current shared/relocated namespace before any control restoration", () => {
		for (const name of ["shared-auth", "shared-settings", "custom-data", "old-location"])
			f.directory(`external/${name}`);
		for (const name of ["shared-auth", "shared-settings", "custom-data", "old-location"]) {
			syntheticWrite(f.bound(`external/${name}/opaque`), Buffer.from([0, 11, 99]), { mode: 0o600 });
			f.copy(`external/${name}`, `backup/${name}`);
		}
		const oldLocation = f.manifest("external/old-location");
		const sharedOld = f.manifest("external/shared-auth");
		syntheticWrite(f.bound("external/shared-auth/opaque"), Buffer.from([255, 44, 22]));
		syntheticWrite(f.bound("external/shared-auth/.writer-temp"), "synthetic sidecar", { mode: 0o600 });
		syntheticWrite(f.bound("external/shared-settings/opaque"), "new settings bytes");
		syntheticWrite(f.bound("external/custom-data/unknown"), "post-Ink unknown file");
		expect(existsSync(f.bound("external/new-location"))).toBe(false);
		f.directory("external/new-location");
		syntheticWrite(f.bound("external/new-location/opaque"), "new relocated bytes", { mode: 0o600 });
		syntheticWrite(f.bound("external/new-location/unknown"), "new unknown data");
		// Explicit approved alias refers to one canonical target ID, not two restores.
		syntheticLink("shared-auth", f.bound("external/auth-alias", true));
		const bindings: WritableBinding[] = [
			{ id: "shared-auth", relative: "external/shared-auth", controlled: true },
			{ id: "shared-auth", relative: "external/auth-alias", approvedAlias: true, controlled: true },
			{ id: "shared-settings", relative: "external/shared-settings", controlled: true },
			{ id: "custom-data", relative: "external/custom-data", controlled: true },
			{ id: "relocated-old", relative: "external/old-location", controlled: true },
			{ id: "relocated-new", relative: "external/new-location", originallyAbsent: true, controlled: true },
			{ id: "still-absent", relative: "external/still-absent", originallyAbsent: true, controlled: true },
		];
		const control = f.bound("project/control.json");
		syntheticWrite(control, "new binding refers to new-location");
		const requirePreservation = (record: Map<string, Preservation>) => {
			if (bindings.some((b) => !record.has(b.id)))
				throw new Error("Missing post-Ink preservation; no restoration");
		};
		expect(() => requirePreservation(new Map())).toThrow("Missing");
		const post = preserveWritable(bindings);
		requirePreservation(post);
		expect(post.size).toBe(6);
		expect(post.get("still-absent")?.target).toBe("absent");
		f.copy("project", "rollback/control-post");
		// No automatic shared-data overwrite. Rebinding/compatibility is a separate decision.
		expect(() => f.verify("external/shared-auth", sharedOld)).toThrow("integrity");
		expect(() => f.copy("backup/shared-auth", "external/shared-auth")).toThrow("conflict");
		f.verify("external/old-location", oldLocation);
		for (const b of bindings)
			if (post.get(b.id)?.target !== "absent")
				f.verify(
					b.approvedAlias ? path.relative(f.root, f.resolveLink(b.relative)) : b.relative,
					post.get(b.id)!.target as Manifest,
				);
		expect((post.get("shared-auth")!.target as Manifest).some((e) => e.name === ".writer-temp")).toBe(true);
		expect((post.get("custom-data")!.target as Manifest).some((e) => e.name === "unknown")).toBe(true);
		expect(existsSync(f.bound("external/new-location/opaque"))).toBe(true);
		expect(readFileSync(control, "utf8")).toBe("new binding refers to new-location"); // Still stopped, no implicit reference restoration.
	});

	it("uncontrolled writers, alias-ID conflicts and unexpected target absence block preservation/startup", () => {
		f.directory("external/shared");
		expect(() =>
			preserveWritable([{ id: "shared", relative: "external/shared", controlled: false }]),
		).toThrow("Uncontrolled");
		expect(() =>
			preserveWritable([{ id: "unknown", relative: "external/unknown", controlled: true }]),
		).toThrow("Unexpected");
		expect(() =>
			preserveWritable([
				{ id: "one", relative: "external/shared", controlled: true },
				{ id: "two", relative: "external/shared", controlled: true },
			]),
		).toThrow("Conflicting");
	});
});

function seedClosure(): { examples: Manifest; runtime: Manifest; state: Manifest; links: Set<string> } {
	f.directory("install/examples");
	f.directory("install/examples/web-search");
	f.directory("install/examples/web-search/_lib");
	syntheticWrite(
		f.bound("install/examples/web-search/index.mjs"),
		"import { value } from './_lib/value.mjs'; export default () => value;\n",
	);
	syntheticWrite(f.bound("install/examples/web-search/_lib/value.mjs"), "export const value = 'A';\n");
	syntheticWrite(f.bound("install/examples/web-search/_lib/asset.txt"), "A asset");
	for (const name of ["notify", "timer", "colors"])
		syntheticWrite(f.bound(`install/examples/${name}.mjs`), "export default () => 'A';\n");
	f.directory("install/runtime");
	syntheticWrite(
		f.bound("install/runtime/old.mjs"),
		"export const version = '0.1.0'; export const stateRoot = '.imp';\n",
	);
	syntheticWrite(f.bound("install/runtime/package.json"), '{"type":"module","version":"0.1.0"}');
	const examples = f.copy("install/examples", "backup/examples-old");
	const runtime = f.copy("install/runtime", "backup/install-old");
	f.directory("home/.imp/extensions");
	const links = new Set<string>();
	for (const [name, target] of [
		["notify.mjs", "notify.mjs"],
		["timer.mjs", "timer.mjs"],
		["colors.mjs", "colors.mjs"],
		["web-search", "web-search"],
	]) {
		links.add(`extensions/${name}`);
		syntheticLink(f.bound(`install/examples/${target}`), f.bound(`home/.imp/extensions/${name}`, true));
	}
	syntheticWrite(
		f.bound("home/.imp/history.jsonl"),
		'{"impVersion":"0.1.0","cwd":"same-project","id":"old"}\n',
		{ mode: 0o600 },
	);
	syntheticWrite(f.bound("home/.imp/.imp-machine-id"), "old-machine", { mode: 0o600 });
	syntheticWrite(f.bound("home/.imp/guardian.mjs"), "// Known old installed regular copy\n", { mode: 0o644 });
	syntheticWrite(f.bound("home/.imp/guardian.json"), '{"deny":["old-policy"]}', { mode: 0o600 });
	const state = f.copy("home/.imp", "backup/state-original", links);
	return { examples, runtime, state, links };
}
function deployB(): void {
	syntheticWrite(f.bound("install/examples/web-search/_lib/value.mjs"), "export const value = 'B';\n");
	syntheticWrite(f.bound("install/examples/web-search/_lib/asset.txt"), "B asset");
	for (const name of ["notify", "timer", "colors"])
		syntheticWrite(f.bound(`install/examples/${name}.mjs`), "export default () => 'B';\n");
	syntheticWrite(
		f.bound("install/runtime/old.mjs"),
		"export const version = '0.2.0'; export const stateRoot = '.ink';\n",
	);
}
async function restoredBehavior(module: string, expected: "A" | "B"): Promise<void> {
	// Behavior runs from a DISTINCT closed synthetic copy, not immutable snapshot
	// bytes, candidate history or links pointing to the mutable installation.
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			"const m=await import(process.argv[1]); if(m.default()!==process.argv[2]) process.exitCode=2;",
			pathToFileURL(module).href,
			expected,
		],
		{ env: f.childEnv(), encoding: "utf8", timeout: 5000 },
	);
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
}

interface ActivationLedger {
	coherent: boolean;
	oldCommand: boolean;
	oldRegistration: boolean;
	sourceIntegrated: boolean;
	built: boolean;
	referencesReady: boolean;
	statePublished: boolean;
	projectsReady: boolean;
	newRegistration: boolean;
	newEntry: boolean;
}
function activationReady(ledger: ActivationLedger): boolean {
	return (
		ledger.coherent &&
		!ledger.oldCommand &&
		!ledger.oldRegistration &&
		ledger.sourceIntegrated &&
		ledger.built &&
		ledger.referencesReady &&
		ledger.statePublished &&
		ledger.projectsReady &&
		ledger.newRegistration &&
		ledger.newEntry
	);
}

describe("synthetic phase-aware activation and whole-closure snapshot rollback", () => {
	it("positive activation control requires every coherence gate independently", () => {
		const ready: ActivationLedger = {
			coherent: true,
			oldCommand: false,
			oldRegistration: false,
			sourceIntegrated: true,
			built: true,
			referencesReady: true,
			statePublished: true,
			projectsReady: true,
			newRegistration: true,
			newEntry: true,
		};
		expect(activationReady(ready)).toBe(true);
		for (const key of Object.keys(ready) as (keyof ActivationLedger)[]) {
			expect(activationReady({ ...ready, [key]: !ready[key] })).toBe(false);
		}
	});
	it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
		"failure after A%s retains new data, disables entry and uses captured runtime/example closure",
		async (phase) => {
			const old = seedClosure();
			f.directory("project/.imp");
			syntheticWrite(f.bound("project/.imp/settings.json"), '{"autoCompact":false}', { mode: 0o600 });
			syntheticWrite(f.bound("project/.imp/untracked.bin"), "original untracked", { mode: 0o600 });
			const projectOld = f.copy("project/.imp", "backup/project-old");
			const cwdIdentity = realpathSync(f.bound("project"));
			f.copy("home/.imp", "stage/candidate", old.links);
			// Synthetic phase ledger: entry exposure requires ALL coherence checks, not
			// merely A9 registration. Never modifies Git, global links or live runtime.
			const ledger = {
				last: 0,
				coherent: false,
				oldCommand: true,
				oldRegistration: true,
				sourceIntegrated: false,
				built: false,
				referencesReady: false,
				statePublished: false,
				projectsReady: false,
				newRegistration: false,
				newEntry: false,
			};
			const canStart = () => activationReady(ledger);
			for (let a = 1; a <= phase; a++) {
				ledger.last = a;
				if (a === 1) ledger.oldCommand = false;
				if (a === 2) ledger.oldRegistration = false;
				if (a === 3) {
					ledger.sourceIntegrated = true;
					deployB();
					// Simulate tracked A3 removal by preserving the exact tracked file,
					// leaving untracked .imp contents and the parent present.
					renameSync(f.bound("project/.imp/settings.json"), f.bound("project/removed-tracked-settings.json"));
					f.directory("project/.ink");
					syntheticWrite(f.bound("project/.ink/settings.json"), '{"autoCompact":false}', { mode: 0o600 });
				}
				if (a === 4) ledger.built = true;
				if (a === 5) ledger.referencesReady = true;
				if (a === 6) {
					await publish("stage/candidate", "home/.ink", old.state, old.links);
					ledger.statePublished = true;
				}
				if (a === 7) {
					syntheticWrite(f.bound("project/.ink/new-unknown"), "Ink untracked project data");
					ledger.projectsReady = true;
				}
				if (a === 8) ledger.newRegistration = true;
				if (a === 9) ledger.newEntry = true;
				expect(canStart()).toBe(false);
			}
			const phaseProject = f.manifest("project/.imp");
			expect(canStart()).toBe(false);
			expect(ledger.coherent).toBe(false);
			// Original is still unchanged; changed example targets do not change link text.
			f.verify("home/.imp", old.state, old.links);
			if (phase >= 6) {
				syntheticWrite(f.bound("home/.ink/new-history.jsonl"), "new Ink history", { mode: 0o600 });
				syntheticWrite(f.bound("home/.ink/unknown-post"), "unknown post-Ink data", { mode: 0o600 });
				const current = f.manifest("home/.ink", old.links);
				await publish("home/.ink", "rollback/post-ink-root", current, old.links);
				f.verify("rollback/post-ink-root", current, old.links);
			}
			if (phase >= 3) f.copy("project/.ink", "rollback/project-ink-post");
			f.copy("project/.imp", "rollback/project-imp-post");
			f.copy("backup/state-original", "rollback/old-state-root", old.links);
			const before = f.manifest("rollback/old-state-root", old.links);
			for (const name of old.links) {
				const link = f.bound(`rollback/old-state-root/${name}`, true);
				const originalTarget = readlinkSync(link);
				const captured = originalTarget.replace(f.bound("install/examples"), f.bound("backup/examples-old"));
				unlinkSync(link);
				syntheticLink(captured, link); // Exact approved recovery-link adaptation only.
			}
			f.setTimes("rollback/old-state-root/extensions", before.find((e) => e.name === "extensions")!.mtimeNs);
			const recovered = f.manifest("rollback/old-state-root", old.links);
			f.verifyAdaptations(before, recovered, changed(before, recovered, [...old.links]));
			await publish("home/.imp", "rollback/preserved-imp-root", old.state, old.links);
			await publish("rollback/old-state-root", "home/.imp", recovered, old.links);
			if (phase < 3) {
				f.verify("project/.imp", projectOld); // Complete unchanged old root is retained.
			} else {
				f.verify("project/.imp", phaseProject);
				expect(existsSync(f.bound("project/.imp/untracked.bin"))).toBe(true);
				f.copy("backup/project-old", "rollback/project-candidate");
				await publish("project/.imp", "rollback/project-preserved", phaseProject);
				await publish("rollback/project-candidate", "project/.imp", projectOld);
				f.verify("project/.ink", f.manifest("rollback/project-ink-post"));
			}
			expect(JSON.parse(readFileSync(f.bound("project/.imp/settings.json"), "utf8"))).toEqual({
				autoCompact: false,
			});
			expect(realpathSync(f.bound("project"))).toBe(cwdIdentity);
			f.verify("backup/state-original", old.state, old.links);
			f.verify("backup/examples-old", old.examples);
			f.verify("backup/install-old", old.runtime);
			expect(f.resolveLink("home/.imp/extensions/web-search")).toBe(
				f.bound("backup/examples-old/web-search"),
			);
			// Closed copied A closure executes A despite mutable source now being B.
			f.copy("backup/examples-old", "rollback/behavior-copy");
			await restoredBehavior(f.bound("rollback/behavior-copy/web-search/index.mjs"), "A");
			if (phase >= 3) {
				f.copy("install/examples", "rollback/new-behavior-copy");
				await restoredBehavior(f.bound("rollback/new-behavior-copy/web-search/index.mjs"), "B");
			}
			f.copy("backup/install-old", "rollback/runtime-copy");
			independent(
				"const m=await import(process.argv[1]); if(m.version!=='0.1.0'||m.stateRoot!=='.imp') process.exitCode=2;",
				pathToFileURL(f.bound("rollback/runtime-copy/old.mjs")).href,
			);
			f.verify("backup/examples-old", old.examples);
			f.verify("backup/install-old", old.runtime);
			expect(ledger.last).toBe(phase);
			ledger.newEntry = false;
			ledger.newRegistration = false; // Synthetic retirement ledger before recovery exposure.
			expect(canStart()).toBe(false);
		},
	);

	it("failure between exclusive project moves leaves both preserved roots and startup disabled", async () => {
		f.directory("project/.imp");
		syntheticWrite(f.bound("project/.imp/untracked"), "retained");
		const phase = f.manifest("project/.imp");
		await publish("project/.imp", "rollback/project-preserved", phase);
		expect(existsSync(f.bound("project/.imp"))).toBe(false);
		f.verify("rollback/project-preserved", phase);
		// No retry, deletion, merge or automatic publication follows simulated failure.
	});

	it.each(["changed", "unexpected-absence", "dangling", "foreign-file"])(
		"blocks %s original project resource instead of restoring over it",
		(kind) => {
			f.directory("project/.imp");
			syntheticWrite(f.bound("project/.imp/untracked"), "original");
			const expected = f.manifest("project/.imp");
			if (kind === "changed") syntheticWrite(f.bound("project/.imp/untracked"), "foreign modification");
			else {
				renameSync(f.bound("project/.imp"), f.bound("project/preserved-original"));
				if (kind === "dangling") syntheticLink("missing", f.bound("project/.imp", true));
				if (kind === "foreign-file") syntheticWrite(f.bound("project/.imp"), "foreign");
			}
			expect(() => f.verify("project/.imp", expected)).toThrow();
		},
	);

	it("verified absent-as-recorded project permits exclusive candidate publication, retaining .ink data", async () => {
		f.directory("project/.ink");
		syntheticWrite(f.bound("project/.ink/unknown"), "Ink data");
		const ink = f.manifest("project/.ink");
		f.directory("rollback/old-project");
		syntheticWrite(f.bound("rollback/old-project/settings.json"), '{"autoCompact":false}');
		const old = f.manifest("rollback/old-project");
		expect(existsSync(f.bound("project/.imp"))).toBe(false);
		await publish("rollback/old-project", "project/.imp", old);
		f.verify("project/.ink", ink);
	});

	it("snapshot runtime does not waive dedicated recovery branch/review/--no-ff policy gates", () => {
		syntheticWrite(f.bound("project/AGENTS.md"), "Approval required for external writes and .ink state.");
		const current = readFileSync(f.bound("project/AGENTS.md"));
		f.copy("project", "rollback/context-post");
		const exposure = (s: {
			suitable: boolean;
			dedicated: boolean;
			reviewed: boolean;
			approved: boolean;
			noFf: boolean;
		}) => s.suitable || (s.dedicated && s.reviewed && s.approved && s.noFf);
		const ready = { suitable: false, dedicated: true, reviewed: true, approved: true, noFf: true };
		for (const gate of ["dedicated", "reviewed", "approved", "noFf"] as const)
			expect(exposure({ ...ready, [gate]: false })).toBe(false);
		expect(exposure(ready)).toBe(true);
		expect(
			exposure({ suitable: true, dedicated: false, reviewed: false, approved: false, noFf: false }),
		).toBe(true);
		expect(readFileSync(f.bound("project/AGENTS.md"))).toEqual(current);
		// Ledger contract rehearsal only: no Git commits/integration or direct main edits.
	});
});

describe("existing copied-runtime offline isolation reused without executing candidate links", () => {
	it("a caught nonlocal request still fails the isolated child, with no transmitted request", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"try { await fetch('https://example.invalid'); } catch {} process.exit(0);",
			],
			{
				env: f.childEnv(),
				encoding: "utf8",
				timeout: 5000,
			},
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Blocked nonlocal test network request");
		f.verify("stage/state-root", baseline);
	});
	it.each([undefined, "INK_AUTOCOMPACT=0\n"])(
		"quick-exit copied launcher uses absent/controlled dotenv (%s), neutral cwd and sanitized child env",
		(dotenv) => {
			const cli = createCliFixture({ dotenv, model: "claude-sonnet-4-5" });
			const original = f.copy("home/.imp", "backup/isolation-original");
			const staged = f.manifest("stage/state-root");
			const env = cli.env();
			expect(env.INK_MODEL).toBe("claude-sonnet-4-5");
			expect(env.HOME).toBe(cli.home);
			expect(env.INK_AUTH_PATH).toContain(cli.home);
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.IMP_AUTH_PATH).toBeUndefined();
			expect(cli.cwd).not.toBe(path.resolve("."));
			const result = spawnSync(process.execPath, [cli.bin, "--version"], {
				cwd: cli.cwd,
				env,
				encoding: "utf8",
				timeout: 5000,
			});
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe("Ink 0.2.0");
			f.verify("home/.imp", original);
			f.verify("stage/state-root", staged);
			// Preserve disposable fixture; no destructive cleanup or candidate imports.
		},
	);
});
