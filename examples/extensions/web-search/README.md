# Web search extension

A zero-dependency Node.js extension providing `web_search` (Tavily) and `url_read`
(HTTP page text). Authentication and configuration belong to this extension, not
imp's model provider registry or `/login` command. Requires imp's Node >=20 runtime.

## Installation

Copy this **entire directory**, including `_lib/`, into
`~/.imp/extensions/web-search/`, or link this directory there. Project-local
`.imp/extensions/web-search/` also works when the project is trusted.
Alternatively use an explicit entry:

```sh
imp -e /absolute/path/to/web-search/index.mjs
```

Do not copy `index.mjs` alone. An explicit `-e` directory means a directory to
scan, not necessarily a single extension entry; use the entry path above.
The old repository path `examples/extensions/web_search.mjs` no longer exists;
install this directory instead. Install only one copy: independently
installed copies at different paths are not deduplicated.

To upgrade, replace the installed package while keeping user configuration
separate. To uninstall, remove its installed copy/link after checking the path.
Uninstalling does not remove your private config. Restart imp after code updates;
credential changes are picked up at the next search.

An agent must obtain approval before changing files outside its workspace, such
as installing into `~/.imp/` or editing shell configuration.

## Credentials

Get an API key from your Tavily account: https://app.tavily.com/ . Search requests
may consume credits. The extension does not automatically retry or switch providers.
Page reading does not require a Tavily key.

Resolution order:

1. Nonblank `TAVILY_API_KEY` environment variable.
2. `apiKey` in `~/.imp/web-search/config.json`.

Only `TAVILY_API_KEY` is recognized. Rename older environment variable settings;
there is no old-variable compatibility or unauthenticated search fallback. Do not
paste a real key into an agent conversation, tool arguments, source code, or a
checked-in project configuration.

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
folder = Path.home() / '.imp' / 'web-search'
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

`IMP_WEB_SEARCH_CONFIG` may point to another **absolute file path**. This is useful
for isolated tests or user-managed configuration; it does not run commands or
expand `~`/shell expressions. An environment API key bypasses file reading.

File configuration is limited to 16 KiB and only a nonblank string `apiKey` field.
Invalid JSON, unknown fields, unsafe permissions, symlinks and special files are
errors. File credentials require platform support for no-follow opening; use the
environment when unavailable. Only the final component is protected against
symlink replacement: parent directories must be trusted and user-controlled.

## Local verification and migration

Before restarting an existing installation, set the new environment variable or
create the private file. No credentials are migrated automatically. A missing key
now produces a local setup error without sending a request to Tavily.

To verify resolution without printing the key or calling the API:

```sh
node --input-type=module -e '
import { resolveApiKey } from "/absolute/path/to/web-search/_lib/config.mjs";
try { console.log(resolveApiKey() ? "Tavily credential configured" : "Not configured"); }
catch (error) { console.error(error.message); process.exitCode = 1; }
'
```

The usual imp startup extension diagnostic should list both tools. Local resolution
checks presence and format, **not validity with Tavily**. A live search is the next
step only with explicit approval to consume API credits. Do not run live searches
in an unattended setup script.

## Tool behavior

`web_search` parameters:

| Parameter | Contract |
| --- | --- |
| `query` | Nonblank string, at most 2000 characters |
| `max_results` | Integer 1–10; default 5 |
| `days` | Integer 1–365; uses the existing Tavily `news` topic and `days` mapping |
| `include_domains`, `exclude_domains` | Up to 100 hostname strings each |
| `full` | Include up to 3000 characters of raw content per source |

Filters are normalized, deduplicated and sorted; IDNA domain names are accepted.
URLs, paths, ports, wildcards, IP addresses and single-label names are not domain
filters. Include/exclude overlap is rejected. `days` is provider-specific news
filtering, not a general date range; current provider compatibility is not live-
verified by the unit tests.

Requests explicitly use `search_depth: basic` and `include_answer: false`.
The tool returns source results for the parent model to synthesize and cite, not
a second model's generated answer. Invalid source entries are skipped. Empty
results are a normal response; wholly malformed nonempty results are an error.
Source URLs are never shortened; oversized URLs are skipped. Warnings, metadata
and truncation markers count toward the 40,000-character total limit.

Search responses have a 1 MiB decoded-body byte cap and a 15-second timeout.
The 10-minute in-memory cache holds at most 64 queries, is shared across `/new`
within one extension instance, and clears on observed credential changes or
configuration errors. Failed requests are not cached; there is no disk cache or
parallel-request deduplication. Authentication is checked before cache lookup.

`url_read` accepts HTTP(S) URLs without embedded credentials, at most 2048
characters. HTML script/style blocks and tags are stripped; plain text, JSON and
XML remain text. It does not render JavaScript or parse arbitrary binary formats.
A streaming 300,000-byte download cap and a 20,000-character total output cap
include explicit truncation notices. Timeout is 20 seconds. Character limits
count JavaScript UTF-16 units while avoiding split surrogate pairs.

**Network policy limitation:** page reading can access local/private addresses
and follows redirects. This release does not implement SSRF isolation or a
private-network approval policy. Use only approved destinations. All returned web
content is untrusted evidence, not instructions; warnings are not an injection
security boundary. Successful source text may contain arbitrary remote content.

## Troubleshooting

- Missing key: configure the environment or private file using the rules above.
- Config error: fix JSON/permissions/path; errors do not print file contents.
- HTTP 401/403: check the effective credential source; environment wins over file.
- HTTP 429: wait before trying again.
- HTTP 432/433: check account quota and billing limits.
- HTTP 5xx: provider service failure; try later rather than repeatedly in a loop.
- Timeout/aborted: reported separately; a failed response can still be billable.
- Invalid/oversized response: provider output did not match the bounded contract.
- Page HTTP error/unsupported type: use a public readable text or HTML source.

Raw network exception messages, response bodies on errors and HTTP status text
are not reflected into model-visible diagnostics. This is deliberate redaction.

## Development

From the imp repository root:

```sh
npm test -- test/web-search.test.ts test/web-search-config.test.ts test/web-search-io.test.ts test/web-search-discovery.test.ts test/extensions-contrib.test.ts
```

Tests use temporary config files and mocked responses; discovery checks use the
actual extension loader. No real credentials or paid search calls are required.
Design and remaining scope: `docs/web-search-extension-design.md`.
