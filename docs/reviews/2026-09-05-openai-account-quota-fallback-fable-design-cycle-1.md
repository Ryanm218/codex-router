# Fable design review — cycle 1

**Date:** 2026-09-05
**Command status:** exit 0
**Verdict:** blocked

The reviewer accepted the overall in-process architecture, credential boundary,
replay boundary, fail-closed defaults, and rollback strategy, but required five
design corrections before a TDD plan:

1. only root tasks may reserve an account; subagents may inherit a positive root
   binding or stay primary-only, and negative rollout lookups must not be cached;
2. persisted reservations need explicit state, generation/nonce, deadline, and
   restart behavior;
3. `x-codex-turn-state` must block cross-account movement, and terminal quota
   must use exact captured error types/codes rather than prose matching;
4. backup catalog acquisition must use the existing login lease/finalize path,
   while request-use leases protect destructive profile operations;
5. request-path account-pool lock acquisition must be bounded by the remaining
   failover budget rather than the control plane's two-minute default.

Important advisories also required clone-based original-response preservation, a
dedicated affinity secret, upstream-compatible account-pool schema, exact active-
account token matching rather than generic bearer matching, background rather
than inline 401 refresh, explicit first-event stream priming, UID/size/re-stat
auth checks, a Codex-only quit signal, pre-router Kimi-state migration, named
catalog compatibility fields, platform caveats, and honest UI copy explaining
that opaque mid-task state will not move accounts.

The detailed review is retained in the private Fable design log at
`~/.claude/logs/fable-design-review.log`. All required corrections and advisories
were incorporated into the design before cycle 2.

FABLE_DESIGN: BLOCK — subagent family resolution, reservation schema, header-carried opaque state, backup acquisition lease, and request-path lock bound must be specified before the TDD plan
