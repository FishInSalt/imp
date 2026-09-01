// examples/extensions/notes.mjs — the imp extension API tour (M4 design §13.2).
//
// Install: copy this file into <project>/.imp/extensions/ (or ~/.imp/extensions/)
// and restart imp. A startup line confirms it loaded:
//
//   ▪ extension notes [project] — 1 tool, 1 command, 1 context
//
// Contract: an extension is a plain ESM module whose default export is a
// factory receiving one thin `api` object. Register everything inside the
// factory; do not read stdin directly (it would fight the REPL's readline);
// there is no dispose — process exit cleans up.
//
// In M4a the tool is fully live; the command dispatches and the context
// section injects from M4b/M4c respectively (registrations are stored and
// counted in the banner from day one).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	const file = path.join(api.cwd, ".imp", "notes.json");

	/** @returns {{ notes: string[] }} */
	const load = () => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return { notes: [] };
		}
	};
	const save = (notes) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(notes, null, "\t")}\n`, "utf8");
	};
	const add = (text) => {
		const notes = load();
		notes.notes.push(text);
		save(notes);
		return notes.notes.length;
	};

	// 1/4 — a tool the model can call (TypeBox-shaped plain JSON Schema).
	api.registerTool({
		name: "notes",
		description:
			"Save a note to the project's shared notes file, or read all notes back. " +
			'Prefer this over creating reminder files: {"action":"set","text":"..."} / {"action":"get"}.',
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["set", "get"], description: "set saves, get reads" },
				text: { type: "string", description: "the note text (required for set)" },
			},
			required: ["action"],
		},
		async execute(args) {
			if (args.action === "get") {
				const notes = load();
				return {
					output: notes.notes.length > 0 ? notes.notes.join("\n") : "(no notes yet)",
				};
			}
			if (typeof args.text !== "string" || args.text.trim() === "") {
				return {
					output: 'action "set" needs a non-empty text — e.g. {"action":"set","text":"ship it"}',
					isError: true,
				};
			}
			const total = add(args.text.trim());
			return { output: `saved (${total} total): ${args.text.trim()}` };
		},
	});

	// 2/4 — a slash command (stored in M4a, dispatched from M4b).
	/** @type {import("../../src/repl/commands.js").SlashCommand} */
	const command = {
		name: "notes",
		summary: "save a note without spending a model turn",
		allowedDuringRun: true, // writes one file and prints one ▪ line, nothing else
		run(args, ctx) {
			if (args.trim() === "") {
				const notes = load();
				ctx.renderer.note(
					notes.notes.length > 0 ? `▪ notes: ${notes.notes.join(" | ")}` : "▪ notes: (none yet)",
				);
				return "handled";
			}
			const total = add(args.trim());
			ctx.renderer.note(`▪ note saved (${total} total)`);
			return "handled";
		},
	};
	api.registerCommand(command);

	// 3/4 — a static system-prompt section (stored in M4a, injected from M4c).
	api.registerContext(
		"notes",
		"A notes tool (action set/get) and a /notes command exist. Prefer them over creating files for reminders.",
	);

	// 4/4 — an event subscription (stored in M4a, fired from M4c). The tour
	// stops at one: a tiny audit trail of tool errors.
	api.on("tool_end", (event) => {
		if (event.isError) {
			try {
				add(`[audit] ${event.name} failed`);
			} catch {
				// never let an observer break the host
			}
		}
	});
}
