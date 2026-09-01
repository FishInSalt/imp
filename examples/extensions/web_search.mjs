// examples/extensions/web_search.mjs — web search (Tavily) + page reader.
// Zero dependencies: Node's global fetch only.
//
// Install: copy into <project>/.imp/extensions/ (or ~/.imp/extensions/).
//
// Env:
//   IMP_TAVILY_KEY   Tavily API key (free tier ~1k calls/month at
//                    https://tavily.com — Settings → API Keys). Optional:
//                    without a key, search runs in Tavily's keyless mode
//                    (rate-limited, no account needed). url_read never
//                    needs a key.
//
// Params (web_search): days (recency, news topic), include/exclude_domains,
//   full (include_raw_content — up to 3KB per result, saves the url_read hop).
// A 10-minute response cache dedupes repeated identical queries within a
// session (quota-friendly; the same phrasing rarely needs fresh results).

const TAVILY_URL = "https://api.tavily.com/search";
const SEARCH_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;
const READ_INPUT_CAP = 300_000; // raw bytes we read from a page
const READ_OUTPUT_CAP = 20_000; // text we hand back to the model
const RAW_SNIPPET_CAP = 3_000; // per-result raw_content when full:true
const CACHE_TTL_MS = 10 * 60 * 1000;

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	/** @type {Map<string, { at: number, output: string }>} */
	const cache = new Map();

	api.registerTool({
		name: "web_search",
		description:
			"Search the web. Returns a short composed answer plus cited results (title, url, snippet). " +
			"Use it for anything newer than your training data or facts you are unsure about. " +
			"For important fact-checks, search 2-3 times with varied phrasing and compare. " +
			"Options: days (only the last N days — news topic), include/exclude_domains, " +
			"full (also return up to 3KB of each page's content — saves a follow-up url_read).",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "what to search for" },
				max_results: { type: "number", description: "1-10 results, default 5" },
				days: { type: "number", description: "restrict to the last N days (news topic)" },
				include_domains: { type: "array", items: { type: "string" }, description: "only these domains" },
				exclude_domains: { type: "array", items: { type: "string" }, description: "skip these domains" },
				full: { type: "boolean", description: "include up to 3KB of page content per result" },
			},
			required: ["query"],
		},
		async execute(args, signal) {
			// Key if we have one; otherwise Tavily's keyless mode (rate-limited,
			// no account) — search works out of the box either way.
			const headers = { "content-type": "application/json" };
			if (process.env.IMP_TAVILY_KEY) {
				headers.authorization = `Bearer ${process.env.IMP_TAVILY_KEY}`;
			} else {
				headers["x-tavily-access-mode"] = "keyless";
			}
			const max = Math.min(10, Math.max(1, Number(args.max_results ?? 5) || 5));
			const days = Math.max(0, Math.floor(Number(args.days ?? 0) || 0)); // 0 = no recency filter
			const inc = Array.isArray(args.include_domains) ? args.include_domains.map(String) : [];
			const exc = Array.isArray(args.exclude_domains) ? args.exclude_domains.map(String) : [];
			const full = args.full === true;

			const cacheKey = JSON.stringify({ q: String(args.query), max, days, inc, exc, full });
			const hit = cache.get(cacheKey);
			if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { output: hit.output };
			cache.delete(cacheKey); // expired entry

			const body = { query: String(args.query), max_results: max };
			if (days > 0) {
				body.topic = "news";
				body.days = days;
			}
			if (inc.length > 0) body.include_domains = inc;
			if (exc.length > 0) body.exclude_domains = exc;
			if (full) body.include_raw_content = true;

			let res;
			try {
				res = await fetch(TAVILY_URL, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
				});
			} catch (err) {
				if (signal.aborted) return { output: "web_search aborted", isError: true };
				return {
					output: `web_search request failed: ${err.message} — check the network and try again`,
					isError: true,
				};
			}
			if (!res.ok) {
				const hint = res.status === 401 || res.status === 403 ? " — check IMP_TAVILY_KEY" : " — try again";
				return { output: `web_search HTTP ${res.status} ${res.statusText}${hint}`, isError: true };
			}
			const data = await res.json().catch(() => null);
			if (!data || !Array.isArray(data.results)) {
				return { output: "web_search got an unexpected response shape — try again", isError: true };
			}
			const parts = [];
			if (typeof data.answer === "string" && data.answer !== "") parts.push(`Answer: ${data.answer}`);
			for (const [i, item] of data.results.entries()) {
				let block = `[${i + 1}] ${String(item.title ?? "(untitled)")}\n    ${String(item.url ?? "")}\n    ${String(
					item.content ?? "",
				).slice(0, 500)}`;
				if (full) {
					const raw = String(item.raw_content ?? "").slice(0, RAW_SNIPPET_CAP).trim();
					if (raw !== "") block += `\n    <content>\n    ${raw.replace(/\n/g, "\n    ")}\n    </content>`;
				}
				parts.push(block);
			}
			if (parts.length === 0) return { output: "web_search: no results — refine the query", isError: true };
			const output = parts.join("\n\n");
			cache.set(cacheKey, { at: Date.now(), output });
			return { output };
		},
	});

	api.registerTool({
		name: "url_read",
		description:
			"Fetch a web page and return its readable text (scripts/styles stripped, 20KB cap). " +
			"The follow-up to web_search when a result needs more than its snippet " +
			"(web_search full:true already returns 3KB per page — use this for the whole thing).",
		parameters: {
			type: "object",
			properties: { url: { type: "string", description: "absolute http(s) URL" } },
			required: ["url"],
		},
		async execute(args, signal) {
			const url = String(args.url ?? "");
			if (!/^https?:\/\//.test(url)) {
				return { output: `url_read needs an absolute http(s) URL — got "${url}"`, isError: true };
			}
			let res;
			try {
				res = await fetch(url, {
					signal: AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
					redirect: "follow",
					headers: { "user-agent": "imp-url-read/0.1" },
				});
			} catch (err) {
				if (signal.aborted) return { output: "url_read aborted", isError: true };
				return { output: `url_read fetch failed: ${err.message}`, isError: true };
			}
			const type = res.headers.get("content-type") ?? "";
			if (!/text\/html|text\/plain|application\/(json|xml)/.test(type)) {
				return {
					output: `url_read: unsupported content-type "${type}" — this tool reads pages and text, not binaries`,
					isError: true,
				};
			}
			const raw = (await res.text()).slice(0, READ_INPUT_CAP);
			const truncated = raw.length >= READ_INPUT_CAP;
			const text = (/json|xml/.test(type) ? raw : htmlToText(raw)).slice(0, READ_OUTPUT_CAP);
			return { output: truncated ? `${text}\n\n[truncated: 300KB input / 20KB output caps]` : text };
		},
	});
}

/** Tag-soup → readable text. No DOM, no deps — good enough for articles/docs. */
function htmlToText(html) {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/pre|\/blockquote)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}
