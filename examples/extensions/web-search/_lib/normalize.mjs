import { isIP } from "node:net";

function domains(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 100) throw new Error("invalid domains");
	return [...new Set(value.map((domain) => {
		if (typeof domain !== "string" || /[\s\\/%?#:@*]/u.test(domain)) throw new Error("invalid domain");
		const host = new URL(`https://${domain.replace(/\.$/, "")}`).hostname.toLowerCase();
		if (host.length > 253 || !host.includes(".") || isIP(host) || !host.split(".").every(
			(label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
		)) throw new Error("invalid domain");
		return host;
	}))].sort();
}
export function normalize(args) {
	if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 2000) throw new Error("invalid query");
	const max = args.max_results === undefined ? 5 : args.max_results;
	if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error("invalid max_results");
	if (args.days !== undefined && (!Number.isInteger(args.days) || args.days < 1 || args.days > 365)) throw new Error("invalid days");
	if (args.full !== undefined && typeof args.full !== "boolean") throw new Error("invalid full");
	const inc = domains(args.include_domains);
	const exc = domains(args.exclude_domains);
	if (inc.some((domain) => exc.includes(domain))) throw new Error("overlapping domains");
	return { query: args.query.trim(), max, days: args.days, inc, exc, full: args.full === true };
}
