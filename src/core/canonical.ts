/**
 * Order-insensitive structural equality helper (SA-08 reopened F-1, review
 * C-2): a rewritten value still differs (any value change), but key order
 * alone does not (no serialization coupling). Shared by the launch-header
 * comparison (`tools/task.ts`) and the loop-health turn signatures
 * (`health.ts`, #loop-health) — one serializer, no drift.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
