import { loadApiKey } from "./auth-store.js";
import { LOGIN_TARGETS } from "./login-targets.js";
import { configuredFamilies } from "./model-availability.js";
import type { ProviderName } from "./resolve.js";

/**
 * #startup-model-resolution (design docs/startup-model-resolution-design.md):
 * resolving a USABLE startup model when nobody configured one.
 *
 * The problem: the hardcoded builtin default (`claude-sonnet-4-5`, family
 * anthropic) is unusable on a machine whose credentials belong to another
 * family, so every new session demanded a manual /model. D2 resolves that
 * state — but only when the intent is unambiguous (D1) and only when the
 * model came from the builtin rung (P5: explicit sources are never
 * overridden). Results are never written to settings and never marked as a
 * user pick (P4).
 *
 * Pure decision logic lives here (unit-testable without the CLI); the CLI
 * wires it to `modelAvailability` probes and the renderer, the runner owns
 * the D3 restore-path variant.
 */

/** Which rung of the startup chain produced the requested model. */
export type ModelSource = "cli" | "env" | "project" | "global" | "builtin";

/**
 * D1: credential-SOURCE families — the uniqueness input for resolution.
 *
 * `familyConfigured` reports families, but one credential source can mark
 * two families: `moonshotai` and `moonshotai-cn` both read
 * `MOONSHOT_API_KEY` (provider/moonshotai.ts), so an env-only moonshot
 * setup reports TWO configured families from one credential. Rules:
 *   - a STORED key is family-specific and authoritative: exactly one
 *     stored moonshot family decides;
 *   - env-only (or both stored) is ambiguous: drop both — no resolution.
 * An unreadable/corrupt auth store behaves as empty (auth-store.ts), so it
 * reads as env-only and is equally ambiguous.
 */
export function credentialSourceFamilies(): ProviderName[] {
	const families = configuredFamilies();
	if (!(families.includes("moonshotai") && families.includes("moonshotai-cn"))) return families;
	const storedMain = loadApiKey("moonshotai") !== null;
	const storedCn = loadApiKey("moonshotai-cn") !== null;
	if (storedMain && !storedCn) return families.filter((family) => family !== "moonshotai-cn");
	if (storedCn && !storedMain) return families.filter((family) => family !== "moonshotai");
	return families.filter((family) => family !== "moonshotai" && family !== "moonshotai-cn");
}

export interface StartupModelFallback {
	/** The family's curated recommended model (LOGIN_TARGETS.switchHint). */
	reference: string;
	family: ProviderName;
}

/** D1/D2: the family's switchHint, or undefined when the credential set is
 *  empty or not unique. Never invents an id: the switchHint is the exact
 *  reference the /login tail already teaches. */
export function resolveStartupModelFallback(): StartupModelFallback | undefined {
	const families = credentialSourceFamilies();
	if (families.length !== 1) return undefined;
	const family = families[0];
	if (family === undefined) return undefined;
	const target = LOGIN_TARGETS.find((t) => t.family === family);
	if (target === undefined) return undefined;
	return { reference: target.switchHint, family };
}

export interface StartupModelDecisionInput {
	model: string;
	source: ModelSource;
	/** -m/--model was given. */
	explicit: boolean;
	/** -c/--continue or -r/--resume (without explicit -m): D3 owns the
	 *  restore path, the CLI-level decision must not preempt it. */
	resuming: boolean;
	isUsable: (model: string) => boolean;
}

export type StartupModelDecision =
	| { kind: "keep" }
	| { kind: "resolve"; fallback: StartupModelFallback }
	| { kind: "unresolved" };

/**
 * D2's decision table:
 *   0. blank ids      → keep (never resolved; §5 of the design)
 *   a. usable / explicit / configured sources → keep (P3/P5)
 *   b. resume without -m                     → keep (D3 owns it)
 *   c. builtin + unusable + unique family    → resolve
 *   d. otherwise                             → unresolved (teaching copy)
 */
export function decideStartupModel(input: StartupModelDecisionInput): StartupModelDecision {
	if (input.model.trim() === "") return { kind: "keep" };
	if (input.explicit) return { kind: "keep" };
	if (input.source !== "builtin") return { kind: "keep" };
	if (input.resuming) return { kind: "keep" };
	if (input.isUsable(input.model)) return { kind: "keep" };
	const fallback = resolveStartupModelFallback();
	return fallback === undefined ? { kind: "unresolved" } : { kind: "resolve", fallback };
}
