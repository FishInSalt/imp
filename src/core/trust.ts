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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as readline from "node:readline";

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
		throw new Error(`failed to read the trust store ${storePath}: ${message}`);
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

/** Sorted keys keep the file diff-friendly under version control. */
export function writeTrustFile(storePath: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false) sorted[key] = value;
	}
	mkdirSync(dirname(storePath), { recursive: true });
	writeFileSync(storePath, `${JSON.stringify(sorted, null, "\t")}\n`, "utf8");
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

/** Record a decision at `dir` (canonicalized) in one read-modify-write. */
export function setTrust(storePath: string, dir: string, trusted: boolean): void {
	const data = readTrustFile(storePath);
	data[canonicalizeDir(dir)] = trusted;
	writeTrustFile(storePath, data);
}

/** Remove one record (exact directory; `null` when it was not recorded). */
export function removeTrust(storePath: string, dir: string): boolean {
	const data = readTrustFile(storePath);
	const key = canonicalizeDir(dir);
	if (!(key in data)) return false;
	delete data[key];
	writeTrustFile(storePath, data);
	return true;
}

/** The one-time [y/N] ask (interactive callers only). Streams are injected
 *  so tests drive it exactly like the REPL's confirm queue; Ctrl+C, Ctrl+D,
 *  or EOF resolve false — a closing prompt is a denial, never a hang. */
export function askTrustOnce(
	input: NodeJS.ReadableStream & { on: NodeJS.ReadableStream["on"] },
	output: NodeJS.WritableStream,
	resources: readonly string[],
): Promise<boolean> {
	const rl = readline.createInterface({ input, output });
	return new Promise((resolve) => {
		let settled = false;
		const settle = (approved: boolean): void => {
			if (settled) return;
			settled = true;
			rl.close();
			resolve(approved);
		};
		rl.question(
			`trust the files in this directory? it wants to load: ${resources.join(", ")} [y/N] `,
			(answer) => {
				settle(/^y(?:es)?$/i.test(answer.trim()));
			},
		);
		rl.on("close", () => settle(false));
	});
}

/** Project resources that REQUIRE trust: only `<cwd>/.imp/` items that load
 *  executable or model-directed content. Global `~/.imp/` needs no gate —
 *  the user installed it themselves. Plain `AGENTS.md` context files stay
 *  ungated (prompt-level, matching pi and Claude Code). */
export function trustRequiringResources(cwd: string): string[] {
	const found: string[] = [];
	for (const rel of [".imp/extensions", ".imp/agents"]) {
		if (existsSync(join(cwd, rel))) found.push(rel);
	}
	return found;
}
