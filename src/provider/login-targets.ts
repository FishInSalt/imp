import type { ApiKeyFamily } from "./auth-store.js";

/**
 * #fresh-install-hint: the provider login table, relocated from
 * repl/commands.ts so the runner layer (startup teaching note, print
 * pre-flight) can read family→env-var mappings without depending on the
 * REPL (design §3.1/D2: "the family list derives from LOGIN_TARGETS —
 * no hand list").
 *
 * The display fields (name, switchHint) are REPL concerns; they ride
 * along because /login renders them (single source of truth — moving
 * only the envVar column would fork the table).
 */

export interface LoginTarget {
	family: ApiKeyFamily | "openai-codex";
	/** pi's provider display name. */
	name: string;
	/** The env-var alternative (the description's source label). */
	envVar: string;
	method: "api_key" | "oauth";
	/** Post-login /model hint when the current family differs. */
	switchHint: string;
}

export const LOGIN_TARGETS: readonly LoginTarget[] = [
	{ family: "zai", name: "Z.AI", envVar: "ZAI_API_KEY", method: "api_key", switchHint: "zai/glm-5.3" },
	{
		family: "anthropic",
		name: "Anthropic",
		envVar: "ANTHROPIC_API_KEY",
		method: "api_key",
		switchHint: "claude-sonnet-4-5",
	},
	{
		family: "openai",
		name: "OpenAI",
		envVar: "OPENAI_API_KEY",
		method: "api_key",
		switchHint: "openai/gpt-5.2",
	},
	{
		family: "openai-codex",
		name: "OpenAI (ChatGPT plan)",
		envVar: "none — OAuth",
		method: "oauth",
		switchHint: "openai-codex/gpt-5.5",
	},
	{
		family: "deepseek",
		name: "DeepSeek",
		envVar: "DEEPSEEK_API_KEY",
		method: "api_key",
		switchHint: "deepseek/deepseek-v4-pro",
	},
	{
		family: "moonshotai",
		name: "Moonshot AI",
		envVar: "MOONSHOT_API_KEY",
		method: "api_key",
		switchHint: "moonshotai/kimi-k3",
	},
	{
		family: "moonshotai-cn",
		name: "Moonshot AI CN",
		envVar: "MOONSHOT_API_KEY",
		method: "api_key",
		switchHint: "moonshotai-cn/kimi-k3",
	},
];

/** Resolve "/login <ref>" to its target — case-insensitive against family
 *  id AND display name (pi's findLoginProviderOptions). */
export function loginTargetFor(ref: string): LoginTarget | undefined {
	const needle = ref.trim().toLowerCase();
	if (needle === "") return undefined;
	return LOGIN_TARGETS.find((t) => t.family === needle || t.name.toLowerCase() === needle);
}
