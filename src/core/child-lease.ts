/**
 * SA-07 single-writer lease (design §7, docs/sa-07-child-resume-design.md).
 *
 * One active execution per child, enforced in-process (a synchronous Map)
 * and across processes on one machine (a `<child>.jsonl.lease` file beside
 * the session file). A lease is JSON: { pid, host, machineId, attemptId,
 * startedAt }.
 *
 * Stale recovery: a lease is stealable only when the recorded pid is not
 * alive in THIS pid namespace AND its mtime is older than the grace window
 * (default 60s, three missed heartbeats). The mtime requirement is what
 * keeps a live holder in a sibling pid namespace (containers sharing the
 * sessions directory) safe: it heartbeats every 20s, so its mtime never
 * looks stale even though its pid is invisible here. Stealing is a
 * rename-based claim (atomic, one winner), verified by re-reading the moved
 * bytes; a mismatch means someone re-created the lease in the window and is
 * restored best-effort and refused.
 *
 * The holder heartbeats (touch + re-verify). If its lease turns foreign or
 * vanishes, the holder reports an anomaly — the caller aborts the attempt,
 * so no interleaving can leave two attempts CONTINUING.
 */
import { randomUUID } from "node:crypto";
import {
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
	 *  per-directory machine id / process.kill(pid, 0) / Date.now(). */
	pid?: number;
	host?: string;
	machineId?: string;
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
	attemptId: string;
	startedAt: string;
}

const DEFAULT_STALE_GRACE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const MAX_STEAL_ROUNDS = 3;

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
		typeof record.attemptId === "string" &&
		typeof record.startedAt === "string"
	);
}

function readPayload(leasePath: string): LeasePayload | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(leasePath, "utf8"));
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

/** Read-or-create the per-directory machine id (one random UUID per children
 *  directory). Two containers sharing a mounted sessions directory share it;
 *  hostname alone collides across containers, and pids are meaningless
 *  across pid namespaces. */
function resolveMachineId(dir: string): string {
	const file = path.join(dir, ".imp-machine-id");
	try {
		const existing = readFileSync(file, "utf8").trim();
		if (existing !== "") return existing;
	} catch {
		// fall through to create
	}
	const fresh = randomUUID();
	try {
		writeFileSync(file, `${fresh}\n`, { encoding: "utf8", flag: "wx" });
		return fresh;
	} catch (err) {
		if (errnoCode(err) === "EEXIST") {
			const raced = readFileSync(file, "utf8").trim();
			if (raced !== "") return raced;
		}
		throw err;
	}
}

/**
 * Acquire the single-writer lease for a child session file. Refusals:
 *  - busy: another attempt holds it (in-process, a live pid, or a
 *    dead-looking pid whose lease is still fresh — recovery hint included);
 *  - owned-elsewhere: held by another host or machine id (unsupported);
 *  - stale-contended: the stale-reclaim race repeated (someone re-created
 *    the lease mid-steal);
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
				// Contended: inspect the existing lease.
				const existing = readPayload(leasePath);
				if (existing !== undefined && (existing.host !== host || existing.machineId !== machineId)) {
					return failWith(
						"owned-elsewhere",
						`child ${childFilePath} is owned by an attempt on host "${existing.host}" (machine ${existing.machineId}) — shared-storage sessions across machines are not supported`,
					);
				}
				const ownLeftover = existing !== undefined && existing.pid === pid;
				const dead = existing === undefined || !isAlive(existing.pid);
				let ageMs = 0;
				try {
					ageMs = now() - statSync(leasePath).mtimeMs;
				} catch (statErr) {
					if (errnoCode(statErr) === "ENOENT") continue; // vanished; retry the create
					return failWith("io-error", `cannot inspect the lease at ${leasePath}: ${String(statErr)}`);
				}
				if (!ownLeftover && !dead) {
					return failWith(
						"busy",
						`another attempt for this child is running (pid ${existing.pid}, host ${existing.host}, started ${existing.startedAt})`,
					);
				}
				if (!ownLeftover && existing !== undefined && ageMs <= staleGraceMs) {
					const retryIn = Math.max(1, Math.ceil((staleGraceMs - ageMs) / 1000));
					return failWith(
						"busy",
						`another attempt for this child (pid ${existing.pid}) looks dead here but may be live in another pid namespace; if it really crashed, retry in ~${retryIn}s`,
					);
				}
				// Steal: rename is the atomic claim (one winner per generation).
				const stealPath = `${leasePath}.steal`;
				let before: Buffer;
				try {
					before = readFileSync(leasePath);
				} catch (readErr) {
					if (errnoCode(readErr) === "ENOENT") continue;
					return failWith("io-error", `cannot read the stale lease at ${leasePath}: ${String(readErr)}`);
				}
				options.onBeforeStealRename?.();
				try {
					renameSync(leasePath, stealPath);
				} catch (renameErr) {
					if (errnoCode(renameErr) === "ENOENT") continue; // someone else won; retry
					return failWith("io-error", `cannot reclaim the stale lease at ${leasePath}: ${String(renameErr)}`);
				}
				let after: Buffer | undefined;
				try {
					after = readFileSync(stealPath);
				} catch {
					after = undefined;
				}
				if (after === undefined || !before.equals(after)) {
					// The moved file is not what we decided about: someone
					// re-created the lease in the window. Restore best-effort.
					try {
						renameSync(stealPath, leasePath);
					} catch {
						try {
							rmSync(stealPath, { force: true });
						} catch {
							// leave the artifact; a later acquire re-steals
						}
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
			const written = readPayload(leasePath);
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
						const current = readPayload(leasePath);
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
					const current = readPayload(leasePath);
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
