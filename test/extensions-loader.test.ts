import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extensionBannerLines,
	type LoadExtensionsOptions,
	type LoadedExtensions,
	loadExtensions,
	printExtensionDiagnostics,
} from "../src/extensions/loader.js";
import { writeExtensionFiles } from "./helpers/fakes.js";

/** A minimal valid fixture factory registering one named tool. */
const toolFixture = (name: string): string => `export default function (api) {
	api.registerTool({
		name: "${name}",
		description: "fixture tool ${name}",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "${name}" };
		},
	});
}
`;

interface Env {
	cwd: string;
	home: string;
}

async function setup(): Promise<Env> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-extload-"));
	// Neither dir needs to exist yet: writeExtensionFiles creates them on
	// demand, and loadExtensions skips missing discovery dirs silently.
	return { cwd: path.join(baseDir, "proj"), home: path.join(baseDir, "home") };
}

interface LoadResult {
	loaded: LoadedExtensions;
	lines: string[];
}

async function load(env: Env, options: Partial<LoadExtensionsOptions> = {}): Promise<LoadResult> {
	const lines: string[] = [];
	const loaded = await loadExtensions({
		cwd: env.cwd,
		cliPaths: options.cliPaths ?? [],
		noDiscovery: options.noDiscovery,
		home: options.home ?? env.home,
		onDiagnostic: (line) => lines.push(line),
		confirm: options.confirm,
	});
	return { loaded, lines };
}

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("extension discovery (design §3)", () => {
	it("case 1: direct .mjs files load; dotfiles and _-prefixed files are skipped; dir/index.mjs is an entry; code-point sort is deterministic", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, {
			"beta.mjs": toolFixture("beta_tool"),
			"Alpha.mjs": toolFixture("alpha_tool"),
			"_skipme.mjs": toolFixture("skipped_tool"),
			".hidden.mjs": toolFixture("hidden_tool"),
			"sub/index.mjs": toolFixture("sub_tool"),
		});
		const { loaded, lines } = await load(env);
		expect(lines).toEqual([]);
		expect(loaded.failures).toEqual([]);
		// code-point order: "Alpha.mjs" (0x41) < "beta.mjs" (0x62) < "sub" (0x73)
		expect(loaded.summaries.map((s) => s.name)).toEqual(["Alpha", "beta", "sub"]);
		expect(loaded.runtime.tools.map((t) => t.name)).toEqual(["alpha_tool", "beta_tool", "sub_tool"]);
		for (const summary of loaded.summaries) {
			expect(summary.origin).toBe("project");
		}
	});

	it("case 2: origin labels are cli/project/global; a -e path that also sits in a discovery dir loads once, keeping its first origin", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, { "proj.mjs": toolFixture("proj_tool") });
		await writeExtensionFiles(env.home, { "glob.mjs": toolFixture("glob_tool") });
		const { loaded, lines } = await load(env, {
			cliPaths: [path.join(env.cwd, ".imp", "extensions", "proj.mjs")],
		});
		expect(lines).toEqual([]);
		expect(loaded.summaries.map((s) => `${s.name}:${s.origin}`)).toEqual(["proj:cli", "glob:global"]);
		expect(loaded.runtime.tools.map((t) => t.name)).toEqual(["proj_tool", "glob_tool"]);
	});

	it("case 2 (realpath): a symlinked entry dedups against its target across sources", async () => {
		const env = await setup();
		await writeExtensionFiles(env.home, { "real.mjs": toolFixture("real_tool") });
		const projDir = path.join(env.cwd, ".imp", "extensions");
		mkdirSync(projDir, { recursive: true });
		symlinkSync(path.join(env.home, ".imp", "extensions", "real.mjs"), path.join(projDir, "link.mjs"));
		const { loaded, lines } = await load(env);
		expect(lines).toEqual([]);
		expect(loaded.summaries.map((s) => `${s.name}:${s.origin}`)).toEqual(["link:project"]);
		expect(loaded.runtime.tools).toHaveLength(1);
	});
});

describe("extension load isolation (design §7)", () => {
	it("case 3 (E1): a syntax-error module reports a teaching line and is discarded; .mjs gets no rename hint", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, {
			"broken.mjs": "export default function (api) {\n\tthis is not valid js\n",
		});
		const { loaded, lines } = await load(env);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^imp: extension broken failed to load — /);
		expect(lines[0]).not.toContain("hint:");
		expect(loaded.summaries).toEqual([]);
		expect(loaded.runtime.tools).toEqual([]);
		expect(loaded.failures[0]?.path).toContain("broken.mjs");
		expect(loaded.failures[0]?.error.length).toBeLessThanOrEqual(160);
	});

	it("case 3 (E2): a .js entry whose import fails gets the rename hint appended", async () => {
		const env = await setup();
		// Node >= 22 auto-detects ESM syntax in bare .js files, so a genuine
		// import failure is what triggers E1 — and any .js failure appends the hint.
		await writeExtensionFiles(env.cwd, {
			"legacy.js": "export default function (api) {\n\tthis is not valid js\n",
		});
		const { loaded, lines } = await load(env);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^imp: extension legacy failed to load — /);
		expect(lines[0]).toContain(
			'hint: bare ".js" files without a module-typed package.json are CommonJS to Node — rename to ".mjs" or add package.json {"type":"module"}',
		);
		expect(loaded.failures).toHaveLength(1);
	});

	it("case 3 (E3): default export not a function — exact strings for both flavors", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, {
			"noexport.mjs": "export const x = 1;\n",
			// a CommonJS .js imports fine (its module.exports becomes a non-function
			// default) — the realistic modern outcome for legacy .js extensions
			"cjs.js": "module.exports = { hello: 1 };\n",
		});
		const { lines } = await load(env);
		expect(lines).toEqual([
			"imp: extension cjs failed to load — default export must be a function, got object",
			"imp: extension noexport failed to load — default export must be a function, got undefined",
		]);
	});

	it("case 3 (E4): a throwing factory discards the extension atomically; the good one beside it loads fully", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, {
			"bad.mjs": `export default function (api) {
	api.registerTool({
		name: "dies_with_factory",
		description: "registered before the throw",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "never" };
		},
	});
	throw new Error("factory exploded");
}
`,
			"good.mjs": toolFixture("good_tool"),
		});
		const { loaded, lines } = await load(env);
		expect(lines).toEqual(["imp: extension bad failed to load — factory exploded"]);
		expect(loaded.summaries.map((s) => s.name)).toEqual(["good"]);
		expect(loaded.runtime.tools.map((t) => t.name)).toEqual(["good_tool"]); // atomic discard
		expect(loaded.failures[0]?.error).toBe("factory exploded");
	});
});

describe("-ne / --no-extensions (design §3.1)", () => {
	it("case 15: skips both discovery dirs but keeps explicit -e paths", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, { "disc.mjs": toolFixture("disc_tool") });
		await writeExtensionFiles(env.home, { "gdisc.mjs": toolFixture("gdisc_tool") });
		const explicitDir = await mkdtemp(path.join(tmpdir(), "imp-ext-cli-"));
		const explicit = path.join(explicitDir, "explicit.mjs");
		writeFileSync(explicit, toolFixture("explicit_tool"));
		const { loaded, lines } = await load(env, { cliPaths: [explicit], noDiscovery: true });
		expect(lines).toEqual([]);
		expect(loaded.summaries.map((s) => `${s.name}:${s.origin}`)).toEqual(["explicit:cli"]);
		expect(loaded.runtime.tools.map((t) => t.name)).toEqual(["explicit_tool"]);
	});

	it("case 15: -e accepts a directory and applies the same entry rules", async () => {
		const env = await setup();
		const extra = await mkdtemp(path.join(tmpdir(), "imp-ext-dir-"));
		writeFileSync(path.join(extra, "z.mjs"), toolFixture("z_tool"));
		writeFileSync(path.join(extra, "_ignored.mjs"), toolFixture("ignored_tool"));
		const { loaded, lines } = await load(env, { cliPaths: [extra], noDiscovery: true });
		expect(lines).toEqual([]);
		expect(loaded.runtime.tools.map((t) => t.name)).toEqual(["z_tool"]);
	});
});

describe("startup banner (design §7.3)", () => {
	it("zero extensions anywhere → silence: empty summaries print nothing", async () => {
		const env = await setup();
		const { loaded, lines } = await load(env);
		expect(loaded.summaries).toEqual([]);
		expect(loaded.failures).toEqual([]);
		expect(lines).toEqual([]);
		const banner: string[] = [];
		printExtensionDiagnostics(loaded.summaries, (line) => banner.push(line));
		expect(banner).toEqual([]);
	});

	it("counts every category, pluralized, omitting zero categories; an empty factory says so", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, {
			"kitchen.mjs": `export default function (api) {
	api.registerTool({
		name: "k_tool",
		description: "one tool",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "k" };
		},
	});
	api.registerCommand({
		name: "kcmd",
		summary: "one command",
		allowedDuringRun: true,
		run() {
			return "handled";
		},
	});
	api.registerContext("kctx", "one context");
	api.on("tool_end", () => {});
}
`,
			"empty.mjs": "export default function () {}\n",
		});
		const { loaded, lines } = await load(env);
		expect(lines).toEqual([]);
		const banner: string[] = [];
		printExtensionDiagnostics(loaded.summaries, (line) => banner.push(line));
		expect(banner).toEqual([
			"▪ extension empty [project] — no registrations",
			"▪ extension kitchen [project] — 1 tool, 1 command, 1 context, 1 hook",
		]);
		expect(extensionBannerLines(loaded.summaries)).toEqual(banner);
	});
});

describe("api.confirm wiring (spec part 2)", () => {
	/** A gate that runs api.confirm at runtime — mid-run, long after the factory window closed. */
	const askerFixture = `export default function (api) {
	api.on("tool_call", async (event) => {
		if (event.name !== "ask_tool") return;
		const ok = await api.confirm("run ask_tool?", "the detail line");
		return ok ? undefined : { block: true, reason: "declined by the fake host" };
	});
}
`;

	it("confirm is live at runtime (not factory-window-gated): the injected handler answers and the gate obeys", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, { "asker.mjs": askerFixture });
		const asks: Array<{ message: string; detail?: string }> = [];
		const { loaded } = await load(env, {
			confirm: async (message, detail) => {
				asks.push({ message, detail });
				return message === "run ask_tool?";
			},
		});
		const call = { type: "tool_call", toolCallId: "t1", name: "ask_tool", args: {}, cwd: env.cwd } as const;
		await expect(loaded.runtime.emitToolCall(call)).resolves.toBeUndefined(); // approved → allow
		await expect(loaded.runtime.emitToolCall({ ...call, name: "other" })).resolves.toBeUndefined(); // not gated
		expect(asks).toEqual([{ message: "run ask_tool?", detail: "the detail line" }]);
	});

	it("without a handler the same extension gets false and blocks — print-mode degradation, no hang", async () => {
		const env = await setup();
		await writeExtensionFiles(env.cwd, { "asker.mjs": askerFixture });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const { loaded } = await load(env);
			const decision = await Promise.race([
				loaded.runtime.emitToolCall({
					type: "tool_call",
					toolCallId: "t1",
					name: "ask_tool",
					args: {},
					cwd: env.cwd,
				}),
				new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
			]);
			expect(decision).toEqual({ block: true, reason: "declined by the fake host" });
			expect(stderr).toHaveBeenCalledTimes(1);
		} finally {
			stderr.mockRestore();
		}
	});
});
