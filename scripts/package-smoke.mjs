import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { assertIdentity } from "./release-guards.mjs";

const required = ["package.json", "README.md", "LICENSE", "bin/ink.js", "dist/cli.js", "docs/index.md"];
const allowed =
	/^(?:package\.json|README(?:\.zh-CN)?\.md|LICENSE|CHANGELOG\.md|bin\/ink\.js|docs\/[a-z0-9-]+\.md|examples\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+|dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.js(?:\.map)?|\.d\.ts))$/;

function expectedFiles(root) {
	const paths = new Set(required);
	const visit = (directory, relative = "") => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) visit(join(directory, entry.name), name);
			else if (entry.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) {
				const stem = name.slice(0, -3);
				for (const suffix of [".js", ".js.map", ".d.ts"]) paths.add(`dist/${stem}${suffix}`);
			}
		}
	};
	// Editor/Finder noise that npm's gitignore-aware packer excludes —
	// collecting them would make the "Missing build output" assertion fail
	// on developer machines (implementation review N5).
	const NOISE = /^\.DS_Store$|^Thumbs\.db$|(^|\/)node_modules\//;
	const collect = (directory, relative = "") => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) collect(join(directory, entry.name), name);
			else if (entry.isFile() && !NOISE.test(name)) paths.add(name);
		}
	};
	const collectTop = (directory, prefix) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isFile() && !NOISE.test(entry.name)) paths.add(`${prefix}/${entry.name}`);
		}
	};
	visit(join(root, "src"));
	// npm packs every root README* automatically regardless of the files
	// field — README.zh-CN.md ships by npm's own rule, so expected paths
	// include it explicitly (readme-zh batch).
	paths.add("README.zh-CN.md");
	// Self-docs: publish docs/ top level only (design/ excluded, mirroring
	// the package.json files entry `!docs/design`) and the examples/ tree.
	collectTop(join(root, "docs"), "docs");
	paths.add("CHANGELOG.md");
	collect(join(root, "examples"), "examples");
	return paths;
}

export function validateFiles(files, permittedPaths) {
	assert(Array.isArray(files) && files.length > 0, "Empty pack file list");
	const names = new Set();
	for (const file of files) {
		assert(
			allowed.test(file.path) && (!permittedPaths || permittedPaths.has(file.path)),
			`Unexpected packed path: ${file.path}`,
		);
		assert(!names.has(file.path), `Duplicate packed path: ${file.path}`);
		names.add(file.path);
		const mode = file.path === "bin/ink.js" ? 0o755 : 0o644;
		assert.equal(file.mode, mode, `Unexpected mode for ${file.path}`);
		assert(Number.isInteger(file.size) && file.size > 0, `Empty/invalid packed file: ${file.path}`);
	}
	for (const name of required) assert(names.has(name), `Missing packed file: ${name}`);
}

function tarNumber(header, start, length, label, optional = false) {
	// npm pack emits ASCII octal, not base-256. Never allow parseInt to accept
	// a valid prefix followed by invalid digits, signs or hidden suffix bytes.
	const raw = header.subarray(start, start + length).toString("latin1");
	if (optional && /^[ \0]*$/.test(raw)) return 0;
	const match = /^ *([0-7]+)[ \0]*$/.exec(raw);
	assert(match, `Invalid tar ${label}`);
	const value = Number.parseInt(match[1], 8);
	assert(Number.isSafeInteger(value) && value >= 0, `Invalid tar ${label}`);
	return value;
}

function tarString(header, start, length, label) {
	const raw = header.subarray(start, start + length);
	const end = raw.indexOf(0);
	const text = raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
	assert(/^[\x20-\x7e]*$/.test(text), `Invalid tar ${label}`);
	if (end !== -1) assert(raw.subarray(end).every((byte) => byte === 0), `Invalid tar ${label} padding`);
	return text;
}

// Validate the COMPLETE uncompressed stream before npm can extract it. A
// single zero block is not a safe stopping point: npm may parse later entries.
// Only regular POSIX ustar files in our intentional allowlist are accepted.
export function parseTar(tar, permittedPaths) {
	assert(
		Buffer.isBuffer(tar) && tar.length >= 1024 && tar.length % 512 === 0,
		"Truncated or unaligned tar archive",
	);
	const files = [];
	let offset = 0;
	let terminated = false;
	while (offset < tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			assert(tar.length - offset >= 1024, "Tar requires two zero end blocks");
			assert(tar.subarray(offset).every((byte) => byte === 0), "Nonzero bytes after tar end marker");
			terminated = true;
			break;
		}
		const checksum = tarNumber(header, 148, 8, "checksum");
		let sum = 8 * 0x20;
		for (let i = 0; i < 512; i++) if (i < 148 || i >= 156) sum += header[i];
		assert.equal(checksum, sum, "Invalid tar header checksum");
		assert.equal(
			header.subarray(257, 265).toString("latin1"),
			"ustar\u000000",
			"Unsupported tar header format",
		);
		const name = tarString(header, 0, 100, "path");
		assert(name.startsWith("package/"), `Unexpected tar root: ${name}`);
		assert(header[156] === 0 || header[156] === 48, `Non-regular tar entry: ${name}`);
		assert(!tarString(header, 157, 100, "link path"), "Unexpected tar link path");
		tarString(header, 265, 32, "owner");
		tarString(header, 297, 32, "group");
		assert(header.subarray(345).every((byte) => byte === 0), "Unexpected tar prefix or extension bytes");
		const mode = tarNumber(header, 100, 8, "mode");
		const size = tarNumber(header, 124, 12, "size");
		tarNumber(header, 136, 12, "mtime");
		// npm omits owner IDs; empty optional fields mean zero, not unchecked bytes.
		for (const [start, length, label] of [
			[108, 8, "uid"],
			[116, 8, "gid"],
			[329, 8, "device major"],
			[337, 8, "device minor"],
		]) tarNumber(header, start, length, label, true);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
		assert(Number.isSafeInteger(paddedEnd) && paddedEnd <= tar.length, "Truncated tar file data or padding");
		assert(tar.subarray(dataEnd, paddedEnd).every((byte) => byte === 0), "Nonzero tar file padding");
		files.push({ path: name.slice(8), size, mode, data: tar.subarray(dataStart, dataEnd) });
		offset = paddedEnd;
	}
	assert(terminated, "Missing tar end markers");
	validateFiles(files, permittedPaths);
	return files;
}

function inspectTar(filename, permittedPaths) {
	return parseTar(gunzipSync(readFileSync(filename)), permittedPaths);
}

export function assertVersionOutput(output, version) {
	assert.equal(output, `Ink ${version}\n`, "Unexpected CLI version output");
}

function npmCliPath() {
	if (process.env.npm_execpath) return realpathSync(process.env.npm_execpath);
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, "npm");
		if (existsSync(candidate)) return realpathSync(candidate);
	}
	throw new Error("Cannot locate npm CLI");
}

// Seed only the production dependency entries, reading the existing cache
// without modifying it. Do not copy npmrc, request auth headers or credentials.
async function seedCache(source, destination, lock, npmCli) {
	if (!source) return;
	const require = createRequire(npmCli);
	const cacache = require("cacache");
	const entries = await cacache.ls(join(source, "_cacache"));
	const urls = new Set();
	const manifests = new Map();
	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path || pkg.dev) continue;
		assert(pkg.resolved?.startsWith("https://registry.npmjs.org/"), `Unexpected dependency URL: ${path}`);
		urls.add(pkg.resolved);
		const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
		const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
		const manifest = manifests.get(url) ?? { name, "dist-tags": {}, versions: {} };
		manifest["dist-tags"].latest = pkg.version;
		manifest.versions[pkg.version] = {
			...pkg,
			name,
			dist: { tarball: pkg.resolved, integrity: pkg.integrity },
		};
		manifests.set(url, manifest);
	}
	for (const [key, info] of Object.entries(entries)) {
		if (!urls.has(info.metadata?.url)) continue;
		const { data } = await cacache.get(join(source, "_cacache"), key);
		const resHeaders = {};
		for (const header of ["content-type", "cache-control", "date", "last-modified", "etag", "vary"]) {
			if (info.metadata.resHeaders?.[header]) resHeaders[header] = info.metadata.resHeaders[header];
		}
		await cacache.put(join(destination, "_cacache"), key, data, {
			metadata: {
				time: info.metadata.time,
				url: info.metadata.url,
				reqHeaders: { accept: "*/*" },
				resHeaders,
				options: { compress: true },
			},
		});
	}
	// npm ci can cache tarballs without packuments. Supply a controlled,
	// lockfile-pinned offline registry fixture instead of relying on mutable
	// latest metadata or fetching manifests. The installed bytes still come
	// from npm's integrity-checked original dependency tarballs.
	for (const [url, manifest] of manifests) {
		for (const accept of [
			"application/json",
			"application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
		]) {
			await cacache.put(
				join(destination, "_cacache"),
				`make-fetch-happen:request-cache:${url}`,
				JSON.stringify(manifest),
				{
					metadata: {
						time: Date.now(),
						url,
						reqHeaders: { accept },
						options: { compress: true },
						resHeaders: {
							"content-type": "application/json",
							vary: "accept",
							"cache-control": "public, max-age=31536000",
							date: new Date().toUTCString(),
						},
					},
				},
			);
		}
	}
}

async function smoke() {
	const args = process.argv.slice(2);
	assert(
		args.length === 0 || (args.length === 2 && args[0] === "--cache-source"),
		"Usage: package-smoke.mjs [--cache-source READ_ONLY_NPM_CACHE]",
	);
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	const appVersion = /export const VERSION\s*=\s*["']([^"']+)["']/.exec(
		readFileSync(join(root, "src/format.ts"), "utf8"),
	)?.[1];
	assertIdentity(pkg, lock, appVersion);
	assert(existsSync(join(root, "dist/cli.js")), "Build dist before running artifact smoke");
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ink-package-smoke-")));
	chmodSync(scratch, 0o700);
	const paths = Object.fromEntries(
		["home", "cache", "prefix", "neutral", "artifacts"].map((key) => {
			const path = join(scratch, key);
			mkdirSync(path, { mode: 0o700 });
			return [key, path];
		}),
	);
	console.log(`Isolated artifact smoke: ${scratch}`);
	const npmCli = npmCliPath();
	await seedCache(args[1] ? resolve(args[1]) : undefined, paths.cache, lock, npmCli);
	const networkGuard = join(scratch, "no-network.cjs");
	const networkLog = join(scratch, "blocked-network.log");
	writeFileSync(
		networkGuard,
		`
const deny = () => {
	require("node:fs").appendFileSync(${JSON.stringify(networkLog)}, new Error("Blocked network attempt").stack + "\\n");
	throw new Error("Artifact smoke attempted network access");
};
require("node:net").Socket.prototype.connect = deny;
require("node:tls").connect = deny;
require("node:dns").lookup = deny;
globalThis.fetch = deny;
`,
		{ mode: 0o600 },
	);
	const env = {
		PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: paths.home,
		USERPROFILE: paths.home,
		TMPDIR: scratch,
		TMP: scratch,
		TEMP: scratch,
		XDG_CONFIG_HOME: join(paths.home, "config"),
		XDG_CACHE_HOME: join(paths.home, "cache"),
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		NODE_OPTIONS: `--require=${JSON.stringify(networkGuard)}`,
		npm_config_cache: paths.cache,
		npm_config_prefix: paths.prefix,
		npm_config_userconfig: join(scratch, "empty.npmrc"),
		npm_config_globalconfig: join(scratch, "empty-global.npmrc"),
		npm_config_offline: "true",
		npm_config_ignore_scripts: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
		INK_AUTH_PATH: join(paths.home, "auth.json"),
		INK_SETTINGS_PATH: join(paths.home, "settings.json"),
		INK_CATALOG_PATH: join(paths.home, "catalog.json"),
		INK_MODEL: "anthropic/fixture-model",
		INK_MCP: "0",
		INK_LOG: "0",
	};
	writeFileSync(env.npm_config_userconfig, "", { mode: 0o600 });
	writeFileSync(env.npm_config_globalconfig, "", { mode: 0o600 });
	const run = (executable, argv) => {
		const result = spawnSync(executable, argv, {
			cwd: paths.neutral,
			env,
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 10 * 1024 * 1024,
		});
		assert.equal(
			result.status,
			0,
			`${executable} ${argv.join(" ")} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}\nOffline only: seed a cache; no network fallback is permitted.`,
		);
		assert(!existsSync(networkLog), "Artifact smoke attempted blocked network access");
		return result.stdout;
	};
	const npm = (...argv) => run(process.execPath, [npmCli, ...argv]);
	const reports = JSON.parse(
		npm("pack", root, "--json", "--ignore-scripts", "--pack-destination", paths.artifacts),
	);
	assert(Array.isArray(reports) && reports.length === 1, "Expected exactly one npm pack artifact");
	const report = reports[0];
	assert.equal(report.name, pkg.name);
	assert.equal(report.version, pkg.version);
	assert(
		typeof report.filename === "string" &&
			basename(report.filename) === report.filename &&
			report.filename.endsWith(".tgz"),
		"Unsafe artifact filename",
	);
	const permittedPaths = expectedFiles(root);
	validateFiles(report.files, permittedPaths);
	const artifact = join(paths.artifacts, report.filename);
	const files = inspectTar(artifact, permittedPaths);
	for (const path of permittedPaths)
		assert(
			files.some((file) => file.path === path),
			`Missing build output: ${path}`,
		);
	for (const packed of report.files) {
		const actual = files.find((file) => file.path === packed.path);
		assert(
			actual && actual.size === packed.size && actual.mode === packed.mode,
			`Pack report mismatch: ${packed.path}`,
		);
	}
	assert.equal(files.length, report.files.length);
	const metadata = JSON.parse(files.find((file) => file.path === "package.json").data.toString());
	assert.deepEqual(metadata, pkg, "Packed metadata differs from source");
	assert(
		files
			.find((file) => file.path === "bin/ink.js")
			.data.toString()
			.startsWith("#!/usr/bin/env node\n"),
		"Missing Node shebang",
	);
	// A local prefix install, never a global install or a shared node_modules write.
	npm(
		"install",
		"--prefix",
		paths.prefix,
		"--offline",
		"--ignore-scripts",
		"--omit=dev",
		"--no-package-lock",
		artifact,
	);
	const installation = join(paths.prefix, "node_modules", pkg.name);
	assert(!existsSync(join(installation, ".env")), "Installed artifact contains dotenv");
	const bin = join(paths.prefix, "node_modules/.bin/ink");
	assert.equal(realpathSync(bin), join(installation, "bin/ink.js"));
	assert(!existsSync(join(paths.prefix, "node_modules/.bin/imp")), "Old executable alias installed");
	assertVersionOutput(run(bin, ["--version"]), pkg.version);
	assert.match(run(bin, ["--help"]), /Usage:\s+ink /);
	// No explicit command: npm must infer the single bin from this local tarball.
	// Neutral cwd has no project node_modules; offline forbids fetching plain ink.
	assertVersionOutput(
		npm("exec", "--prefix", paths.neutral, "--offline", "--yes", "--", `file:${artifact}`, "--version"),
		pkg.version,
	);
	console.log(
		`${pkg.name}@${pkg.version}: ${files.length} allowed files; modes, isolated install, help/version and local npm-exec inference passed`,
	);
	console.log(`Artifact: ${artifact}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] === "inspect-report") {
			const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
			validateFiles(JSON.parse(readFileSync(0, "utf8")), expectedFiles(root));
		} else if (process.argv[2] === "inspect-tar") {
			const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
			const files = parseTar(readFileSync(0), expectedFiles(root));
			console.log(JSON.stringify(files.map(({ path, mode, size }) => ({ path, mode, size }))));
		} else if (process.argv[2] === "inspect-version") {
			assertVersionOutput(readFileSync(0, "utf8"), process.argv[3]);
		} else await smoke();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
