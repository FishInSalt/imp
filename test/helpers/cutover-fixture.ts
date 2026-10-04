import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { NETWORK_PRELOAD } from "./cli-fixture.js";

export interface Entry {
	name: string;
	kind: "directory" | "file" | "link";
	mode: number;
	gid: number;
	mtimeNs: bigint;
	value: string; // Private regular-byte digest or literal link text; never report it.
}
export type Manifest = readonly Entry[];
export interface Adaptation {
	name: string;
	before: Entry;
	after: Entry;
	reason: string;
}
export interface Publication {
	wait(phase: "precheck" | "finalcheck" | "postcheck"): Promise<void>;
	proceed(): void;
	finish(): Promise<{ code: number | null; output: string }>;
}

function missing(file: string): boolean {
	try {
		lstatSync(file);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}
function identity(file: string): string {
	const s = lstatSync(file, { bigint: true });
	return `${s.dev}:${s.ino}`;
}
function inside(root: string, file: string): boolean {
	return file.startsWith(`${root}/`);
}
function equal(a: unknown, b: unknown): boolean {
	return (
		JSON.stringify(a, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) ===
		JSON.stringify(b, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
	);
}

/** Explicit, newly created, private /tmp fixture ONLY. Not an operator migration API.
 * No home/env lookup; unsupported ACL/xattr/flags/topology blocks via native probe.
 * Only the fixture root's group is supported; differing GIDs block rather than
 * changing effective group permissions during copy. Manifests compare GID too.
 * Darwin OS-generated com.apple.provenance, atime, ctime, inode, birthtime,
 * durability and malicious same-user races are not copy promises.
 */
export class CutoverFixture {
	readonly root: string;
	readonly binary: string;
	private readonly rootIdentity: string;

	constructor(explicitRoot: string, compiler: string) {
		const scratch = realpathSync("/tmp");
		if (
			!path.isAbsolute(explicitRoot) ||
			path.dirname(explicitRoot) !== scratch ||
			!path.basename(explicitRoot).startsWith("ink-cutover-fixture-")
		)
			throw new Error("Explicit scratch fixture root required");
		this.root = explicitRoot;
		this.noFollow(explicitRoot, false);
		const s = lstatSync(explicitRoot);
		if (!s.isDirectory() || (s.mode & 0o777) !== 0o700 || s.uid !== process.getuid?.()) {
			throw new Error("Fixture root must be a private owned directory");
		}
		if (readdirSync(explicitRoot).length !== 0) throw new Error("Fixture root must be fresh");
		this.rootIdentity = identity(explicitRoot);
		writeFileSync(path.join(explicitRoot, "fixture.marker"), "synthetic-cutover-fixture\n", {
			flag: "wx",
			mode: 0o600,
		});
		this.binary = path.join(explicitRoot, "exclusive-directory-rename");
		if (!path.isAbsolute(compiler)) throw new Error("Explicit existing native compiler required");
		const result = spawnSync(
			compiler,
			[
				"-std=c11",
				"-Wall",
				"-Wextra",
				"-Werror",
				"-O2",
				path.join(import.meta.dirname, "exclusive-directory-rename.c"),
				"-o",
				this.binary,
			],
			{ env: { PATH: "/usr/bin:/bin", TMPDIR: explicitRoot }, encoding: "utf8" },
		);
		if (result.status !== 0) throw new Error(`Native compiler unavailable/failure: ${result.stderr}`);
		const probe = spawnSync(this.binary, [this.root, this.rootIdentity, "metadata", "fixture.marker"], {
			env: {},
			encoding: "utf8",
		});
		if (probe.status !== 0) throw new Error("Unsupported fixture root/marker metadata");
	}

	private noFollow(file: string, absentLeaf: boolean): void {
		const parts = file.split("/").filter(Boolean);
		let current = "/";
		for (let i = 0; i < parts.length; i++) {
			current = path.join(current, parts[i]!);
			if (absentLeaf && i === parts.length - 1 && missing(current)) return;
			if (lstatSync(current).isSymbolicLink()) throw new Error("Unexpected path alias");
		}
	}

	bound(relative: string, allowFinalLink = false): string {
		if (
			!relative ||
			path.isAbsolute(relative) ||
			relative.split("/").some((p) => !p || p === "." || p === "..")
		) {
			throw new Error("Invalid fixture-relative path");
		}
		this.noFollow(this.root, false);
		if (identity(this.root) !== this.rootIdentity) throw new Error("Fixture namespace changed");
		const file = path.join(this.root, relative);
		this.noFollow(allowFinalLink ? path.dirname(file) : file, true);
		return file;
	}

	directory(relative: string): string {
		const file = this.bound(relative);
		if (!missing(file)) throw new Error("Existing enclosure conflict");
		mkdirSync(file, { mode: 0o700 });
		this.native("metadata", relative);
		return file;
	}

	disjoint(...names: string[]): void {
		const files = names.map((name) => this.bound(name, true));
		for (let i = 0; i < files.length; i++)
			for (let j = i + 1; j < files.length; j++) {
				const a = files[i]!,
					b = files[j]!;
				if (
					a === b ||
					inside(a, b) ||
					inside(b, a) ||
					(!missing(a) && !missing(b) && identity(a) === identity(b))
				) {
					throw new Error("Fixture roots must be disjoint");
				}
			}
	}

	private native(operation: "metadata" | "times", relative: string, ...extra: string[]): void {
		const result = spawnSync(this.binary, [this.root, this.rootIdentity, operation, relative, ...extra], {
			env: {},
			encoding: "utf8",
			timeout: 5000,
		});
		if (result.status !== 0) throw new Error(`Unsupported fixture metadata/path: ${result.stdout.trim()}`);
	}

	setTimes(relative: string, mtimeNs: bigint): void {
		this.bound(relative, true);
		this.native("times", relative, mtimeNs.toString(), mtimeNs.toString());
		if (lstatSync(this.bound(relative, true), { bigint: true }).mtimeNs !== mtimeNs) {
			throw new Error("Filesystem timestamp precision unavailable");
		}
	}

	/** Resolve approved links component-by-component, without ever reading their targets. */
	resolveLink(relative: string, requireExists = true): string {
		const initial = this.bound(relative, true);
		let pending = path.relative(this.root, initial).split("/");
		let resolved = this.root;
		const seen = new Set<string>();
		while (pending.length) {
			// Every remaining component (including '.', '..', or a trailing
			// slash) requires directory traversal, just as the filesystem does.
			if (!lstatSync(resolved).isDirectory()) throw new Error("Non-directory link traversal (ENOTDIR)");
			const component = pending.shift()!;
			if (!component || component === ".") continue;
			const next = component === ".." ? path.dirname(resolved) : path.join(resolved, component);
			if (next !== this.root && !inside(this.root, next)) throw new Error("Escaping link target");
			if (missing(next)) {
				if (requireExists) throw new Error("Dangling active dependency");
				if (pending.some((part) => !part || part === "." || part === "..")) {
					throw new Error("Dangling intermediate directory traversal");
				}
				const eventual = path.resolve(next, ...pending);
				if (!inside(this.root, eventual)) throw new Error("Escaping link target");
				return eventual;
			}
			const s = lstatSync(next);
			if (s.isSymbolicLink()) {
				if (seen.has(next)) throw new Error("Link cycle");
				seen.add(next);
				const text = readlinkSync(next);
				// Never collapse '..' across an unchecked link: a/../b can escape
				// if a is itself a link, despite a lexically harmless normalized path.
				if (path.isAbsolute(text)) {
					if (!inside(this.root, text)) throw new Error("Escaping link target");
					pending = [...text.slice(this.root.length + 1).split("/"), ...pending];
					resolved = this.root;
				} else {
					pending = [...text.split("/"), ...pending];
					resolved = path.dirname(next);
				}
			} else resolved = next;
		}
		return resolved;
	}

	manifest(relative: string, approvedLinks: ReadonlySet<string> = new Set()): Manifest {
		const base = this.bound(relative);
		const source = lstatSync(base);
		if (!source.isDirectory() && !source.isFile()) throw new Error("Real source file or directory required");
		const entries: Entry[] = [];
		const walk = (name: string): void => {
			const rel = name ? `${relative}/${name}` : relative;
			const file = this.bound(rel, true);
			const before = lstatSync(file, { bigint: true });
			this.native("metadata", rel);
			let kind: Entry["kind"],
				value = "";
			if (before.isSymbolicLink()) {
				if (!approvedLinks.has(name)) throw new Error("Unknown link/executable dependency");
				this.resolveLink(rel, false);
				kind = "link";
				value = readlinkSync(file);
			} else if (before.isFile()) {
				kind = "file";
				const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					const opened = fstatSync(fd, { bigint: true });
					if (opened.dev !== before.dev || opened.ino !== before.ino)
						throw new Error("Source identity changed");
					value = createHash("sha256").update(readFileSync(fd)).digest("hex");
				} finally {
					closeSync(fd);
				}
			} else kind = "directory";
			const after = lstatSync(file, { bigint: true });
			if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
				throw new Error("Source changed during manifest");
			}
			entries.push({
				name,
				kind,
				mode: Number(before.mode & 0o777n),
				gid: Number(before.gid),
				mtimeNs: before.mtimeNs,
				value,
			});
			if (kind === "directory") {
				for (const child of readdirSync(file).sort()) walk(name ? `${name}/${child}` : child);
				const final = lstatSync(file, { bigint: true });
				if (
					final.ino !== before.ino ||
					final.mtimeNs !== before.mtimeNs ||
					final.ctimeNs !== before.ctimeNs
				) {
					throw new Error("Directory changed during manifest");
				}
			}
		};
		walk("");
		return entries;
	}

	verify(relative: string, expected: Manifest, links: ReadonlySet<string> = new Set()): void {
		if (!equal(this.manifest(relative, links), expected)) throw new Error("Fixture integrity mismatch");
	}

	copy(source: string, destination: string, links: ReadonlySet<string> = new Set()): Manifest {
		this.disjoint(source, destination);
		const before = this.manifest(source, links);
		const dest = this.bound(destination, true);
		if (!missing(dest)) throw new Error("Copy destination conflict");
		const parent = lstatSync(path.dirname(dest));
		if (!parent.isDirectory() || parent.gid !== lstatSync(this.root).gid) {
			throw new Error("Unsupported destination group ownership");
		}
		for (const entry of before) {
			const rel = entry.name ? `${destination}/${entry.name}` : destination;
			const target = this.bound(rel, true);
			if (entry.kind === "directory") mkdirSync(target, { mode: entry.mode });
			else if (entry.kind === "link") symlinkSync(entry.value, target);
			else {
				const input = openSync(
					this.bound(entry.name ? `${source}/${entry.name}` : source),
					constants.O_RDONLY | constants.O_NOFOLLOW,
				);
				try {
					writeFileSync(target, readFileSync(input), { flag: "wx", mode: entry.mode });
				} finally {
					closeSync(input);
				}
			}
			if (entry.kind !== "link") chmodSync(target, entry.mode);
		}
		for (const entry of [...before].reverse())
			this.setTimes(entry.name ? `${destination}/${entry.name}` : destination, entry.mtimeNs);
		this.verify(source, before, links);
		this.verify(destination, before, links);
		return before;
	}

	verifyAdaptations(before: Manifest, after: Manifest, approved: readonly Adaptation[]): void {
		const changes = new Map(approved.map((a) => [a.name, a]));
		if (changes.size !== approved.length || before.length !== after.length)
			throw new Error("Invalid adaptation allowlist");
		for (let i = 0; i < before.length; i++) {
			const a = before[i]!,
				b = after[i]!;
			const change = changes.get(a.name);
			if (
				a.name !== b.name ||
				(!equal(a, b) && (!change?.reason || !equal(change.before, a) || !equal(change.after, b)))
			) {
				throw new Error("Unapproved adaptation");
			}
			if (change && (equal(a, b) || !equal(change.before, a) || !equal(change.after, b)))
				throw new Error("Invalid adaptation exception");
			changes.delete(a.name);
		}
		if (changes.size) throw new Error("Unknown adaptation path");
	}

	/** One attempt, native barriers, no automated retry/recovery or conflict removal.
	 * Full byte verification must additionally pass before startup is enabled.
	 */
	publisher(source: string, destination: string): Publication {
		this.disjoint(source, destination);
		const src = this.bound(source, true),
			dst = this.bound(destination, true);
		const sp = path.dirname(src),
			dp = path.dirname(dst);
		const args = [
			this.root,
			this.rootIdentity,
			"publish",
			path.relative(this.root, sp) || ".",
			path.basename(src),
			path.relative(this.root, dp) || ".",
			path.basename(dst),
			identity(sp),
			identity(dp),
			identity(src),
		];
		const child: ChildProcessWithoutNullStreams = spawn(this.binary, args, { env: {}, stdio: "pipe" });
		child.stderr.resume();
		child.stdin.on("error", () => {}); // Native refusal can close the barrier pipe.
		let output = "";
		const waiters = new Set<() => void>();
		let closed = false;
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			for (const wake of waiters) wake();
		});
		const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => {
				closed = true;
				for (const wake of waiters) wake();
				resolve({ code, output });
			});
		});
		return {
			wait: (phase) =>
				new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						waiters.delete(check);
						reject(new Error("Fixture barrier timeout"));
					}, 6000);
					const check = () => {
						if (output.split("\n").includes(phase) || closed) {
							clearTimeout(timer);
							waiters.delete(check);
							if (output.split("\n").includes(phase)) resolve();
							else reject(new Error(`Publication stopped before ${phase}: ${output}`));
						}
					};
					waiters.add(check);
					check();
				}),
			proceed: () => child.stdin.write("P"),
			finish: () => done,
		};
	}

	childEnv(): NodeJS.ProcessEnv {
		return {
			PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
			HOME: this.root,
			TMPDIR: this.root,
			NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
		};
	}
}

export interface QuietSample {
	second: number;
	stable: boolean;
	writers: readonly { pid: number; start: string; kind: string }[];
	unresolvedClaim: boolean;
}
/** Supporting synthetic evidence only. Does not enumerate, kill, or prove processes absent. */
export function quietEvidence(lastExit: number, samples: readonly QuietSample[]): boolean {
	return (
		samples.length === 6 &&
		samples[0]!.second - lastExit >= 10 &&
		samples.every(
			(s, i) =>
				s.second === samples[0]!.second + i * 15 && s.stable && !s.unresolvedClaim && s.writers.length === 0,
		)
	);
}
