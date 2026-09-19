# Entry templates

## Feature batch

```
- **#<slug> <feature name>（<date>，<N> tests，`<merge-commit>`）**：
  <one-sentence outcome>. Delivered: <paths>. Review: <lens summary>.
  <N>/<N> macOS, <N> skipped Linux, audit 0.
```

## Review round

```
- **#<slug>-review <round>（<date>）**： <N> findings, <N> fixed, <N> deferred
  with reasons.  Gates: <exact numbers>.
```

A deferral always names where the work moved to (a later batch, a ledger
line) — never "later".
