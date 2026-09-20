# Native ChatGPT Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** When a routed Codex Router turn (Ryan's primary is grok-oauth/grok-4.6) reports no usage left, rebuild it once for the signed-in native ChatGPT Codex backend on the caller's existing OpenAI account.

**Architecture:** Add an opt-in `native` flag to failover.json (default false). Rank a synthetic native candidate at FAILOVER_TIER.native. In attemptModelFailover, skip LiteLLM for that candidate and rebuild through nativeHeaders / nativeTarget / normalizeNativeInput from the pristine payload. On 2xx, serve as a native response (no routed transforms). On failure, keep the original routed error.

**Tech Stack:** Node ESM, existing Codex Router failover and native Responses path, node:test.

**Spec:** docs/superpowers/specs/2026-09-20-native-chatgpt-failover-design.md

**Approval:** Ryan 2026-09-20. Astra Medium and Fable 5.1 were unavailable; operator authorized proceeding without those sentinels.

## Global Constraints

- Default `native: false`; missing/unreadable failover.json must not enable it.
- Same trigger set as routed failover (out_of_usage / 402 / long 429).
- Before first relayed byte; re-check nothingRelayed.
- Never trade quota for a native context error (Astra listed 272k vs Grok 500k).
- Live request session only (`hasNativeSession(nativeHeaders(request))`).
- No hop for substituted callers, discovery-disabled, compaction, or subagent transport.
- No credentials/account ids in logs; failoverFrom is the routed slug.
- No transcript notice. No LiteLLM/Z.ai/Grok-compat transforms on a native 2xx.
- Distinct from attemptNativeAccountFailover.

---

### Task 1: Failover settings `native` flag

**Files:**
- Modify: `src/model-failover.mjs`
- Test: `test/model-failover.test.mjs`

**Interfaces:**
- Produces: `readFailoverSettings()` includes `native: boolean` (default false). `setFailoverNative(enabled)` writes it and preserves enabled/chain.

- [x] Write failing tests for default false, preserve on enable/chain writes, setFailoverNative on/off.
- [x] Implement defaultSettings/unreadableSettings/read/setFailoverEnabled/setFailoverChain/setFailoverNative.
- [x] Run `node --test test/model-failover.test.mjs`.

### Task 2: Rank native candidate

**Files:**
- Modify: `src/model-failover.mjs`
- Test: `test/model-failover.test.mjs`

**Interfaces:**
- Produces: `rankFailoverCandidates(models, { nativeCandidate, chain, ... })` splices `nativeCandidate` at `FAILOVER_TIER.native` on auto rank; named chain includes it only for `native/chatgpt` or its slug. `failoverTier(nativeModel)` returns native when `model.native === true`.

- [x] Write failing ranking tests (auto splice, default no splice when omitted, named chain, context too small, same search hosted).
- [x] Implement splice in rankFailoverCandidates and failoverTier.
- [x] Run the unit file.

### Task 3: Native candidate builder + routed hop

**Files:**
- Modify: `src/model-failover.mjs` (optional `nativeFailoverCandidateFromCatalog`)
- Modify: `src/router.mjs` (`failoverCandidates`, `attemptModelFailover`, `handleResponses` adopt/pipeline)
- Modify: `src/control.mjs` (`control failover native on|off|status`)
- Modify: `src/doctor.mjs`
- Modify: `AGENTS.md` (replace "Not implemented: the native ChatGPT tier")
- Test: `test/model-failover.test.mjs`
- Test: `test/model-failover-router.test.mjs`

**Interfaces:**
- `nativeFailoverCandidateFromCatalog({ models, hidden })` -> listed native model with `native: true`, `provider: "openai"`, `contextWindow`, `searchTool: { mode: "hosted" }`.
- `attemptModelFailover` for `model.native` builds native request; returns `{ route, built, upstream, native: true }`.
- Serving a native 2xx must not run routed transforms (`route.native` or clear routed flags). Failed native hop does not walk a second native slug.

- [x] Write e2e: routed quota 429 + native mock 200 -> client sees native marker; no session keeps quota body; native 500 keeps quota body.
- [x] Implement builder, hop, control, doctor, AGENTS.md.
- [x] Run unit + e2e failover tests.
- [x] After tests pass, `control failover native on` on the live state dir is a separate operator step after merge; do not enable in source defaults.

