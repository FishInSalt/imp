# Web search extension: configuration and search hardening

## Scope

Deliver a documented extension-owned Tavily integration without adding Tavily to
imp's model providers, login commands, credential store, or extension API.
This batch implements configuration, packaging, search validation, bounded I/O,
basic page-reader error handling, and a keyless search fallback (no credential
configured) restoring the behavior of commit 6cf8677 that was removed in the
repackage. Public/private network authorization and
DNS-pinned redirect handling are a separate follow-up design: this batch does not
claim SSRF isolation. No paid API requests or user configuration changes occur.

## Packaging

- `examples/extensions/web-search/index.mjs` is the directory extension entry.
  It contains both `web_search` and `url_read`, with relative helper modules under
  `_lib/` (the loader ignores underscore-prefixed children).
- Ship a README and placeholder config example. Executable unit tests live in
  `test/web-search.test.ts` under the existing Vitest include pattern; README
  links to that suite. Existing repository integration tests remain.
- The old `examples/extensions/web_search.mjs` path is removed; the directory
  entry is the only installation identity. No loader changes.
- Install the full directory, or symlink the canonical entry/directory. Do not
  copy a dereferenced entry alone: it needs its helper modules. Document explicit
  `-e .../web-search/index.mjs`. No writes to ~/.imp.
- Test whole-example discovery, installed directory, installed entry symlink,
  and explicit canonical entry plus same-path discovery: exactly two search
  tools and no duplicate-registration diagnostics. Integration fixtures copy the complete
  directory. Stub TAVILY_API_KEY and an absolute temporary IMP_WEB_SEARCH_CONFIG
  in all search tests; the loader's home option does not redirect os.homedir().

## Configuration contract

- One environment variable: `TAVILY_API_KEY`; `IMP_TAVILY_KEY` stays removed.
  When no credential is configured, searches use Tavily's documented keyless
  access mode instead of failing locally. This reverses the earlier "no
  unauthenticated search fallback" decision; see the Keyless fallback section.
  Historical project notes remain history but point readers to the new
  instructions.
- Key precedence: nonblank `TAVILY_API_KEY`, then `apiKey` in the extension's
  user-level file `~/.imp/web-search/config.json`; otherwise keyless. No project
  configuration.
- `IMP_WEB_SEARCH_CONFIG` optionally selects an absolute config file for explicit
  user override and hermetic tests. It does not accept shell commands or expansion.
- Resolve on each search so changes take effect without restart. An environment
  key bypasses reading the file. An absent file with no environment key selects
  keyless mode. Invalid JSON,
  non-object content, unknown fields, non-string/blank key, non-regular file, or
  a group/other-accessible file on POSIX is a configuration error, not a silent
  fallback. Reject symlink config files. File checks use an opened descriptor
  with O_NOFOLLOW | O_NONBLOCK and fstat; read at most 16 KiB plus one byte.
  Always close the descriptor. Use lstat as an early rejection only, not as the
  race defense. If O_NOFOLLOW is unavailable, config-file credentials fail closed
  with guidance to use the environment. Symlink defense covers the final component
  only; parents must be trusted user-controlled directories. No filesystem sandbox
  is claimed. Test FIFO rejection without opening a blocking descriptor.
- Config contains only `apiKey`. The extension never writes config or imports
  imp's model credential module. Documentation provides a local masked-input
  setup recipe that sets directory/file permissions; the agent must ask before
  executing it outside the workspace. Do not put keys in chat, CLI arguments,
  source, examples, or project settings.
- Errors expose neither parsed contents nor underlying exceptions, response
  bodies, secrets, or untrusted HTTP status text. Report actionable categories.
  A present-but-invalid credential fails locally before any network request and
  never silently degrades to keyless.

## Keyless fallback

Contract per the provider's keyless documentation
(https://docs.tavily.com/documentation/keyless), which was current when this
revision was written; the unit tests cannot live-verify provider policy.

- Trigger: for a given call, resolution reports "no credential configured"
  (environment key blank/absent AND the selected config path absent, ENOENT).
  Any present-but-unreadable, invalid or unsafe configuration is a hard local
  error for that call (fail closed); the keyless branch is never entered after
  a configuration error. This concerns per-call selection only: a transition
  into or out of a broken credential source is a credential-state change
  handled under Mode identity. Keyless is a first-run default, not an
  error-recovery path.
- Request: when a key resolves, send `Authorization: Bearer <key>` and no
  access-mode header. When none resolves, send `X-Tavily-Access-Mode: keyless`
  and no authorization header. Never both. Endpoint, payload schema and all
  search parameters are unchanged; keyless `/search` is documented to support
  all parameters and to return the same response schema as keyed access.
- Mode identity: the credential state is a module-level variable holding an
  unset marker (initial/reset), a resolved key string, or an explicit keyless
  sentinel (never a string derived from input, config or provider output). Per
  call, compute identity = resolved key or sentinel; if it differs from the
  stored state, clear the cache and bump the generation counter, then store it.
  A configuration failure also clears the cache and bumps the generation
  regardless of the prior state; that invalidation, not the specific stored
  identity afterwards, is the observable contract. An in-flight response may be
  cached only when its generation is still current; key removal invalidates the
  keyed state before the keyless request is sent. Keyless results cache
  normally, within their own generation.
- Errors: the provider documents keyless limits only as natural-language
  guidance, not as stable status codes, so keyless classification is a
  defensive heuristic, not provider-verified: {401,403,429,432,433} map to one
  sanitized actionable hint — keyless access was rejected or limited; wait
  before retrying or set `TAVILY_API_KEY` for higher limits. Every other
  non-2xx in keyless mode keeps mode-neutral wording (400 -> request rejected,
  5xx -> service unavailable, the remaining 4xx -> request rejected). Keyless
  mode never emits keyed-specific wording (no "check TAVILY_API_KEY or config
  file", no "your Tavily account usage"). Keyed-mode hints stay as they are.
  No retries and no automatic mode switching within a request.
- Posture: an installation with the extension but no credential now performs
  unauthenticated requests to the same fixed Tavily endpoint; there is no new
  data recipient, and a call whose resolution ends in a configuration error
  sends no request. The privacy delta versus keyed access is attribution:
  provider-side, unauthenticated requests carry IP/network metadata, not an
  account identity. No disable switch: installing the extension is the opt-in.
- Failure UX: a keyless request failure surfaces as a normal tool error. The
  old local missing-key setup error and its teaching text are removed from
  behavior, tests and active documentation, including: the README statement
  that no unauthenticated fallback exists, the README migration note that a
  missing key produces a local setup error, the README troubleshooting bullet,
  and the local credential-verification snippet, whose keyless-state output
  must say "no credential configured — keyless search mode" instead of the
  bare "Not configured".

## Search contract

- Schema: nonblank query (trimmed, <= 2000 characters), integer max_results 1..10
  (default 5), integer days 1..365 when provided, optional full boolean, domain
  arrays <= 100 items. Runtime validation repeats the schema's critical rules
  for callers that bypass host validation.
- Domain filters accept hostnames only; lowercase, strip trailing dot, normalize
  through URL hostname parsing, deduplicate and sort. Reject URL paths, ports,
  userinfo, wildcards, whitespace, backslashes, percent escapes, query/fragment
  markers, IP literals and single-label hosts. Allow Unicode domain names via
  IDNA conversion, then validate DNS label lengths and characters. Include/exclude
  overlap is an input error.
- Explicit `search_depth: "basic"`, `include_answer: false`. The tool promises
  source results, not a provider-generated answer; the parent model synthesizes.
  Keep days -> topic news + days mapping for this batch; document it as the
  existing provider-specific behavior, not a general date-range filter.
- `full` requests raw content; return at most 3000 characters per source with a
  truncation marker. Limits described as characters unless actually byte-based.
- Validate results individually (object, string title/content, HTTP(S) URL without
  embedded credentials). Skip invalid entries; malformed nonempty result arrays
  containing no usable entries are errors. Empty results are a normal success.
- Limit response to 1 MiB decoded body bytes through a shared streaming reader;
  cancel the stream on overflow. All character limits count JS UTF-16 code units,
  trimming a trailing unmatched high surrogate when truncating. Title <= 300,
  URL <= 2048 (skip, never shorten oversized URLs), snippet <= 500, raw <= 3000.
  Final output <= 40,000 characters including query, metadata and markers. Build
  whole source blocks within the remaining budget, reserving space for an omitted
  sources notice; never slice a source URL. Put external-content warning first.
  Generic errors never reflect user input; successful content remains untrusted
  and may contain arbitrary source text. No claim that delimiters prevent injection.
- Distinguish user cancellation, timeout, network failure, auth failure (401/403),
  rate limiting (429), quota (432/433), service failure (5xx), malformed response
  and oversized response. Keyless mode collapses 401/403/429/432/433 into one
  hint (see Keyless fallback). No automatic retries or provider fallback:
  requests may be billed even when a response is lost. Do not reflect raw error
  messages.
- Fixed HTTPS Tavily endpoint; redirects rejected. No custom search endpoints.

## Cache

10-minute in-memory LRU-style cache, maximum 64 entries, lazy expiry sweep on each
call. Cache normalized query/options. Resolve credentials before cache lookup;
clear the cache on credential change or configuration failure, without putting
keys in cache IDs/output. Track a generation counter on credential-identity
changes (including key <-> keyless transitions) or config failure; an in-flight
response can be cached only in its original generation.
Test rotation/failure while requests are pending. The cache is per extension
instance and may outlive
/new; no disk cache, failed-result cache, or parallel-request deduplication.

## Page reader (bounded-I/O subset)

Keep HTTP(S) page fetching and existing simple HTML extraction, but reject URLs
with embedded credentials. Check HTTP status, use streaming 300,000-byte input
limit (truncate and cancel), 20,000-character TOTAL output limit, and accurate
truncation notices. Reserve metadata/notice budget before clipping body text.
Reject source URLs over 2048 characters, never shorten a URL. Include source URL
and untrusted-content label; generic sanitized errors.
Reject binary content and cancel unused bodies. Timeout/cancellation covers body
consumption. Redirects still use fetch's existing policy. Explicitly document that
private/local URLs remain accessible: full network policy is not implemented here.

## Verification and review

- Mock fetch and config paths; no real credentials, real DNS, or paid API calls.
- Test env/file precedence, blank/missing/invalid config, unknown keys, file
  permissions/symlinks/size bounds, runtime key rotation, key <-> keyless
  transitions and the credential-change cache gate.
- Test both request modes in `test/web-search.test.ts`: keyed sends the bearer
  header and no access-mode header; keyless sends the access-mode header and no
  authorization header;
  keyless 401/403/429/432/433 map to the single keyless hint while other
  non-2xx keep mode-neutral wording; absent config selects keyless while a
  present-but-invalid config still fails locally with no request, even when no
  environment key exists.
- Rewrite the two tests that pin the removed missing-key error:
  `test/extensions-contrib.test.ts` "no key → local missing-key error without
  fetching" becomes a keyless success path through the actual loader; and the
  `test/web-search.test.ts` credential-change cache case "missing" becomes a
  keyed→keyless transition (cache cleared, keyless request sent, the old
  in-flight keyed response still not cached). Add the reverse keyless→keyed
  transition (cache cleared, bearer request sent).
- Test valid request payload, integer/domain/query validation, output limits,
  malformed entries, empty results, status categories, body-read failures,
  cancellation/timeout, redaction, cache eviction/expiry, bounded stream reads.
- Test page status/content type, input/output truncation, HTML extraction and
  cancellation. Keep integration through the actual extension loader.
- Design must pass independent review before implementation. Run targeted/full
  tests, typecheck and build, then independent code review before completion.

## Non-goals

Core credential refactoring, OAuth, credential shell helpers, multiple providers,
search-depth UI, browser automation, persistent search history, existing-user
credential migration, private-network isolation, a keyless disable switch,
keyless for other Tavily endpoints, provider failover and request retries are
outside this batch.
