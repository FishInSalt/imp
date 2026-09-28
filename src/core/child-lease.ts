/**
 * SA-07 single-writer lease (design §7, docs/sa-07-child-resume-design.md).
 *
 * One active execution per child, enforced in-process (a synchronous Map)
 * and across processes on one machine (a `<child>.jsonl.lease` file beside
 * the session file). A lease is JSON: { pid, host, machineId, nonce,
 * attemptId, startedAt }.
 *
 * Acceptance round 2 revisions (owner findings 4-6):
 *  - ONE read decides stealability AND is the byte generation the steal must
 *    move: a separate eligibility read and content read could disagree under
 *    a concurrent writer, letting a live lease be stolen.
 *  - Steal targets are UNIQUE per attempt (`.steal-<attemptId>`), so two
 *    stealers can never clobber each other's artifact.
 *  - Restore after a mismatch uses link() (fails EEXIST) instead of
 *    renameSync (which REPLACES on POSIX) — a third holder is never
 *    overwritten.
 *  - `nonce` is a per-process instance id: a same-pid lease with a DIFFERENT
 *    nonce (another process instance, possibly a sibling pid namespace
 *    sharing the sessions directory) is REFUSED, never reclaimed. Only this
 *    exact process's own failed-release leftover (same pid AND same nonce)
 *    is reclaimed immediately.
 *  - The machine id is published atomically (tmp + rename); an empty file
 *    left by a crash between create and write is repaired instead of
 *    blocking the directory forever.
 *
 * Stale recovery: a lease is stealable only when the recorded pid is not
 * alive in THIS pid namespace AND its mtime is older than the grace window
 * (default 60s, three missed heartbeats). The mtime requirement keeps a live
 * holder in a sibling pid namespace safe: it heartbeats every 20s.
 *
 * The holder heartbeats (touch + re-verify). If its lease turns foreign or
 * vanishes, the holder reports an anomaly — the caller aborts the attempt.
 */
import { randomUUID } from "node:crypto";
import {
	linkSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export interface ChildLeaseHandle {
	readonly path: string;
	readonly attemptId: string;
	/** Release the lease (finally). Safe to call twice; only unlinks a lease
	 *  that still parses and belongs to this attempt. */
	release(): void;
	/** Start the mtime heartbeat; `onAnomaly` fires when the lease no longer
	 *  belongs to this attempt (missing or foreign) — the caller must abort
	 *  the attempt. Idempotent. */
	startHeartbeat(onAnomaly: () => void): void;
}

export type ChildLeaseResult =
	| { ok: true; lease: ChildLeaseHandle }
	| { ok: false; code: "busy" | "stale-contended" | "owned-elsewhere" | "io-error"; message: string };

export interface ChildLeaseOptions {
	/** Test seams; production defaults are process.pid / os.hostname() /
	 *  per-directory machine id / module-load process nonce /
	 *  process.kill(pid, 0) / Date.now(). */
	pid?: number;
	host?: string;
	machineId?: string;
	/** Per-process instance nonce (acceptance round 2, F5): distinguishes
	 *  THIS process from other processes that happen to share its numeric
	 *  pid across pid namespaces. Defaults to a module-load UUID. */
	nonce?: string;
	isAlive?: (pid: number) => boolean;
	now?: () => number;
	/** Test seam: invoked after the pre-steal read and before the rename, so
	 *  a test can inject the "lease changed while being reclaimed" race. */
	onBeforeStealRename?: () => void;
	staleGraceMs?: number;
	heartbeatMs?: number;
}

interface LeasePayload {
	pid: number;
	host: string;
	machineId: string;
	nonce: string;
	attemptId: string;
	startedAt: string;
}

const DEFAULT_STALE_GRACE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const MAX_STEAL_ROUNDS = 3;

/** This process's instance identity — written into every lease it holds. */
const PROCESS_NONCE = randomUUID();

/** In-process registry: child file path → holding attempt. Checked and set
 *  SYNCHRONOUSLY (no await between), so same-process concurrency cannot slip
 *  through even if the lease file is mangled. */
const inProcess = new Map<string, string>();

function isPayload(value: unknown): value is LeasePayload {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.pid === "number" &&
		typeof record.host === "string" &&
		typeof record.machineId === "string" &&
		typeof record.nonce === "string" &&
		typeof record.attemptId === "string" &&
		typeof record.startedAt === "string"
	);
}

function parsePayload(bytes: Buffer | undefined): LeasePayload | undefined {
	if (bytes === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		return isPayload(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists but belongs to another user.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function errnoCode(err: unknown): string | undefined {
	return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/** Read-or-create the per-directory machine id, published ATOMICALLY (tmp +
 *  rename) so no process can ever observe a half-initialized file; an empty
 *  file (a crash between create and write in an older build) is repaired
 *  instead of blocking every child in the directory. */
function resolveMachineId(dir: string): string {
	const file = path.join(dir, ".imp-machine-id");
	let existing: string | undefined;
	try {
		existing = readFileSync(file, "utf8").trim();
	} catch (err) {
		if (errnoCode(err) !== "ENOENT") throw err;
	}
	if (existing !== undefined && existing !== "") return existing;
	const fresh = randomUUID();
	const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	writeFileSync(tmp, `${fresh}\n`, { encoding: "utf8" });
	try {
		renameSync(tmp, file);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// leave the temporary artifact; it is never read as the machine id
		}
		throw err;
	}
	// Converge on whichever atomic publish landed last (a concurrent creator
	// may have replaced ours — either value is a valid id for this machine).
	try {
		const settled = readFileSync(file, "utf8").trim();
		if (settled !== "") return settled;
	} catch {
		// fall through to our own value
	}
	return fresh;
}

/**
 * Acquire the single-writer lease for a child session file. Refusals:
 *  - busy: another attempt holds it (in-process, a live pid, a dead-looking
 *    pid whose lease is still fresh, or a SAME-PID lease this process cannot
 *    identify as its own leftover);
 *  - owned-elsewhere: another host or machine id (unsupported);
 *  - stale-contended: the stale-reclaim race repeated;
 *  - io-error: the lease could not be created or verified.
 */
export function acquireChildLease(
	childFilePath: string,
	attemptId: string,
	options: ChildLeaseOptions = {},
): ChildLeaseResult {
	const leasePath = `${childFilePath}.lease`;
	if (inProcess.has(childFilePath)) {
		return {
			ok: false,
			code: "busy",
			message: `another attempt for this child is already running in this process (${childFilePath})`,
		};
	}
	inProcess.set(childFilePath, attemptId);
	const failWith = (
		code: "busy" | "stale-contended" | "owned-elsewhere" | "io-error",
		message: string,
	): ChildLeaseResult => {
		inProcess.delete(childFilePath);
		return { ok: false, code, message };
	};

	const pid = options.pid ?? process.pid;
	const host = options.host ?? hostname();
	const nonce = options.nonce ?? PROCESS_NONCE;
	const now = options.now ?? (() => Date.now());
	const isAlive = options.isAlive ?? defaultIsAlive;
	const staleGraceMs = options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

	let machineId: string;
	try {
		machineId = options.machineId ?? resolveMachineId(path.dirname(childFilePath));
	} catch (err) {
		return failWith("io-error", `cannot resolve the machine id beside ${childFilePath}: ${String(err)}`);
	}

	const payload: LeasePayload = {
		pid,
		host,
		machineId,
		nonce,
		attemptId,
		startedAt: new Date(now()).toISOString(),
	};
	const serialized = `${JSON.stringify(payload)}\n`;

	try {
		for (let round = 0; round < MAX_STEAL_ROUNDS; round++) {
			try {
				writeFileSync(leasePath, serialized, { encoding: "utf8", flag: "wx" });
			} catch (err) {
				if (errnoCode(err) !== "EEXIST") {
					return failWith("io-error", `cannot create the lease at ${leasePath}: ${String(err)}`);
				}
				// Contended. ONE read decides eligibility AND is the byte
				// generation the steal must move (F4a): if a writer re-creates
				// the lease after this read, the post-rename comparison sees
				// different bytes and refuses.
				let beforeBytes: Buffer;
				try {
					beforeBytes = readFileSync(leasePath);
				} catch (readErr) {
					if (errnoCode(readErr) === "ENOENT") continue; // vanished; retry the create
					return failWith("io-error", `cannot read the lease at ${leasePath}: ${String(readErr)}`);
				}
				const existing = parsePayload(beforeBytes);
				if (existing !== undefined && (existing.host !== host || existing.machineId !== machineId)) {
					return failWith(
						"owned-elsewhere",
						`child ${childFilePath} is owned by an attempt on host "${existing.host}" (machine ${existing.machineId}) — shared-storage sessions across machines are not supported`,
					);
				}
				let stealable = false;
				let busyMessage = "another attempt for this child is running";
				if (existing === undefined) {
					stealable = true; // unparseable debris
				} else if (existing.pid === pid) {
					if (existing.nonce === nonce) {
						stealable = true; // this exact process's failed-release leftover
					} else {
						// Same numeric pid, different process instance/namespace
						// (F5): cannot be told apart from a live holder — refuse,
						// never reclaim a possibly-active lease.
						busyMessage = `child ${childFilePath} already has a lease from a process with pid ${pid} that this process cannot identify as its own (another instance or pid namespace) — refused rather than reclaimed`;
					}
				} else if (isAlive(existing.pid)) {
					busyMessage = `another attempt for this child is running (pid ${existing.pid}, host ${existing.host}, started ${existing.startedAt})`;
				} else {
					let ageMs: number;
					try {
						ageMs = now() - statSync(leasePath).mtimeMs;
					} catch (statErr) {
						if (errnoCode(statErr) === "ENOENT") continue;
						return failWith("io-error", `cannot inspect the lease at ${leasePath}: ${String(statErr)}`);
					}
					if (ageMs <= staleGraceMs) {
						const retryIn = Math.max(1, Math.ceil((staleGraceMs - ageMs) / 1000));
						busyMessage = `another attempt for this child (pid ${existing.pid}) looks dead here but may be live in another pid namespace; if it really crashed, retry in ~${retryIn}s`;
					} else {
						stealable = true;
					}
				}
				if (!stealable) return failWith("busy", busyMessage);

				// Steal: a UNIQUE target per attempt — two stealers can never
				// share an artifact, and a rename can never clobber another's
				// claim (F4b).
				options.onBeforeStealRename?.();
				const stealPath = `${leasePath}.steal-${attemptId}`;
				try {
					renameSync(leasePath, stealPath);
				} catch (renameErr) {
					if (errnoCode(renameErr) === "ENOENT") continue; // someone else won; retry
					return failWith("io-error", `cannot reclaim the stale lease at ${leasePath}: ${String(renameErr)}`);
				}
				let afterBytes: Buffer | undefined;
				try {
					afterBytes = readFileSync(stealPath);
				} catch {
					afterBytes = undefined;
				}
				if (afterBytes === undefined || !beforeBytes.equals(afterBytes)) {
					// The moved bytes are not the generation we decided about:
					// a writer re-created the lease in the window. Restore
					// WITHOUT clobbering — link() fails EEXIST instead of
					// replacing (F4b); a third holder's lease is never
					// overwritten.
					try {
						linkSync(stealPath, leasePath);
						unlinkSync(stealPath);
					} catch (restoreErr) {
						if (errnoCode(restoreErr) === "EEXIST") {
							// A third holder re-created the lease; our moved
							// artifact is obsolete — drop it.
							try {
								rmSync(stealPath, { force: true });
							} catch {
								// debris only
							}
						}
						// Other restore failures: leave the artifact; the lease
						// path itself was never touched in this branch.
					}
					return failWith(
						"stale-contended",
						`the lease for ${childFilePath} changed while being reclaimed — another attempt is active; retry`,
					);
				}
				try {
					rmSync(stealPath, { force: true });
				} catch {
					// debris only; the create below is what matters
				}
				continue; // retry the exclusive create
			}
			// Created: verify by reading back.
			let written: LeasePayload | undefined;
			try {
				written = parsePayload(readFileSync(leasePath));
			} catch {
				written = undefined;
			}
			if (written === undefined || written.attemptId !== attemptId) {
				return failWith("io-error", `cannot verify the lease at ${leasePath} after creating it`);
			}
			let timer: NodeJS.Timeout | undefined;
			const handle: ChildLeaseHandle = {
				path: leasePath,
				attemptId,
				startHeartbeat(onAnomaly) {
					if (timer !== undefined) return;
					timer = setInterval(() => {
						let current: LeasePayload | undefined;
						try {
							current = parsePayload(readFileSync(leasePath));
						} catch {
							current = undefined;
						}
						if (current === undefined || current.attemptId !== attemptId) {
							// One report is enough — the caller aborts the attempt.
							if (timer !== undefined) {
								clearInterval(timer);
								timer = undefined;
							}
							process.stderr.write(
								`imp: child lease anomaly at ${leasePath} — the lease no longer belongs to this attempt\n`,
							);
							onAnomaly();
							return;
						}
						try {
							const stamp = new Date(now());
							utimesSync(leasePath, stamp, stamp);
						} catch {
							onAnomaly();
						}
					}, heartbeatMs);
					timer.unref?.();
				},
				release() {
					if (timer !== undefined) {
						clearInterval(timer);
						timer = undefined;
					}
					if (inProcess.get(childFilePath) === attemptId) inProcess.delete(childFilePath);
					let current: LeasePayload | undefined;
					try {
						current = parsePayload(readFileSync(leasePath));
					} catch {
						current = undefined;
					}
					if (current === undefined || current.attemptId !== attemptId) return; // gone or foreign: leave it
					try {
						unlinkSync(leasePath);
					} catch {
						// Truncate to a zero-byte artifact: debris, immediately
						// stealable by the next acquire (never a live-looking lease).
						try {
							truncateSync(leasePath, 0);
						} catch {
							// best effort; the stale-self rule recovers it later
						}
						process.stderr.write(
							`imp: could not remove the child lease at ${leasePath} — left an empty artifact\n`,
						);
					}
				},
			};
			return { ok: true, lease: handle };
		}
		return failWith(
			"stale-contended",
			`could not reclaim the stale lease for ${childFilePath} after ${MAX_STEAL_ROUNDS} rounds`,
		);
	} catch (err) {
		return failWith("io-error", `lease acquisition failed for ${childFilePath}: ${String(err)}`);
	}
}
