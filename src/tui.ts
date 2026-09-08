/**
 * The pi-tui boundary (M9 design: "thin boundary, not a thick adapter").
 *
 * Everything pi-tui reaches only through this module. Swapping back to a
 * different transport (or vendoring the library — the documented escape
 * hatch when we first need to modify its internals) means editing this
 * file alone.
 *
 * Also hosts the minimal editor theme: identity functions, no color —
 * parity with the pre-M9 plain aesthetic. Theming is a later milestone.
 */

// Splits stdin bursts into per-key sequences (escape-aware) — the fake
// terminal reuses the production splitter so tests feed realistic chunks
// Core runtime — what the REPL shell composes with
// Test seam: production uses ProcessTerminal; tests inject a fake
// Layout math for the width contract (pi-tui's own components use these;
// its renderer THROWS on component lines wider than the terminal)
export {
	type Component,
	Container,
	Editor,
	type EditorOptions,
	type EditorTheme,
	isKeyRelease,
	matchesKey,
	ProcessTerminal,
	StdinBuffer,
	type Terminal,
	Text,
	TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** pi-tui's input-listener contract (the type itself is not exported upstream). */
export type TuiInputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

/** The pre-interception hook TUI runs before the focused component sees keys. */
export type AddInputListener = (listener: TuiInputListener) => () => void;

/** Which interactive presentation shell to use (M9). IMP_REPL=legacy keeps
 *  the pre-M9 readline path available as the documented escape hatch. */
export type ShellKind = "tui" | "legacy";

export function resolveShell(): ShellKind {
	return process.env.IMP_REPL === "legacy" ? "legacy" : "tui";
}

/**
 * The [y/N] contract, unchanged from the readline era: only an explicit
 * y/yes (case-insensitive) approves. Kept in one place for both shells.
 */
export function isYes(answer: string): boolean {
	return /^y(?:es)?$/i.test(answer.trim());
}
