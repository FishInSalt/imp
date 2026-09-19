/**
 * Project trust — the gate for project-scoped executable resources (M8).
 *
 * Loading `<cwd>/.imp/extensions/*.mjs` or `<cwd>/.imp/agents/*` from a
 * directory the user has never vouched for is arbitrary code execution: a
 * cloned repository becomes a drive-by. The model follows pi's
 * trust-manager (verified against its source): a global JSON store of
 * per-directory decisions, queried by NEAREST ANCESTOR — trust the root of
 * a monorepo once and every checkout beneath it inherits the decision.
 *
 * Decisions: `true` = load project resources, `false` = never load, absent
 * = undecided (ask interactively; non-interactive callers deny for the
 * session without recording anything, so a later interactive open still
 * asks). Paths are canonicalized through realpath so symlinked checkouts
 * cannot dodge a recorded denial.
 */
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as readline from "node:readline";
import { ancestorAgentsSkillDirs } from "./skills.js";

/** `true`/`false` records; absent key = undecided. `null` is not stored. */
export type TrustFile = Record<string, boolean>;

export function defaultTrustStorePath(home: string): string {
	return join(home, ".imp", "trust.json");
}

/** realpath when it resolves (recorded paths and queries stay comparable),
 *  resolved absolute otherwise (a deleted directory keeps its record). */
export function canonicalizeDir(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return resolve(dir);
	}
}

/** Tolerant read: a missing store is an empty one. A malformed store is a
 *  hard error — silently treating a corrupted trust file as "trust nothing"
 *  or "trust everything" would both be wrong. */
export function readTrustFile(storePath: string): TrustFile {
	if (!existsSync(storePath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(storePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`failed to read the trust store ${storePath}: ${message} — fix or delete that file to recover (it only holds trust decisions)`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`invalid trust store ${storePath}: expected an object of { "dir": true|false }`);
	}
	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value !== true && value !== false) {
			throw new Error(
				`invalid trust store ${storePath}: value for ${JSON.stringify(key)} must be true or false`,
			);
		}
		data[canonicalizeDir(key)] = value;
	}
	return data;
}

/** Sorted keys keep the file diff-friendly under version control. The write
 *  is tmp+rename so a concurrent reader never sees a torn file (M8 review:
 *  a bare writeFileSync read mid-write crashed a whole imp startup), and the
 *  read-modify-write helpers below serialize through an exclusive lock file
 *  so two imp processes cannot silently drop each other's records. */
export function writeTrustFile(storePath: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false) sorted[key] = value;
	}
	mkdirSync(dirname(storePath), { recursive: true });
	const tmp = `${storePath}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(sorted, null, "\t")}\n`, "utf8");
	renameSync(tmp, storePath);
}

/** Minimal exclusive lock (zero deps, unlike pi's proper-lockfile): O_EXCL
 *  on a sidecar file, bounded retry, stale-break after 5s — enough for the
 *  two-imp-terminals case, not a distributed lock. Degrades to unlocked
 *  rather than bricking after 1s of contention. */
function withStoreLock<T>(storePath: string, fn: () => T): T {
	const lockPath = `${storePath}.lock`;
	mkdirSync(dirname(storePath), { recursive: true });
	for (let attempt = 0; ; attempt++) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx");
		} catch {
			if (attempt >= 50) return fn(); // degraded: proceed unlocked rather than brick
			const started = Date.now();
			while (Date.now() - started < 20) {
				/* busy-wait 20ms — sync context, no Atomics needed */
			}
			continue;
		}
		try {
			return fn();
		} finally {
			closeSync(fd);
			unlinkSync(lockPath);
		}
	}
}

/** Walk canonical `dir` upward; the first recorded ancestor decides. */
export function nearestTrustEntry(data: TrustFile, dir: string): { path: string; trusted: boolean } | null {
	let current = canonicalizeDir(dir);
	for (;;) {
		const value = data[current];
		if (value === true || value === false) return { path: current, trusted: value };
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Record a decision at `dir` (canonicalized) in one locked read-modify-write.
 *  `rebuildOnCorrupt` (the --trust/--no-trust flag path): an unreadable store
 *  is replaced instead of propagated — the documented recovery command must
 *  itself be able to repair the store (M8 review). */
export function setTrust(storePath: string, dir: string, trusted: boolean, rebuildOnCorrupt = false): void {
	withStoreLock(storePath, () => {
		let data: TrustFile;
		try {
			data = readTrustFile(storePath);
		} catch (err) {
			if (!rebuildOnCorrupt) throw err;
			data = {};
		}
		data[canonicalizeDir(dir)] = trusted;
		writeTrustFile(storePath, data);
	});
}

/** Remove one record (exact directory; false when it was not recorded). */
export function removeTrust(storePath: string, dir: string): boolean {
	return withStoreLock(storePath, () => {
		const data = readTrustFile(storePath);
		const key = canonicalizeDir(dir);
		if (!(key in data)) return false;
		delete data[key];
		writeTrustFile(storePath, data);
		return true;
	});
}

/** The one-time [y/N] ask (interactive callers only). Streams are injected
 *  so tests drive it exactly like the REPL's confirm queue; Ctrl+C, Ctrl+D,
 *  or EOF resolve false — a closing prompt is a denial, never a hang. */
/** The one-time [y/N] ask (interactive callers only). Streams are injected
 *  so tests drive it exactly like the REPL's confirm queue. Tri-state:
 *  `true`/`false` are EXPLICIT line answers (recorded by the caller);
 *  `null` = cancelled — EOF, Ctrl+D, or SIGINT closed the prompt without an
 *  answer, which denies for the session but records NOTHING (a dropped SSH
 *  session must not become a permanent denial — M8 review). The SIGINT
 *  listener is load-bearing: without one, readline only PAUSES and the
 *  promise may never settle (the pause→close fallback on current Node is
 *  not the documented contract). */
export function askTrustOnce(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	question: string,
): Promise<boolean | null> {
	const rl = readline.createInterface({ input, output });
	return new Promise((resolve) => {
		let settled = false;
		const settle = (answer: boolean | null): void => {
			if (settled) return;
			settled = true;
			rl.close();
			resolve(answer);
		};
		rl.question(question, (line) => {
			settle(/^y(?:es)?$/i.test(line.trim()));
		});
		rl.on("SIGINT", () => settle(null));
		rl.on("close", () => settle(null));
	});
}

/** Project resources that REQUIRE trust: only `<cwd>/.imp/` items that load
 *  executable or model-directed content, plus `.agents/skills` directories in
 *  cwd and its ancestors up to the git root (M12 — pi parity: the ancestor
 *  walk stops at the repo boundary; the user-global `~/.agents/skills` itself
 *  is never a project resource). Global `~/.imp/` needs no gate — the user
 *  installed it themselves. Plain `AGENTS.md` context files stay
 *  ungated (prompt-level, matching pi and Claude Code). */
export function trustRequiringResources(cwd: string, home: string): string[] {
	// ONLY $HOME itself is exempt — there `.imp/*` IS the user's own global
	// installation and must never gate itself. The whole home TREE is NOT
	// exempt (#trust-home-fix): pi gates any directory with project
	// resources regardless of location (macOS keeps everything under ~ —
	// a blanket exemption would silently disable the gate everywhere).
	if (canonicalizeDir(cwd) === canonicalizeDir(home)) return [];
	const found: string[] = [];
	// ".imp/commands" (M11 #6) is prompt-level, not code — but it talks to
	// the model, so it gates like the rest (review P1: a commands-only repo
	// used to slip through the empty-resources early-exit).
	// ".imp/skills" (M12) — same reasoning: skills ARE model-directed content.
	for (const rel of [".imp/extensions", ".imp/agents", ".imp/commands", ".imp/skills"]) {
		const target = join(cwd, rel);
		if (existsSync(target) && statSync(target).isDirectory()) found.push(rel);
	}
	// `.agents/skills` ancestor walk (M12): cwd first, up to the git root,
	// excluding the user-global ~/.agents/skills. Entries are relative to
	// cwd ("../.agents/skills" for ancestors) so describeTrustResources can
	// count their files the same way.
	for (const dir of ancestorAgentsSkillDirs(cwd, home)) {
		if (existsSync(dir)) found.push(relative(cwd, dir) || ".");
	}
	return found;
}

/** "dir (N file[s])" for the ask line — the user should not vouch blind
 *  (M8 review: name what is about to load, not just the category dirs). */
export function describeTrustResources(cwd: string, resources: readonly string[]): string {
	return resources
		.map((rel) => {
			let count = 0;
			try {
				count = readdirSync(join(cwd, rel)).filter(
					(f) => f.endsWith(".mjs") || f.endsWith(".js") || f.endsWith(".md"),
				).length;
			} catch {
				/* unreadable → just show the dir */
			}
			return count > 0 ? `${rel} (${count} file${count === 1 ? "" : "s"})` : rel;
		})
		.join(", ");
}
