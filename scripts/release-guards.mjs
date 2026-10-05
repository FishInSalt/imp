import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertNpmVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	if (!match) throw new Error(`Unsupported npm version: ${version}`);
	const actual = match.slice(1).map(Number);
	const minimum = [11, 5, 1];
	for (let i = 0; i < minimum.length; i++) {
		if (actual[i] > minimum[i]) return;
		if (actual[i] < minimum[i]) throw new Error(`npm ${version} is too old; need >=11.5.1`);
	}
}

export function assertIdentity(pkg, lock, appVersion) {
	if (pkg.name === "imp-agent" || pkg.name === "ink" || pkg.name !== "ink-agent") {
		throw new Error(`Refusing release package ${pkg.name}; expected ink-agent`);
	}
	if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version === "0.1.0") {
		throw new Error(`Invalid Ink release version ${pkg.version}`);
	}
	const root = lock.packages?.[""];
	if (
		lock.name !== pkg.name ||
		root?.name !== pkg.name ||
		lock.version !== pkg.version ||
		root.version !== pkg.version ||
		appVersion !== pkg.version
	)
		throw new Error("Package, lockfile and app release identity disagree");
	for (const bin of [pkg.bin, root.bin]) {
		if (!bin || Object.keys(bin).length !== 1 || bin.ink !== "bin/ink.js") {
			throw new Error("Ink must have exactly one bin: ink -> bin/ink.js");
		}
	}
}

export function releaseDecision({ pkg, lock, appVersion, event, ref, enabled, configuredPackage }) {
	assertIdentity(pkg, lock, appVersion);
	if (ref?.startsWith("refs/tags/")) {
		if (ref !== `refs/tags/v${pkg.version}`) throw new Error("Tag does not match release version");
	}
	// Compatibility input dry_run and the legacy NPM_PUBLISH_ENABLED gate are
	// intentionally irrelevant: dispatch can NEVER reach ordinary publication.
	if (event === "workflow_dispatch") return "dryrun";
	if (event !== "push" || !ref?.startsWith("refs/tags/")) return "skip";
	return enabled === "true" && configuredPackage === pkg.name ? "publish" : "skip";
}

function readIdentity(root) {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
	const format = readFileSync(resolve(root, "src/format.ts"), "utf8");
	const appVersion = /export const VERSION\s*=\s*["']([^"']+)["']/.exec(format)?.[1];
	return { pkg, lock, appVersion };
}

function main() {
	const [command, argument] = process.argv.slice(2);
	if (command === "npm-version") {
		assertNpmVersion(argument ?? "");
		console.log(`npm ${argument} satisfies >=11.5.1`);
	} else if (command === "evaluate") {
		// Pure JSON interface for offline regression tests; never publishes.
		console.log(releaseDecision(JSON.parse(readFileSync(0, "utf8"))));
	} else if (command === "identity" || command === "plan") {
		const identity = readIdentity(argument ?? process.cwd());
		assertIdentity(identity.pkg, identity.lock, identity.appVersion);
		if (command === "identity") {
			console.log(`${identity.pkg.name}@${identity.pkg.version}: identity verified`);
			return;
		}
		const mode = releaseDecision({
			...identity,
			event: process.env.GITHUB_EVENT_NAME,
			ref: process.env.GITHUB_REF,
			enabled: process.env.INK_NPM_PUBLISH_ENABLED,
			configuredPackage: process.env.INK_NPM_PACKAGE,
		});
		console.log(`mode=${mode}\npackage=${identity.pkg.name}\nversion=${identity.pkg.version}`);
	} else {
		throw new Error("Usage: release-guards.mjs identity|plan [root] | npm-version VERSION | evaluate");
	}
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
