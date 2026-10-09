/** Orphaned child-session pruning (#test-fixture-hygiene §6 Track D).
 *
 * A child session is ORPHANED iff no parent session file's header.id
 * matches its launch.parentSessionId. Parent files are matched by
 * header.id (first-line session event `id`) — NEVER by filename: session
 * filename uuids are independent randomUUID() calls and never equal
 * header ids (the trap this design's own draft fell into).
 *
 * A child holding a LIVE lease is exempt even when orphaned — reuse of
 * child-lease semantics: lease payload carries { pid, … } in JSON; a
 * lease is live iff its pid is alive (kill(pid,0)) OR its mtime is
 * within STALE_GRACE_MS (60s), mirroring child-lease.ts's rule. */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const STALE_GRACE_MS = 60_000;

export interface OrphanChild {
	/** Absolute path of the orphaned child .jsonl */
	file: string;
	/** Parent dir of the child file (…/children) */
	dir: string;
}

interface SessionHeaderShim {
	id?: unknown;
	launch?: unknown;
}

function readHeaderId(file: string): string | null {
	try {
		const first = readFileSync(file, "utf8").split("\n", 1)[0];
		if (first === undefined || first === "") return null;
		const parsed = JSON.parse(first) as SessionHeaderShim;
		return typeof parsed.id === "string" ? parsed.id : null;
	} catch {
		return null;
	}
}

function readParentSessionId(childFile: string): string | null {
	try {
		const first = readFileSync(childFile, "utf8").split("\n", 1)[0];
		if (first === undefined || first === "") return null;
		const parsed = JSON.parse(first) as SessionHeaderShim;
		const launch = parsed.launch as { parentSessionId?: unknown } | undefined;
		return typeof launch?.parentSessionId === "string" ? launch.parentSessionId : null;
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Lease layout (child-lease.ts): `<child>.jsonl.lease/` is a DIRECTORY
 *  holding candidate FILES (`lease-<pid>-<nonce8>-<attemptId>`), each a
 *  JSON payload { pid, host, machineId, nonce, attemptId, startedAt }.
 *  The heartbeat utimesSyncs the candidate FILE, not the directory — so
 *  freshness must be read from the entries. A lease holds a live child iff
 *  ANY candidate is fresh (mtime within STALE_GRACE_MS) or carries a
 *  live pid (kill(pid,0)); this mirrors child-lease.ts's own rule
 *  (code-review M-1: the first draft readFileSync'd the directory and
 *  silently never exempted). */
function leaseHoldsLiveChild(leasePath: string, now: number): boolean {
	let entries: string[];
	try {
		const stat = statSync(leasePath);
		if (!stat.isDirectory()) return false; // legacy/foreign shape: not holding
		entries = readdirSync(leasePath);
	} catch {
		return false; // missing/unreadable: not holding
	}
	for (const entry of entries) {
		if (entry.startsWith(".staging-")) continue;
		const candidate = join(leasePath, entry);
		try {
			if (now - statSync(candidate).mtimeMs <= STALE_GRACE_MS) return true;
			const payload = JSON.parse(readFileSync(candidate, "utf8")) as { pid?: unknown };
			if (typeof payload.pid === "number" && pidAlive(payload.pid)) return true;
		} catch {
			// unreadable candidate: try the next one
		}
	}
	return false;
}

/** Enumerate orphaned children across all per-cwd session dirs.
 * `sessionRoots` = the session base dirs (e.g. ~/.ink/sessions/<per-cwd dirs>' parent). */
export function findOrphanChildren(sessionsRoot: string): OrphanChild[] {
	const orphans: OrphanChild[] = [];
	let dirNames: string[] = [];
	try {
		dirNames = readdirSync(sessionsRoot);
	} catch {
		return [];
	}
	for (const dirName of dirNames) {
		const dir = join(sessionsRoot, dirName);
		let parentIds: Set<string>;
		try {
			parentIds = new Set(
				readdirSync(dir)
					.filter((n) => n.endsWith(".jsonl"))
					.map((n) => readHeaderId(join(dir, n)))
					.filter((id): id is string => id !== null),
			);
		} catch {
			continue;
		}
		const childrenDir = join(dir, "children");
		let childNames: string[] = [];
		try {
			childNames = readdirSync(childrenDir).filter((n) => n.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const childName of childNames) {
			const childFile = join(childrenDir, childName);
			const parentId = readParentSessionId(childFile);
			if (parentId === null || parentIds.has(parentId)) continue;
			orphans.push({ file: childFile, dir: childrenDir });
		}
	}
	return orphans;
}

export interface PruneResult {
	/** Removed child .jsonl basenames */
	removed: string[];
	/** Orphans kept because a live lease holds them */
	exempt: string[];
}

/** Delete orphaned children + their .lease sidecars; live-leased ones exempt. */
export function pruneOrphanChildren(sessionsRoot: string): PruneResult {
	const now = Date.now();
	const result: PruneResult = { removed: [], exempt: [] };
	for (const orphan of findOrphanChildren(sessionsRoot)) {
		const lease = `${orphan.file}.lease`;
		if (leaseHoldsLiveChild(lease, now)) {
			result.exempt.push(basename(orphan.file));
			continue;
		}
		rmSync(orphan.file, { force: true });
		rmSync(lease, { force: true, recursive: true });
		result.removed.push(basename(orphan.file));
	}
	return result;
}
