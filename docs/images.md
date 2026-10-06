# Images

Read this when you attach or paste images, use a vision model, or hit image
size limits.

## What the read tool does with images

The `read` tool attaches images to the conversation. When the active model
supports vision (claude, gpt-4o/4.1/4.5/5, o3/o4,
glm-5.3-flash/flashx, glm-5v …), a read of a jpg/png/gif/webp sends the
image inline — the model sees it. Detection is by content (magic bytes),
never by file extension.

- Text-only models still read successfully: the image is replaced by a
  placeholder at request time, and the tool notes the omission.
- BMP converts to PNG (EXIF orientation baked in); jpg/jpeg mime labels
  normalize.

## Attach images

- **Print mode**: `ink @shot.png @notes.txt "what is this"` — text files
  embed as `<file>` blocks, images attach to the first message through the
  same processor.
- **TUI**: Ctrl+V pastes a clipboard image as a tmp-file path at the cursor
  (macOS via osascript, Linux via wl-paste/xclip, Windows via PowerShell —
  Windows is not supported yet); plain text pastes when no image is found.
  You can also drag files into the terminal or type the path directly.

## Oversize handling (resize ladder)

Oversized images (>4.5 MB encoded) are resized automatically through the
photon (Rust/WASM) ladder — 2000×2000 cap, PNG/JPEG candidates, quality
steps, dimension decay — with a coordinate-mapping note telling the model
how to map back to original pixels. Set `images.autoResize: false` in
`~/.ink/settings.json` to ship original bytes (oversize then gets a
teaching note instead).

## Vision models per provider

- **z.ai Coding Plan**: `glm-5.3-flash` is the vision model of the plan
  (GLM-5.3 itself is text-only).
- Anthropic claude models, OpenAI gpt-4o/4.1/4.5/5 and o3/o4 support
  images natively; see the model picker (`/model`, Ctrl+L) — the catalog
  entry lists `input: image` capability.
