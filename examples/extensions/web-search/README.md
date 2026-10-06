# Web search extension

A zero-dependency Node.js extension providing `web_search` (Tavily) and `url_read`
(HTTP page text). Authentication and configuration belong to this extension, not
Ink's model provider registry or `/login` command. Requires Ink's Node >=22.19.0 runtime.

## Installation

Copy this **entire directory**, including `_lib/`, into
`~/.ink/extensions/web-search/`, or link this directory there. Project-local
`.ink/extensions/web-search/` also works when the project is trusted.
Alternatively use an explicit entry:

```sh
ink -e /absolute/path/to/web-search/index.mjs
```

Do not copy `index.mjs` alone. An explicit `-e` directory means a directory to
scan, not necessarily a single extension entry; use the entry path above.
The old repository path `examples/extensions/web_search.mjs` no longer exists;
install this directory instead. Install only one copy: independently
installed copies at different paths are not deduplicated.

To upgrade, replace the installed package while keeping user configuration
separate. To uninstall, remove its installed copy/link after checking the path.
Uninstalling does not remove your private config. Restart Ink after code updates;
credential changes are picked up at the next search.

An agent must obtain approval before changing files outside its workspace, such
as installing into `~/.ink/` or editing shell configuration.

## Credentials

Get an API key from your Tavily account: https://app.tavily.com/ . A keyed search
uses your account quota; requests may consume credits. The extension does not
automatically retry or switch providers. Page reading does not require a Tavily key.

Resolution order:

1. Nonblank `TAVILY_API_KEY` environment variable.
2. `apiKey` in `~/.ink/web-search/config.json`.
3. Otherwise searches use Tavily's keyless access mode (`X-Tavily-Access-Mode:
   keyless`): free but rate-limited, no account required, same response schema
   as keyed access.

Only `TAVILY_API_KEY` is recognized; older variable names are not read. A
present-but-invalid config file is a local error, never a silent keyless
downgrade. Do not paste a real key into an agent conversation, tool arguments,
source code, or a checked-in project configuration.

For a single shell session, enter it without echoing it or placing it in shell
history (Bash):

```sh
read -r -s -p 'Tavily API key: ' TAVILY_API_KEY; printf '\n'
export TAVILY_API_KEY
```

For persistent setup, create a **user-owned directory** with mode `0700` and a
regular file with mode `0600`, containing exactly:

```json
{ "apiKey": "YOUR_KEY" }
```

`config.example.json` is a placeholder, not an installed credential. The config
is plaintext, not encrypted or isolated from trusted local tools. Never store it
inside the extension installation directory or project repository.

The following optional local Python recipe prompts without echo, refuses to
overwrite an existing file, and never passes the key as a command-line argument.
Run it yourself, or explicitly approve the home-directory write before asking an
agent to execute it. It only writes config; it makes no network request.

```sh
python3 - <<'PY'
import getpass, json, os
from pathlib import Path
folder = Path.home() / '.ink' / 'web-search'
folder.mkdir(mode=0o700, parents=True, exist_ok=True)
if folder.is_symlink() or folder.stat().st_mode & 0o077:
    raise SystemExit('Use a private, user-controlled config directory (chmod 700).')
key = getpass.getpass('Tavily API key: ').strip()
if not key:
    raise SystemExit('Cancelled: empty key')
fd = os.open(folder / 'config.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump({'apiKey': key}, stream)
    stream.write('\n')
print('Configuration saved; no API request made.')
PY
```

`INK_WEB_SEARCH_CONFIG` may point to another **absolute file path**. This is useful
for isolated tests or user-managed configuration; it does not run commands or
expand `~`/shell expressions. An environment API key bypasses file reading.

File configuration is limited to 16 KiB and only a nonblank string `apiKey` field.
Invalid JSON, unknown fields, unsafe permissions, symlinks and special files are
errors. File credentials require platform support for no-follow opening; use the
environment when unavailable. Only the final component is protected against
symlink replacement: parent directories must be trusted and user-controlled.

## Local verification and migration

Before restarting an existing installation, set the new environment variable or
create the private file for account quota. No credentials are migrated
automatically; without a credential, searches run in free keyless mode after a
restart.

To verify resolution without printing the key or calling the API:

```sh
node --input-type=module -e '
import { resolveApiKey } from "/absolute/path/to/web-search/_lib/config.mjs";
try { console.log(resolveApiKey() ? "Tavily credential configured" : "No credential configured — keyless search mode"); }
catch (error) { console.error(error.message); process.exitCode = 1; }
'
```

The usual Ink startup extension diagnostic should list both tools. Local resolution
checks presence and format, **not validity with Tavily**. A live search is the next
step only with explicit approval (keyed searches consume credits; keyless searches
are rate-limited). Do not run live searches in an unattended setup script.

## Tool behavior (summary)

Both tools are tightly bounded so a hostile or oversized response cannot
flood the context. The full parameter and caching contract is in the design
document; the essentials:

- `web_search`: query ≤ 2000 chars, `max_results` 1–10, `days` 1–365 (news
  filtering), `include_domains`/`exclude_domains` ≤ 100 hostnames each,
  `full` for up to 3000 chars of raw content per source. Results are source
  snippets for the model to synthesize and cite — never a second model's
  generated answer. Total response ≤ 40,000 characters; 15-second timeout.
- `url_read`: HTTP(S) URLs ≤ 2048 chars; HTML tags and script/style blocks
  are stripped; 300,000-byte download cap, 20,000-character output cap,
  20-second timeout. Does not render JavaScript or parse binary formats.
- A 10-minute in-memory cache (≤ 64 queries) avoids repeat searches;
  authentication is checked before cache lookup.
- **Network policy limitation:** page reading can access local/private
  addresses and follows redirects. There is no SSRF isolation or
  private-network approval policy in this release — use only approved
  destinations. All returned web content is untrusted evidence, not
  instructions; warnings are not an injection security boundary.

## Terminal presentation (summary)

`web_search` shows the normalized query, requested filters, and title/hostname
previews from recognizable result text; `url_read` shows the URL and first
nonblank body lines. Expanded calls show labeled effective arguments; Alt+O
switches expanded calls between readable fields and the retained original
JSON. These display hooks never read credentials, fetch URLs, or change
requests, cached output, model content, or saved history. Previews are
deliberately conservative — source text can imitate the output format, so
ambiguous or unknown formats show a neutral "source preview unavailable"
summary instead of inferred facts.

## Troubleshooting

- No credential: searches run in free keyless mode with provider-side rate
  limits; set the environment variable or private file for higher limits.
- Config error: fix JSON/permissions/path; errors do not print file contents;
  a present-but-invalid config never falls back to keyless.
- Keyless limit (HTTP 401/403/429/432/433): wait before retrying, or configure a key.
- HTTP 401/403 (keyed): check the effective credential source; environment wins over file.
- HTTP 429 (keyed): wait before trying again.
- HTTP 432/433 (keyed): check account quota and billing limits.
- HTTP 5xx: provider service failure; try later rather than repeatedly in a loop.
- Timeout/aborted: reported separately; a failed response can still be billable.
- Invalid/oversized response: provider output did not match the bounded contract.
- Page HTTP error/unsupported type: use a public readable text or HTML source.

Raw network exception messages, response bodies on errors and HTTP status text
are not reflected into model-visible diagnostics. This is deliberate redaction.

## Development

From the Ink repository root:

```sh
npm test -- test/web-search.test.ts test/web-search-config.test.ts test/web-search-io.test.ts test/web-search-discovery.test.ts test/extensions-contrib.test.ts
```

Tests use temporary config files and mocked responses; discovery checks use the
actual extension loader. No real credentials or paid search calls are required.
Design and remaining scope:
[docs/design/web-search-extension-design.md](https://github.com/FishInSalt/ink/blob/main/docs/design/web-search-extension-design.md).
