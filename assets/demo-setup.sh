#!/usr/bin/env bash
# Recreates the scratch project used by assets/demo.tape:
#   bash assets/demo-setup.sh && vhs assets/demo.tape
# The sandbox lives in /tmp/ink-demo (never committed) so the recorded demo
# is reproducible without depending on any repository content.
set -euo pipefail

sandbox="/tmp/ink-demo"
rm -rf "$sandbox"
mkdir -p "$sandbox/src"

cat > "$sandbox/README.md" <<'EOF'
# pulse

A tiny health-check CLI. `pulse check <url>` polls an endpoint once and
prints its status and latency; `pulse watch <url>` repeats the check
every few seconds until interrupted.
EOF

cat > "$sandbox/package.json" <<'EOF'
{
  "name": "pulse",
  "version": "1.0.0",
  "type": "module",
  "bin": { "pulse": "src/check.ts" }
}
EOF

cat > "$sandbox/src/check.ts" <<'EOF'
const target = process.argv[2] ?? "https://example.com";

export async function check(url: string): Promise<number> {
  const started = Date.now();
  const response = await fetch(url, { method: "HEAD" });
  const latency = Date.now() - started;
  console.log(`${url} -> ${response.status} (${latency}ms)`);
  return latency;
}

await check(target);
EOF

echo "demo sandbox ready: $sandbox"
