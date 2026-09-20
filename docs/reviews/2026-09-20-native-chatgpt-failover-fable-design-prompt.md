You are the independent Fable 5.1 design reviewer for a high-leverage AI-routing
change in Codex Router. Work read-only in the repository that is your current
directory. Do not edit, commit, push, write memory, or write vault notes.
Do not run launchctl print. Do not read credentials, auth.json tokens, or
process environments that contain secrets.

Astra Medium is unavailable (operator reported no remaining Astra usage).
You are the declared Fable 5.1 fallback for this design review. Emit exactly
one standalone sentinel as the last line of your reply:

  FABLE_DESIGN: PASS
or
  FABLE_DESIGN: BLOCK — <reason>

Goal
====

Review the proposed design for opt-in native ChatGPT failover from a *routed*
Codex Router turn (Ryan's primary is grok-oauth/grok-4.6) onto the signed-in
native ChatGPT Codex backend (chatgpt.com/backend-api/codex) using the
caller's existing OpenAI account. One account is enough. This is not
ChatGPT account-pool fallback.

Ryan approved this spec in the active task on 2026-09-20 ("Please go ahead").
No production implementation edits have begun. The spec lives at
docs/superpowers/specs/2026-09-20-native-chatgpt-failover-design.md

Current state
=============

- Worktree / branch: feat/native-chatgpt-failover at HEAD caf2a970
  (parent feat/openai-account-quota-fallback).
- Live install remains /Users/ryan/.local/share/codex-router on the same
  commit; do not treat that tree as the review target if this directory is
  the worktree.
- Default model: grok-oauth/grok-4.6. Routed failover is on, empty chain
  (auto-rank). Kimi is hidden from the picker. ChatGPT account-pool fallback
  is off and has one account.
- src/model-failover.mjs comments that a native ChatGPT candidate "is spliced
  in at FAILOVER_TIER.native by the caller". The caller never does. AGENTS.md
  currently says the native ChatGPT tier is deliberately unimplemented
  because it crosses the routed/native boundary.

Required files to inspect (at minimum)
======================================

- docs/superpowers/specs/2026-09-20-native-chatgpt-failover-design.md
- AGENTS.md (failover section, especially "Not implemented: the native
  ChatGPT tier")
- src/model-failover.mjs
- src/router.mjs (handleResponses routed vs native branches,
  attemptModelFailover, failoverCandidates, nativeHeaders, nativeTarget,
  normalizeNativeInput, adoptRoute, attemptNativeAccountFailover)
- src/codex-native-session.mjs
- src/vision-bridge.mjs (hasNativeSession)
- src/search-capability.mjs
- src/control.mjs (handleFailover)
- src/doctor.mjs (failover reporting)
- src/provider-selection.mjs (canonicalProviderId, selectedConfiguredListedModels)
- test/model-failover.test.mjs
- test/model-failover-router.test.mjs
- test/chatgpt-account-fallback-router.test.mjs

Proposed architecture (must verify against the spec and the source)
===================================================================

1. New failover.json field `native` (boolean, default false). Missing or
   unreadable files must not enable it. All writers of failover.json must
   preserve the field.
2. control failover native on|off|status.
3. When native is on, failover is on, and hasNativeSession(nativeHeaders(request))
   is true, splice one synthetic candidate (highest-priority listed native
   catalog model; on this install gpt-6-astra) at FAILOVER_TIER.native for
   auto ranking. Named chains include it only if they name native/chatgpt or
   that slug.
4. attemptModelFailover must NOT call prepareRoutedRequest / LiteLLM for
   that candidate. Rebuild via the existing native branch:
   normalizeNativeInput, nativeHeaders, nativeTarget, from the pristine
   payload. Refuse non-portable bodies.
5. On native 2xx: failoverFrom = routed slug, activity provider openai,
   skip LiteLLM/Z.ai/Grok-compat/flatten restores, meter both attempts.
6. On native failure: do not walk a second native slug in v1; continue other
   routed candidates or return the original routed failure.
7. Skip: substituted callers, discovery-disabled, no session, context window
   too small vs native context_window (Astra listed 272k vs Grok 500k),
   search-contract mismatch, compaction path, subagent transport path.
8. Ryan's install is switched on after tests; the code default stays off.

Constraints the design must satisfy
===================================

- Same relayed-byte rule as existing failover (before pipeResponse,
  nothingRelayed re-check).
- Same trigger set (out_of_usage / 402 / long 429). No 401/403/400/404/5xx.
- Never trade a quota error for a native context error.
- Never put credentials, tokens, or account ids in logs, status JSON, or
  failoverFrom (failoverFrom is the routed slug or coarse native model slug).
- Never inject a transcript notice.
- Never enable native hop for Cursor/Claude/Gemini substituted callers.
- Must not silently change behavior when native is false.
- Must not pretend native GPT is a registry/LiteLLM model.
- Distinct from attemptNativeAccountFailover (native-to-other-account).

Failure modes to attack
=======================

- AdoptRoute treating a native response as a routed LiteLLM body (flatten
  restore, Z.ai/Grok transforms, gateway error translation).
- Using flattened routed aged input instead of pristine payload.
- Forwarding the router caller key as a ChatGPT bearer.
- Hopping a >272k Grok conversation onto Astra.
- Hosted-search contract broken or silently widened.
- Compaction or child-transport accidentally using the native splice.
- Default-on spending ChatGPT quota on every install.
- Account-pool path and this path racing or being confused.
- Session-from-disk vs live request session (stale auth.json after sign-out).

Verification plan the design must include (and you must judge as sufficient)
===========================================================================

Unit tests for ranking/splice/gates. End-to-end: routed quota 429, native
mock at CODEX_NATIVE_BASE_URL answers, client sees native marker;
no session / native 5xx / headersSent keep the original quota body.

What to return
==============

A short review: whether the spec matches the code it claims to extend, the
strongest remaining defect if any, and exactly one standalone sentinel line.
Do not approve if the spec would ship a hop that spends ChatGPT quota without
an explicit native:true flag, or if native success would still run routed
response transforms.
