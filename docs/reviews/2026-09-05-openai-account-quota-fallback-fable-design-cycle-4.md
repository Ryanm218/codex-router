# Fable design review — cycle 4

**Date:** 2026-09-05
**Command status:** exit 0
**Reviewed scope:** implemented POSIX first-turn OpenAI-account quota fallback,
catalog refresh, lock/lease ordering, tray lifecycle trigger, tests, and docs
**Log evidence:** `/Users/ryan/.claude/logs/fable-design-review.log`
**Sentinel evidence:** exactly one standalone PASS and zero BLOCK sentinels in
the cycle-4 command output
**Verdict:** approved, with two corrections required before commit

## Required corrections

1. Correct the design's stale WebSocket claim. Native Responses WebSocket first
   turns currently re-enter the HTTP path with the original ChatGPT bearer and
   account identity. They therefore follow the same portability rules as HTTP;
   no deny-only transport marker or blanket no-hop rule is implemented.
2. Evaluate portability against the normalized pre-compression JSON buffer.
   The current request path passes the possibly zstd-compressed wire buffer to
   the JSON scanner, causing realistic large Codex requests to fail closed and
   making the feature effectively inert. Preserve the compressed bytes for
   every network attempt and add a large-body regression test.

## Sentinel

```text
FABLE_DESIGN: PASS
```
