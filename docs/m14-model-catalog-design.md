# M14 — Model Catalog Service (pi.dev as single source of truth)

## 1. Problem

Model metadata (context windows, cost rates, thinking ladders, vision
capability, family model lists) is hand-maintained in static tables
(`src/provider/models.ts`, `thinking.ts` MODEL_RULES, `vision.ts`
VISION_RULES, `commands.ts` FAMILY_FALLBACKS). History shows the drift
cost: #context-window-adapt (user's daily model ran a 128K fallback for
weeks), #thinking-parity-2 (hand-corrected GLM ladders from pi.dev),
#codex-catalog-2 (static table missed models the reference project served
same-day). imp already reaches for pi.dev in three ad-hoc places; this
batch makes it the architecture.

## 2. pi's design (reference: remote-catalog-provider.ts, models-store.ts)

- Public unauthenticated endpoint per family:
  `GET {pi.dev}/api/models/providers/<providerId>` — entries carry
  id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens/
  thinkingLevelMap/compat.
- Disk cache (`models-store.json`, one file keyed by provider):
  `{ models, checkedAt, lastModified, etag }`.
- Refresh on demand (no background timer): a 4h staleness window throttles
  network use; `REMOTE_CATALOG_REFRESH_INTERVAL_MS` is "how long is fresh",
  not a polling period.
- HTTP revalidation: `if-none-match` sent ONLY when a cached body backs it
  (a 304 can never empty the overlay); 304 → bump `checkedAt` only;
  404/501 → record "no catalog for this provider"; transient failure →
  cache kept, `checkedAt` bumped so the window doesn't hammer.
- Merge semantics: static built-ins are the baseline; remote entries
  override same-id and append the rest (`mergeModels`).
- `localGeneratedAt` guard: remote overlay applies only when
  `lastModified > generatedAt` of the static table (pi's static table is
  auto-generated from the same source; the guard stops a stale cache from
  clobbering a fresher build). **Not ported** — see D-notes.

## 3. imp design

Decisions (user-approved 2026-09-20):

1. **pi.dev is the single source of truth.** Remote entries always win
   over static tables (same-id override + append). The static tables are
   FROZEN: first-run bootstrap and last-resort offline floor, no longer
   hand-maintained.
2. **Dual trigger, shared 4h window** (pi semantics): startup staleness
   check + `/model` open. No periodic polling.
3. **Startup never blocks on network.** The disk cache loads synchronously
   (cheap) before the first model resolution; a stale cache triggers an
   async refresh (4s timeout per family, aborted on exit) whose result
   merges in when it lands.
4. **`IMP_CATALOG_BASE_URL`** (already introduced by #model-discovery for
   the codex listing) redirects the base URL — mirrors/local file servers
   without a release. No second env var.
5. Disk cache: `~/.imp/models-catalog.json`, shape
   `{ version: 1, providers: { <family>: { models: {...}, checkedAt,
   lastModified?, etag? } } }`. `IMP_CATALOG_PATH` overrides for tests.
   Corrupt file → treated as absent (static floor shows through).

### 3.1 New module: `src/provider/catalog.ts`

- `loadCatalogCache()`: sync read → in-memory overlay (exact-id keyed per
  family). No-op when absent/corrupt.
- `catalogEntryFor(provider, modelId)` / `catalogModelIds(provider)`:
  consult points.
- `refreshCatalog({ families?, force?, signal? })`: shared in-flight
  promise (concurrent callers join one pass — pi's refresh coordinator
  reduced to its useful core); per family: skip when fresh, fetch with
  timeout + conditional `if-none-match`, persist per pi's status handling.
- Injectable seams for tests (discover.ts precedent): clock, fetcher,
  path.

### 3.2 Consult wiring (overlay first, static floor second)

| Consumer | Order |
|---|---|
| `contextWindowFor` | IMP_CONTEXT_WINDOW > catalog > discovered (endpoint probing) > static > default |
| `costFor` | catalog cost + family subscription annotation (zai/openai-codex ride plans) > static |
| `thinkingMetaFor` | catalog entry (exact id): style derived from family + `compat.forceAdaptiveThinking`, levelMap from `thinkingLevelMap`, maxOutputTokens from `maxTokens`, `reasoning:false` → no knob; else MODEL_RULES prefix rules |
| `modelSupportsVision` | catalog `input` includes "image"; else VISION_RULES |
| `/model` list | endpoint discovery (what's servable now) > catalog ids > static seeds |

Family routing for lookups reuses `parseModelRef` — bare `glm-*` resolves
to zai exactly like the wire path.

### 3.3 anthropic-compat boundary

`ANTHROPIC_BASE_URL` gateways are imp-specific escape hatches; pi.dev has
no catalog for them. Gateway models keep the static/probing path. A bare
`glm-*` on the compat gateway still routes zai for metadata (the gateway
serves the same models).

## 4. Recorded divergences (D11+)

- **D11 — no `localGeneratedAt` guard**: the static tables are frozen, so
  "remote wins" is unconditional; pi needs the guard only because its
  static table is regenerated per build.
- **D12 — single-flight, no per-runtime coordinator**: imp has one
  runtime per process; pi's WeakMap coordinator exists for its
  multi-runtime architecture.
- **D13 — no `publish`/transactional store**: pi routes updates through
  `context.publish` so the UI and store stay consistent; imp's overlay is
  module state + atomic file write.
- **D14 — cross-process writes are last-writer-wins**: each process writes
  its own whole-file snapshot (atomic per-pid rename), so two concurrent
  imp processes refreshing different families can drop each other's entry;
  pi does locked read-modify-write (`withLockAsync`). Bounded by the next
  4h refresh — accepted.
- **D15 — retry adapted, not ported**: pi's `fetchWithRetry` (2 extra
  attempts, per-attempt timeout) is reduced to imp's discover.ts precedent
  (one quiet retry on 429/5xx after 400ms, shared 4s attempt window) —
  a single 503 no longer freezes a family for 4h, without tripling the
  worst-case hang on a blackholed endpoint.

Review round (FIX-FIRST, 1 P1 + 5 P2, all fixed): P1-1 the un-awaited
startup refresh held the process open up to ~16s after print output with a
blackholed endpoint (measured; fix = kick moved to main after mode
resolution, aborted in finally; the attempt timer unrefs; our own abort
skips the window bump). P2s: load path sanitizes like the fetch path;
retry-once on transient 5xx; /model comment corrected (live probe still
wins, no staleness regression); tests (dead env assertion made real,
forced-joins-unforced, abort propagation, load sanitization, retry);
mkdirSync of the cache directory; import-cycle note (init-safe).

## 5. Test plan

Fake fetcher + temp cache file + injected clock:

1. Parse shapes: record-keyed / array / `{models:[...]}`.
2. Precedence: catalog window beats static+discovered; cost + subscription
   annotation per family.
3. thinking: catalog levelMap beats MODEL_RULES; `reasoning:false` → off
   only; adaptive style from compat flag.
4. vision: `input:["text","image"]` true; `["text"]` false even where
   prefix rules would say true (truth wins).
5. Staleness/HTTP: fresh → no fetch; stale → conditional request; 304 →
   window bump, body kept; 404 → no-catalog record; 5xx/network error →
   cache kept, window bumped.
6. Disk round-trip; corrupt file → static floor.
7. `/model` fallback: discovery null + catalog ids → catalog rows.
8. Startup non-blocking kick + single-flight dedupe.
