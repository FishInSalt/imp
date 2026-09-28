import { familyConfigured } from "./discover.js";
import { LOGIN_TARGETS } from "./login-targets.js";
import type { ProviderName } from "./resolve.js";

/**
 * #fresh-install-hint: is the CURRENT model actually usable?
 *
 * A model reference is only presented "in use" when its family holds a
 * credential (stored key or env var — `familyConfigured` semantics, incl.
 * codex OAuth and the ANTHROPIC_AUTH_TOKEN bearer case). On a fresh
 * install with no credentials anywhere, the hardcoded startup default
 * (`claude-sonnet-4-5`, cli.ts defaultModel) must NOT render as if it
 * were usable — the surfaces show "no model available — run /login"
 * instead (design docs/fresh-install-model-hint-design.md, P1/P2).
 *
 * LIVE probe, not cached (design §3.1, round-1 F4): callers probe at
 * render time. `familyConfigured` reads one small JSON file (redirected
 * by IMP_AUTH_PATH in tests) plus `process.env`; after `/login` the next
 * footer repaint is automatically correct — no invalidation hooks, no
 * cache coherency surface.
 *
 * This is a *credential* probe, not a reachability probe: a configured
 * family whose endpoint is down still counts as usable. The problem this
 * solves is "no credential anywhere", not "endpoint down".
 */

export interface ModelAvailability {
	/** true when the CURRENT model's family holds a credential. */
	usable: boolean;
	/** All families with a credential right now (stored key or env). */
	configuredFamilies: ProviderName[];
}

/** Derived from LOGIN_TARGETS (implementation review F7c) — a hand list
 *  here would silently drop a future family: discover.ts's exhaustive
 *  switch forces the probe to learn it, but a stale side list would keep
 *  reporting it unconfigured. LOGIN_TARGETS is the one registry that
 *  ships with every provider (it drives /login). */
const ALL_FAMILIES: readonly ProviderName[] = LOGIN_TARGETS.map((t) => t.family as ProviderName);

export function modelAvailability(providerName: ProviderName): ModelAvailability {
	const configuredFamilies = ALL_FAMILIES.filter(familyConfigured);
	return { usable: configuredFamilies.includes(providerName), configuredFamilies };
}
