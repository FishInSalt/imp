/**
 * SA-07 single-writer lease — INTENT + VERIFY protocol (design §7,
 * docs/design/sa-07-child-resume-design.md; revised after owner round 3).
 *
 * There is no shared mutable lease path. The artifact is a DIRECTORY
 * `<child>.jsonl.lease/` holding one candidate file per acquisition:
 * `lease-<pid>-<nonce8>-<attemptId>`, content { pid, host, machineId,
 * nonce, attemptId, startedAt }.
 *
 * Acquire = create OWN candidate, then SCAN the directory; the caller holds
 * only when no other ACTIVE or UNCERTAIN candidate is visible. Nothing ever
 * moves, replaces or unlinks a live claim — the vacuum class of race that
 * let a third process acquire during a stale-lease reclaim (owner round 3,
 * P1) cannot exist. Mutual exclusion is proven in design §7.3 without any
 * heartbeat assumption; the heartbeat is defense in depth.
 *
 * PINNED INVARIANT (§7.2, design review A1): the own candidate is never
 * unlinked between its creation and the completion of the scan-and-decide;
 * the only pre-hold unlink is the refusal cleanup, after the decision is
 * final.
 *
 * Machine id (design §7.4): published ONCE via a no-clobber link (absent
 * file); an existing valid id is adopted and never rewritten; an EMPTY file
 * (legacy interrupted initialization) refuses with actionable guidance and
 * is never touched — concurrent non-clobbering recovery is impossible
 * without CAS.
 *
 * Staleness: a candidate is retired only when its owner is dead in THIS pid
 * namespace AND its mtime is older than the grace window (default 60s, three
 * missed heartbeats) — the mtime rule protects live holders in sibling pid
 * namespaces. Retiring removes only that dead+aged candidate file.
 */
import { randomUUID } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export interface ChildLeaseHandle {
	/** The lease DIRECTORY (candidate files live inside). */
	readonly path: string;
	readonly attemptId: string;
	/** Release the lease (finally). Safe to call twice; unlinks OWN
	 *  candidate only. */
	release(): void;
	/** Start the mtime heartbeat; `onAnomaly` fires when the own candidate no
	 *  longer exists or no longer parses as ours — the caller must abort the
	 *  attempt. Defense in depth, never a correctness dependency.
	 *  Idempotent. */
	startHeartbeat(onAnomaly: () => void): void;
}

export type ChildLeaseResult =
	| { ok: true; lease: ChildLeaseHandle }
	| { ok: false; code: "busy" | "owned-elsewhere" | "io-error"; message: string };

export interface ChildLeaseOptions {
	/** Test seams; production defaults are process.pid / os.hostname() /
	 *  per-directory machine id / module-load process nonce /
	 *  process.kill(pid, 0) / Date.now(). */
	pid?: number;
	host?: string;
	machineId?: string;
	/** Per-process instance nonce: distinguishes THIS process from other
	 *  processes sharing its numeric pid across pid namespaces. */
	nonce?: string;
	isAlive?: (pid: number) => boolean;
	now?: () => number;
	/** Test seam: fires after the own candidate is created and before the
	 *  verify scan (deterministic interleaving scripts). */
	onAfterCreate?: () => void;
	/** Test seam: fires immediately before the verify scan. */
	onBeforeScan?: () => void;
	/** Test seam: fires immediately before the candidate's link publication
	 *  (the staging file is complete; the final name does not exist yet). */
	onBeforeCandidatePublish?: () => void;
	/** Test seam: fires AFTER a successful link, BEFORE the read-back
	 *  verification; throwing simulates a post-publication verification
	 *  failure (which must not leave a blocking candidate behind). */
	onAfterCandidateLink?: () => void;
	/** Test seam: fires immediately before an ABSENT machine-id link
	 *  publish. */
	onBeforeMachineIdPublish?: () => void;
	staleGraceMs?: number;
	heartbeatMs?: number;
	/** Retry rounds when both contenders refuse each other (default 3;
	 *  deterministic tests set 1). */
	maxAttempts?: number;
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
const DEFAULT_MAX_ATTEMPTS = 3;
const MACHINE_ID_ROUNDS = 5;

/** This process's instance identity — part of every candidate name/payload. */
const PROCESS_NONCE = randomUUID();

/** In-process registry: child file path → holding attempt. Checked and set
 *  SYNCHRONOUSLY (no await between), so same-process concurrency cannot slip
 *  through. */
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

function parsePayload(bytes: Buffer): LeasePayload | undefined {
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

/** Small synchronous sleep for jittered retries (Atomics.wait works on
 *  Node's main thread; busy-wait only as an impossible fallback). */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			// fallback busy wait (bounded by the caller's retry budget)
		}
	}
}

/**
 * Read-or-publish the machine id (design §7.4). Publish-once: a VALID id is
 * adopted and never rewritten; an ABSENT id is published via a no-clobber
 * link (one winner; losers adopt); an EMPTY file refuses with actionable
 * guidance and is never touched.
 */
function resolveMachineId(dir: string, onBeforeMachineIdPublish?: () => void): string {
	const file = path.join(dir, ".ink-machine-id");
	for (let round = 0; round < MACHINE_ID_ROUNDS; round++) {
		let content: string | undefined;
		let exists = true;
		try {
			content = readFileSync(file, "utf8").trim();
		} catch (err) {
			if (errnoCode(err) === "ENOENT") exists = false;
			else throw err;
		}
		if (exists && content !== undefined && content !== "") return content;
		if (exists && content === "") {
			throw new Error(
				`the machine id file is empty (interrupted initialization under an earlier build); delete ${file} to reinitialize`,
			);
		}
		const fresh = randomUUID();
		const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
		writeFileSync(tmp, `${fresh}\n`, { encoding: "utf8" });
		onBeforeMachineIdPublish?.();
		try {
			linkSync(tmp, file); // no-clobber: exactly one publisher wins
			rmSync(tmp, { force: true });
			return fresh;
		} catch (err) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// inert debris; never read as an id
			}
			if (errnoCode(err) !== "EEXIST") throw err;
			// A concurrent publisher won — adopt on the next read.
		}
	}
	throw new Error(`cannot initialize the machine id at ${file} after ${MACHINE_ID_ROUNDS} rounds`);
}

export interface ScanConfig {
	leaseDir: string;
	ownName: string;
	host: string;
	machineId: string;
	now: () => number;
	isAlive: (pid: number) => boolean;
	staleGraceMs: number;
	onBeforeScan?: () => void;
}

/**
 * Publish a COMPLETE candidate atomically (owner round 3, P1): the payload
 * is written to a `.staging-*` file the scanner never reads as a claim,
 * then linked into the scanned name with a no-clobber hard link. The final
 * name therefore NEVER exists in an incomplete state — a scanner cannot
 * observe (or, once aged, retire) a half-written claim while its writer
 * still completes the write and then wrongly holds. If a scanner retires
 * our aged staging first, the link fails ENOENT and we re-stage (bounded).
 */
function publishCandidate(config: {
	leaseDir: string;
	ownName: string;
	stagingName: string;
	serialized: string;
	attemptId: string;
	onBeforeCandidatePublish?: () => void;
	onAfterCandidateLink?: () => void;
	onAfterCreate?: () => void;
}): string {
	const ownPath = path.join(config.leaseDir, config.ownName);
	const stagingPath = path.join(config.leaseDir, config.stagingName);
	for (let round = 0; round < 3; round++) {
		// Unique staging name: the file is ours alone ("w" may truncate only
		// our own previous round).
		writeFileSync(stagingPath, config.serialized, { encoding: "utf8" });
		config.onBeforeCandidatePublish?.();
		try {
			linkSync(stagingPath, ownPath); // no-clobber atomic publication
		} catch (err) {
			if (errnoCode(err) === "ENOENT") continue; // staging retired by a scanner: re-stage
			// EEXIST or an IO failure: WE DID NOT PUBLISH in this round — never
			// blindly unlink the target (owner round 5, P2).
			throw err;
		}
		// We published ownPath in this round: from here EVERY failure must
		// first remove OUR OWN published candidate, or a live-pid claim would
		// block every later acquire until this process exits (owner round 5,
		// P2 — a read-back throw must be cleaned up like a content mismatch).
		try {
			config.onAfterCandidateLink?.();
			const written = parsePayload(readFileSync(ownPath));
			if (written === undefined || written.attemptId !== config.attemptId) {
				throw new Error(`the published lease candidate ${ownPath} did not verify`);
			}
			// The create notification lives INSIDE this guard: a throw from it
			// must clean up like any other post-publication failure (post-hoc
			// design review, F1).
			config.onAfterCreate?.();
		} catch (err) {
			try {
				unlinkSync(ownPath);
			} catch {
				// best effort; a failed unlink still cannot make this round succeed
			}
			try {
				unlinkSync(stagingPath);
			} catch {
				// best effort
			}
			throw err;
		}
		try {
			unlinkSync(stagingPath);
		} catch {
			// debris; aged out by a later scan
		}
		return ownPath;
	}
	throw new Error(`cannot publish the lease candidate ${ownPath} after 3 rounds`);
}

/**
 * Scan the lease directory for any OTHER active or uncertain candidate.
 * Returns a refusal (`busy` / `owned-elsewhere`) or undefined when the own
 * candidate is the only active one. Dead+aged candidates are unlinked
 * opportunistically (cleanup only — it grants nothing); unparseable
 * entries count as UNCERTAIN while fresh.
 */
function scanForBlocker(
	config: ScanConfig,
): { code: "busy" | "owned-elsewhere"; message: string } | undefined {
	config.onBeforeScan?.();
	let entries: string[];
	try {
		entries = readdirSync(config.leaseDir);
	} catch (err) {
		if (errnoCode(err) === "ENOENT") entries = [];
		else throw err;
	}
	for (const entry of entries) {
		if (entry === config.ownName) continue;
		if (!entry.startsWith("lease-")) {
			// Staging files (and any other non-candidate entry) are never
			// claims. Aged `.staging-*` files are our own crash/pause debris:
			// retiring them is safe — a stalled publisher's link then fails
			// ENOENT and re-stages (owner round 3, P1).
			if (entry.startsWith(".staging-")) {
				const stagingPath = path.join(config.leaseDir, entry);
				try {
					if (config.now() - statSync(stagingPath).mtimeMs > config.staleGraceMs) unlinkSync(stagingPath);
				} catch {
					// already gone
				}
			}
			continue;
		}
		const candidatePath = path.join(config.leaseDir, entry);
		let bytes: Buffer;
		try {
			bytes = readFileSync(candidatePath);
		} catch (err) {
			if (errnoCode(err) === "ENOENT") continue; // retired concurrently
			if (errnoCode(err) === "EISDIR") continue; // not a candidate
			throw err;
		}
		let ageMs: number;
		try {
			ageMs = config.now() - statSync(candidatePath).mtimeMs;
		} catch (err) {
			if (errnoCode(err) === "ENOENT") continue;
			throw err;
		}
		const existing = parsePayload(bytes);
		if (existing === undefined) {
			// A torn or foreign entry is not proof of absence: uncertain
			// while fresh, debris once aged.
			if (ageMs <= config.staleGraceMs) {
				return {
					code: "busy",
					message: `child lease candidate ${entry} is unreadable and still fresh — refusing rather than guessing`,
				};
			}
			try {
				unlinkSync(candidatePath);
			} catch {
				// cleanup is best-effort; it grants nothing
			}
			continue;
		}
		if (existing.host !== config.host || existing.machineId !== config.machineId) {
			return {
				code: "owned-elsewhere",
				message: `child lease ${config.leaseDir} is held on host "${existing.host}" (machine ${existing.machineId}) — shared-storage sessions across machines are not supported`,
			};
		}
		if (config.isAlive(existing.pid) || ageMs <= config.staleGraceMs) {
			return {
				code: "busy",
				message: `another attempt for this child is active or unresolved (pid ${existing.pid}, host ${existing.host}, started ${existing.startedAt})`,
			};
		}
		try {
			unlinkSync(candidatePath); // dead + aged: retire this generation only
		} catch {
			// cleanup is best-effort
		}
	}
	return undefined;
}

/**
 * Acquire the single-writer lease (see the module comment for the
 * protocol). Refusals: `busy` (another active/uncertain holder, or a legacy
 * artifact judged live/uncertain), `owned-elsewhere` (another host/machine
 * id), `io-error` (machine id, filesystem).
 */
export function acquireChildLease(
	childFilePath: string,
	attemptId: string,
	options: ChildLeaseOptions = {},
): ChildLeaseResult {
	const leaseDir = `${childFilePath}.lease`;
	if (inProcess.has(childFilePath)) {
		return {
			ok: false,
			code: "busy",
			message: `another attempt for this child is already running in this process (${childFilePath})`,
		};
	}
	inProcess.set(childFilePath, attemptId);
	const failWith = (code: "busy" | "owned-elsewhere" | "io-error", message: string): ChildLeaseResult => {
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
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

	let machineId: string;
	try {
		machineId =
			options.machineId ?? resolveMachineId(path.dirname(childFilePath), options.onBeforeMachineIdPublish);
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
	const ownName = `lease-${pid}-${nonce.slice(0, 8)}-${attemptId}`;
	// A random per-acquire component makes the staging name genuinely unique
	// by construction even if two callers ever share pid+nonce+attemptId
	// (post-hoc design review, F2).
	const stagingName = `.staging-${pid}-${nonce.slice(0, 8)}-${attemptId}-${randomUUID().slice(0, 8)}`;

	try {
		for (let round = 0; round < maxAttempts; round++) {
			// Legacy single-FILE migration (design §7.1): classify from ONE
			// read; live/uncertain refuses with NO directory created;
			// dead+aged is unlinked (that generation only).
			const legacy = migrateLegacyLeaseFile({
				leaseDir,
				host,
				machineId,
				pid,
				nonce,
				now,
				isAlive,
				staleGraceMs,
			});
			if (!legacy.ok) return failWith(legacy.code, legacy.message);

			mkdirSync(leaseDir, { recursive: true });
			let ownPath: string;
			try {
				ownPath = publishCandidate({
					leaseDir,
					ownName,
					stagingName,
					serialized,
					attemptId,
					...(options.onBeforeCandidatePublish === undefined
						? {}
						: { onBeforeCandidatePublish: options.onBeforeCandidatePublish }),
					...(options.onAfterCandidateLink === undefined
						? {}
						: { onAfterCandidateLink: options.onAfterCandidateLink }),
					...(options.onAfterCreate === undefined ? {} : { onAfterCreate: options.onAfterCreate }),
				});
			} catch (err) {
				return failWith(
					"io-error",
					`cannot publish the lease candidate for ${childFilePath}: ${String(err)}`,
				);
			}

			let blocker: { code: "busy" | "owned-elsewhere"; message: string } | undefined;
			try {
				blocker = scanForBlocker({
					leaseDir,
					ownName,
					host,
					machineId,
					now,
					isAlive,
					staleGraceMs,
					...(options.onBeforeScan === undefined ? {} : { onBeforeScan: options.onBeforeScan }),
				});
			} catch (err) {
				// Refusal cleanup AFTER the decision is final (the pinned
				// invariant allows the pre-hold unlink only here and in the
				// blocker branch below).
				try {
					unlinkSync(ownPath);
				} catch {
					// best effort
				}
				try {
					unlinkSync(path.join(leaseDir, stagingName));
				} catch {
					// best effort
				}
				return failWith("io-error", `lease scan failed for ${leaseDir}: ${String(err)}`);
			}
			if (blocker !== undefined) {
				// Step-8 refusal cleanup: the scan-and-decide is complete.
				try {
					unlinkSync(ownPath);
				} catch {
					// best effort
				}
				try {
					unlinkSync(path.join(leaseDir, stagingName));
				} catch {
					// best effort
				}
				if (blocker.code === "owned-elsewhere") return failWith("owned-elsewhere", blocker.message);
				if (round + 1 < maxAttempts) {
					// Both contenders may have refused each other; a jittered
					// retry resolves the livelock (design §7.5 fairness).
					sleepSync(5 + Math.floor(Math.random() * 20));
					continue;
				}
				return failWith("busy", blocker.message);
			}

			// HOLD: the own candidate is the only active/uncertain one.
			let timer: NodeJS.Timeout | undefined;
			const handle: ChildLeaseHandle = {
				path: leaseDir,
				attemptId,
				startHeartbeat(onAnomaly) {
					if (timer !== undefined) return;
					timer = setInterval(() => {
						let current: LeasePayload | undefined;
						try {
							current = parsePayload(readFileSync(ownPath));
						} catch {
							current = undefined;
						}
						if (current === undefined || current.attemptId !== attemptId) {
							if (timer !== undefined) {
								clearInterval(timer);
								timer = undefined;
							}
							process.stderr.write(
								`ink: child lease anomaly at ${ownPath} — the candidate no longer belongs to this attempt\n`,
							);
							onAnomaly();
							return;
						}
						try {
							const stamp = new Date(now());
							utimesSync(ownPath, stamp, stamp);
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
					try {
						unlinkSync(ownPath); // unique name: it is ours or gone
					} catch {
						process.stderr.write(`ink: could not remove the child lease candidate ${ownPath}\n`);
					}
					try {
						unlinkSync(path.join(leaseDir, stagingName));
					} catch {
						// best effort
					}
				},
			};
			return { ok: true, lease: handle };
		}
		return failWith("busy", "could not acquire the child lease within the retry budget");
	} catch (err) {
		return failWith("io-error", `lease acquisition failed for ${childFilePath}: ${String(err)}`);
	}
}

/**
 * Legacy single-FILE artifact migration (design §7.1): `mkdir` cannot
 * replace a file, so the artifact must be classified and, only when THIS
 * read proves it dead+aged or debris+aged, unlinked before the directory is
 * created. Live or uncertain → `busy` with no directory created.
 */
function migrateLegacyLeaseFile(config: {
	leaseDir: string;
	host: string;
	machineId: string;
	pid: number;
	nonce: string;
	now: () => number;
	isAlive: (pid: number) => boolean;
	staleGraceMs: number;
}): { ok: true } | { ok: false; code: "busy" | "owned-elsewhere"; message: string } {
	let bytes: Buffer;
	try {
		bytes = readFileSync(config.leaseDir); // ONE read decides everything
	} catch (err) {
		if (errnoCode(err) === "ENOENT" || errnoCode(err) === "EISDIR") return { ok: true };
		throw err;
	}
	let ageMs: number;
	try {
		ageMs = config.now() - statSync(config.leaseDir).mtimeMs;
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return { ok: true };
		throw err;
	}
	const existing = parsePayload(bytes);
	if (existing === undefined) {
		if (ageMs <= config.staleGraceMs) {
			return {
				ok: false,
				code: "busy",
				message: `legacy lease artifact at ${config.leaseDir} is unreadable and still fresh — refusing rather than guessing`,
			};
		}
		unlinkSync(config.leaseDir);
		return { ok: true };
	}
	if (existing.host !== config.host || existing.machineId !== config.machineId) {
		return {
			ok: false,
			code: "owned-elsewhere",
			message: `legacy lease at ${config.leaseDir} belongs to host "${existing.host}" (machine ${existing.machineId}) — shared-storage sessions across machines are not supported`,
		};
	}
	const ownLeftover = existing.pid === config.pid && existing.nonce === config.nonce;
	if (ownLeftover) {
		unlinkSync(config.leaseDir); // this process's own failed-release leftover
		return { ok: true };
	}
	if (config.isAlive(existing.pid) || ageMs <= config.staleGraceMs) {
		return {
			ok: false,
			code: "busy",
			message: `a legacy lease for this child is active or unresolved (pid ${existing.pid}, host ${existing.host}, started ${existing.startedAt})`,
		};
	}
	unlinkSync(config.leaseDir); // dead + aged generation only
	return { ok: true };
}
