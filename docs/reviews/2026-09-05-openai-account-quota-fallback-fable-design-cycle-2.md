# Fable design review — cycle 2

**Date:** 2026-09-05
**Command status:** exit 0
**Verdict:** blocked

Fable verified the corrected design against current upstream source. The overall
architecture still holds, and the cycle-1 corrections were substantially
accepted, but implementation remains blocked on five source-specific seams:

1. upstream's external-model failover has no native-origin adapter; the design
   must specify native payload normalization, routed response-transform
   adoption, portability, and shared attempt/budget accounting for the final
   Kimi hop;
2. caller consent must compare the incoming ChatGPT token against the canonical
   active auth, not the potentially stale profile snapshot, and a bound account
   equal to the active selection must pass through unchanged;
3. `refresh-pending` and quota observations must live in an additive fallback
   sub-object rather than upstream's closed `health.state`, and the new dedicated
   affinity secret needs an exact path, owner-only creation, and invalidation
   contract;
4. request-time catalog eligibility must use lock-free snapshot reads plus a
   generation recheck, because the publication lock has a two-minute control-
   plane wait and may cover a synchronous Codex probe;
5. WebSocket requests re-enter the same HTTP `/responses` path and cannot be
   excluded as currently written; they need the same gates or an explicit local
   marker, with stored `x-codex-turn-state` remaining fail closed.

Advisories require a request-lease deadline, exact switch-compatible account
catalog shape, metadata rather than strict Codex-version compatibility, an
explicit `x-oai-attestation` rule backed by a persisted fixture, a POSIX-only
runtime boundary or Windows metadata cache, removal of the contradictory inline
refresh/SSE quota language, ascending priority, variant-to-base slug mapping,
primary-only router-originated native calls, support-bundle artifact inventory,
and the named additional tests.

The complete output is retained in the private Fable design log at
`~/.claude/logs/fable-design-review.log`. Per the repository operating contract,
two failed design cycles stop the task before production implementation and
require escalation to Ryan.

FABLE_DESIGN: BLOCK — native-origin entry into external failover, canonical-token caller gate with selected-account passthrough, additive fallback state fields plus a defined affinity secret, lock-free request-path catalog reads, and WebSocket re-entry governance must be specified before the TDD plan
