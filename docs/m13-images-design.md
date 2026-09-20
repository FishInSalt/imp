# M13 — Image Input (design)

Status: draft (awaiting confirmation). Branch `feat/images`.

Goal: the `read` tool can attach images (jpg/png/gif/webp, bmp degraded) to
the conversation; every provider serializes them on its native wire; models
without vision degrade gracefully; sessions/replay/compaction stay correct.

pi reference (all read during research, v0.85.1-61):

| Concern | pi file |
|---|---|
| read tool (harness, no processor) | `packages/agent/src/harness/tools/read.ts` |
| magic-byte sniffing | `packages/agent/src/harness/tools/image.ts`, `coding-agent/src/utils/mime.ts` |
| read tool (wired: processImage + non-vision note) | `coding-agent/src/core/tools/read.ts` |
| normalize + convert + resize | `coding-agent/src/utils/image-process.ts`, `image-convert.ts`, `image-resize.ts`, `image-resize-core.ts` |
| post-hook normalization (extensions/MCP images) | `coding-agent/src/utils/tool-result-images.ts` |
| Anthropic serialization | `packages/ai/src/api/anthropic-messages.ts` (`convertContentBlocks`, `convertToolResult`) |
| OpenAI chat-completions serialization (image hoisting) | `packages/ai/src/api/openai-completions.ts` ~1377–1430 |
| OpenAI responses serialization (`input_image`) | `packages/ai/src/api/openai-responses-shared.ts` 75–105 |
| non-vision downgrade | `packages/ai/src/api/transform-messages.ts` 12–48 |
| model capability metadata | generated catalog `input: ["text","image"]` (`providers/data/*.json`) |
| compaction estimate | `core/compaction/compaction.ts:242` `ESTIMATED_IMAGE_CHARS = 4800` |
| settings | `images.autoResize` (default true) |
| TUI inline graphics (kitty) | `modes/interactive/components/tool-execution.ts` |
| clipboard paste → tmp file → path at cursor | `modes/interactive/interactive-mode.ts:2934` |

## 1. Scope

**Batch 1 (this design) — the wire:**

1. Content-block message model (text/image) for user messages and tool results.
2. `read` tool image detection + attachment (magic bytes, pi-parity).
3. Size guard without resize: > 4.5 MB encoded → teaching error (batch 2 adds resize).
4. Vision capability rules (prefix table, thinking.ts MODEL_RULES pattern).
5. Request-assembly downgrade for non-vision models (pi transform-messages parity).
6. Serialization in all four provider lines (anthropic, openai-completions, codex-responses, zai).
7. Session store/replay/transcript/print rendering as one-line notes.
8. Compaction estimate parity (4800 chars per image).
9. subagent/task plumbing unchanged (types flow through).

**Deferred to batch 2 (recorded, not designed here):** auto-resize + BMP/EXIF
conversion via `@silvia-oddyer/photon-node` (pi's dep) in a worker; clipboard
paste-to-tmpfile; `@file` attachments / CLI `--attach`; kitty inline graphics;
`images.autoResize` setting. Rationale: batch 1 makes images *work* on the wire
for correctly-sized files; resize machinery is an independent, heavier layer
(pi isolates it behind `imageProcessor` for exactly this reason — the harness
read tool runs without one, BMP degrades to a note).

## 2. Message model (src/core/messages.ts)

```ts
export type UserContent = string | ContentBlock[];
export type ContentBlock = TextBlock | ImageBlock;
export interface TextBlock  { type: "text";  text: string }
export interface ImageBlock { type: "image"; data: string; mimeType: string }

export interface UserMessage { role: "user"; content: UserContent }
export interface ToolResult  { …; content: string | ContentBlock[] }
```

- The common path stays a **string** (pi: "If only text blocks, return as
  concatenated string"). Arrays appear only when a tool actually produced an
  image, so print-mode byte contracts for text-only sessions are untouched.
- ImageBlock mirrors pi's `ImageContent` exactly (`data` = base64, no data: prefix).
- Session JSONL: blocks serialize natively; old sessions (string) parse as
  before — the union is backward compatible with every existing record.
- Every consumer that today does `result.content` on a possibly-array value
  goes through one helper `contentText(content): string` (join text blocks,
  `\n` separator, images contribute nothing). Callers: subagent context
  builder, compaction summarizer, extension display paths, replay.

## 3. Read tool (src/core/tools/read.ts)

Flow (pi `coding-agent/src/core/tools/read.ts` parity, minus processor):

```
readFile bytes → detectSupportedImageMimeType(bytes)
  ├─ image mime →
  │    encoded = base64
  │    if (byteLength > 4.5 MB) → text-only teaching error:
  │        "Read image file [image/png]
  │         [Image omitted: 6.2 MB exceeds the 4.5 MB inline limit. Resize it
  │          (e.g. `sips -Z 2000 <file>` on macOS) or enable auto-resize.]"
  │    if (mimeType === "image/bmp") → text-only note (pi without processor):
  │        "Read image file [image/bmp]
  │         [Image omitted: BMP requires conversion; not supported yet.]"
  │    else → content: [
  │        { type: "text", text: `Read image file [${mimeType}]` + nonVisionNote? },
  │        { type: "image", data, mimeType } ]
  ├─ not image → NUL binary check (existing) → error, unchanged bytes
  └─ else → text path, byte-for-byte today's behavior
```

- `nonVisionNote`: when the active model lacks vision → append
  `"[Current model does not support images. The image will be omitted from
  this request.]"` to the text block (pi parity — the read *succeeds*, the
  downgrade happens at request assembly, §5).
- Tool description gains: `Supports text files and images (jpg, png, gif,
  webp, bmp). Images are sent as attachments.` (pi wording).
- `detectSupportedImageMimeType` ported byte-for-byte from pi `image.ts`:
  JPEG (`ff d8 ff`, reject `0xf7` JPEG-XR), PNG (IHDR validation, animated
  PNG via acTL-chunk walk → rejected), GIF, WEBP (RIFF…WEBP), BMP (full
  header validation). Detection is by content, never by extension.

## 4. Tool execute result shape

`ToolExecuteResult` gains an optional `content?: ContentBlock[]` alongside
`output: string`. Default: `content` undefined → loop wraps `output` as today
(zero churn for all existing tools). When `read` returns blocks, the loop
builds `ToolResult.content = blocks`. `isError` semantics unchanged (the
oversize/BMP cases are *successful* reads with notes — the model can still
act on the text, pi parity).

## 5. Vision capability (src/provider/vision.ts, new)

pi has `model.input.includes("image")` from a generated catalog. imp has no
model catalog — the established pattern is thinking.ts's prefix `MODEL_RULES`.

```ts
modelSupportsVision(provider: string, model: string): boolean
```

Prefix rules (first match wins, default **false** — fail-safe: an image sent
to a non-vision endpoint 400s the whole request, so false is the safe default).
z.ai entries verified against official docs (2026-09-20, docs.z.ai/devpack
+ /guides/vlm): coding-plan models are GLM-5.3 (text-only flagship) and
GLM-5.3-Flash/FlashX (natively multimodal); legacy ids auto-route
(glm-5.2/5.1→5.3, glm-4.7→5.3-Flash); GLM-5V-Turbo/GLM-4.6V are separate
VLM lines on the OpenAI-compatible chat API.

| provider | prefix | vision |
|---|---|---|
| anthropic | `claude-` | true |
| openai | `gpt-4o`, `gpt-4.1`, `gpt-4.5`, `gpt-5`, `o3`, `o4` | true |
| codex | `gpt-5-codex` … | per OpenAI docs at impl time |
| zai | `glm-5.3-flash` (covers flashx), `glm-5v` | true; all other `glm-` false (GLM-5.3/5.2/5.1/4.7/turbo are text) |

Discovery (`discover.ts`) surfaces models as strings; the rules table is the
single source. New/unknown ids default false.

## 6. Request-assembly downgrade (src/provider/shared.ts)

`downgradeUnsupportedImages(messages, supportsVision): AgentMessage[]` —
pi `transform-messages.ts` parity, called at the top of each provider's
`stream()`:

- vision model → identity.
- else: user arrays and tool-result arrays get images replaced by
  `"(image omitted: model does not support images)"` /
  `"(tool image omitted: model does not support images)"`; **consecutive
  placeholders collapse to one** (pi's `previousWasPlaceholder` logic).
- String contents pass through untouched (no allocation on the hot path).

## 7. Provider serialization

**anthropic.ts** (pi `convertContentBlocks` parity):

- user: string → as today; array → content-block array
  (`{type:"text"}` / `{type:"image", source:{type:"base64", media_type, data}}`);
  images without any text block prepend `"(see attached image)"`.
- toolResult: content string → as today; array → `tool_result.content`
  becomes the block array (text + image parts mixed, pi `convertToolResult`).

**openai-completions.ts** (pi 1377–1430 parity — chat completions tool
messages cannot carry images, so images are **hoisted**):

- tool message content = joined text (placeholder when only images).
- after a run of tool messages, if vision model and images exist → one
  following user message leading with pi's text part
  `Attached image(s) from tool result:` then the `{type:"image_url",
  image_url:{url:"data:<mime>;base64,<data>"}}` parts (imp already emits
  user-after-tool messages for steering, so the boundary shape is
  established; the leading text part is pi parity for strict gateways).

**codex-responses.ts** (pi `openai-responses-shared` parity):

- tool output: text → string as today; with images + vision →
  `[{type:"input_text"}, {type:"input_image", detail:"auto",
  image_url:"data:…"}]` array.

**zai.ts**: same builder rules as openai-completions; with the §5 rules the
common glm models downgrade to placeholders, glm-4v/4.5v ride the hoisted
user-message path.

## 8. Rendering (display layer)

- `render.ts` / transcript: a tool result with images renders the text block
  as today (`→ Read image file [image/png]`) plus one dim note per image:
  `▪ image [image/png, 412.3 KB]` (from base64 length). No inline graphics —
  recorded divergence (pi kitty graphics is a TUI-layer feature; batch 2+).
- Print mode: same one-line note (the text block already carries the info).
- Replay: tool results replay through the same render path — no change
  beyond the note line.
- `firstLine(result.content)`-style helpers route through `contentText`.

## 9. Compaction (src/core/compaction.ts)

- `estimateTokens`: image block contributes `4800` chars (pi
  `ESTIMATED_IMAGE_CHARS`), text blocks as today.
- Summarizer prompt build: text blocks only (`contentText`), images never
  enter the summarize request.

## 10. Subagents / task tool / extensions

- Types are shared → subagent histories accept blocks with zero plumbing.
- The task tool's context builder joins user content via `contentText`.
- Extension surface unchanged: imp's extension events expose tool_call
  gates, not result content (pi exposes blocks there; imp has no consumer —
  recorded, add when an extension needs it).

## 11. Tests (test/images-*.test.ts + additions)

1. **Magic bytes** (unit): tiny synthetic buffers for each signature family,
   negative cases (JPEG-XR `0xf7`, animated PNG acTL, text file, truncated).
2. **read tool**: image file → text+image blocks (golden note bytes); bmp →
   note-only; oversize (>4.5 MB fixture) → teaching note; non-vision model →
   note appended; text file → byte-identical to today's output.
3. **Downgrade**: non-vision request assembly collapses consecutive images
   to one placeholder each for user + toolResult; vision model → identity;
   string contents untouched.
4. **anthropic.ts**: golden request JSON — mixed blocks inside
   `tool_result.content`, user array, "(see attached image)" prepend rule.
5. **openai-completions.ts**: hoisting — tool text in tool message, images
   in the following user message; non-vision → no image_url anywhere.
6. **codex-responses.ts**: `input_image` data URLs; non-vision → string.
7. **Session round-trip**: blocks → JSONL → parse → replay renders the note.
8. **Compaction**: image block estimated at 4800 chars; summarizer request
   has no image data.
9. **e2e**: scripted vision model reads a PNG fixture through the real tool
   pipeline; request 2's tool message (or hoisted user message) carries the
   exact base64.

## 12. Acceptance

- `read img.png` on a vision model: attachment visible in the request
  (golden), model replies about the image (scripted), transcript shows the
  note line, session round-trips.
- Same read on a text-only model (glm): request carries placeholders, never
  base64; the read itself succeeded (text note present).
- Text-only sessions: zero byte changes anywhere (print contract, request
  JSONs, session files).
- Full suite green (mac + Linux Docker), typecheck, biome.

## 13. Recorded divergences from pi

| # | Divergence | Why |
|---|---|---|
| D1 | No auto-resize; >4.5 MB hard teaching error | Resize needs photon-node + worker (batch 2); fail-safe beats silent bloat |
| D2 | BMP note-only (pi: note without processor — same shape, different text) | No converter in batch 1 |
| D3 | No kitty inline graphics; one-line note | TUI-layer feature; imp's transcript model differs |
| D4 | No clipboard paste / @file attach / --attach | UX layer, later batch |
| D5 | Vision via prefix rules, not generated catalog | imp has no catalog; thinking.ts precedent |
| D6 | Extension tool-result events expose no blocks | No consumer today |
