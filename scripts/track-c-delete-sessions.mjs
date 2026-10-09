/** Track C §7.8 one-time deletion (test-fixture-hygiene design).
 *
 * Deletes the 3 FINISHED imp-era parent sessions + their 12 children +
 * .lease sidecars (owner decision 2026-10-09, option 1).
 *
 * Safety: dry-run by default (prints targets); --execute required;
 * refuses if ANY target was modified within the last 48h (liveness belt).
 * Parents are located by header.id read-back, NEVER filename. */
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PARENTS = [
	"0a76cdd5-f943-42df-84ac-9e20836b98d2",
	"13fc2fa3-4684-44bb-82bd-5f69c9fe41b5",
	"9e7ba78e-c604-4715-b9bc-f465a8c41bfd",
];
const SESSIONS_ROOT = join(homedir(), ".ink", "sessions");
const FRESHNESS_LIMIT_MS = 48 * 60 * 60 * 1000;
const execute = process.argv.includes("--execute");

function headerId(file) {
	try {
		const first = readFileSync(file, "utf8").split("\n")[0];
		return JSON.parse(first).id ?? null;
	} catch {
		return null;
	}
}
function parentSessionId(file) {
	try {
		const first = readFileSync(file, "utf8").split("\n")[0];
		return JSON.parse(first).launch?.parentSessionId ?? null;
	} catch {
		return null;
	}
}

const targets = [];
for (const dirName of readdirSync(SESSIONS_ROOT)) {
	const dir = join(SESSIONS_ROOT, dirName);
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		continue;
	}
	for (const name of entries.filter((n) => n.endsWith(".jsonl"))) {
		const file = join(dir, name);
		if (PARENTS.includes(headerId(file))) targets.push(file);
	}
	const childrenDir = join(dir, "children");
	let children;
	try {
		children = readdirSync(childrenDir);
	} catch {
		continue;
	}
	for (const name of children.filter((n) => n.endsWith(".jsonl"))) {
		const file = join(childrenDir, name);
		if (PARENTS.includes(parentSessionId(file))) targets.push(file);
	}
}
const parentsFound = targets.filter((t) => !t.includes(`${join("", "children")}`));
console.log(`targets: ${targets.length} files (${parentsFound.length} parents expected 3)`);
if (targets.length === 0) {
	console.log("nothing to delete — already cleaned?");
	process.exit(0);
}
const now = Date.now();
let fresh = 0;
for (const t of targets) {
	const mtime = statSync(t).mtimeMs;
	const ageH = ((now - mtime) / 3600000).toFixed(1);
	const isFresh = now - mtime < FRESHNESS_LIMIT_MS;
	if (isFresh) fresh++;
	console.log(`  ${isFresh ? "FRESH!" : "ok"} ${ageH}h  ${t}`);
}
if (fresh > 0) {
	console.error(`REFUSING: ${fresh} target(s) modified within 48h`);
	process.exit(1);
}
if (!execute) {
	console.log("dry-run only — re-run with --execute");
	process.exit(0);
}
for (const t of targets) {
	rmSync(t, { force: true });
	rmSync(`${t}.lease`, { force: true, recursive: true });
}
console.log(`deleted ${targets.length} files (+ sidecars)`);
