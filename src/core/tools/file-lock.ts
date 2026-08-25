import { realpathSync } from "node:fs";

/**
 * Serialize mutations targeting the same file (inspired by pi's
 * file-mutation-queue). Today the agent loop runs tools sequentially, so this
 * is belt-and-suspenders; it becomes load-bearing the day we execute tool
 * calls in parallel.
 *
 * The registration section below must stay SYNCHRONOUS: with an await before
 * `queues.set`, concurrent callers register in completion order (realpath
 * latency), not call order — a real bug pi solves with a registration chain.
 * realpathSync keeps call order == queue order in one synchronous block.
 */
const queues = new Map<string, Promise<void>>();

export async function withFileLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
	// Canonicalize when possible so aliases of the same file share a queue.
	let key = absolutePath;
	try {
		key = realpathSync(absolutePath);
	} catch {
		// Not there yet (create) — the absolute path is a fine key.
	}

	const current = queues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = current.then(() => next);
	queues.set(key, chained);

	await current;
	try {
		return await fn();
	} finally {
		release();
		// Drop the queue entry if nobody chained onto us (keeps the map small).
		if (queues.get(key) === chained) {
			Promise.resolve(chained).then(() => {
				if (queues.get(key) === chained) queues.delete(key);
			});
		}
	}
}
