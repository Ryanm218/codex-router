# Native ChatGPT failover from a routed turn — design

**Date:** 2026-09-20
**Status:** operator-approved 2026-09-20 ("Please go ahead"). Astra Medium
  unavailable (no remaining usage). Fable 5.1 via Claude Code unavailable
  (organization disabled Claude subscription access for Claude Code; no
  Anthropic API key). Ryan then said "No other usage available" and had
  already authorized proceeding. Independent review sentinels were not
  obtained. Implementation may proceed under this recorded exception and
  remains subject to tests in this worktree before any live-install switch.
**Install:** Codex Router 0.5.1 at `/Users/ryan/.local/share/codex-router`,
  checkout `caf2a970` on `feat/openai-account-quota-fallback`, live default
  `grok-oauth/grok-4.6`

## Decision

When a **routed** Codex Router turn reports it has no usage left, and nothing
has been relayed, the router may rebuild that turn for the **signed-in native
ChatGPT Codex backend** (`https://chatgpt.com/backend-api/codex`) and serve
it on the operator's existing OpenAI account.

This is the missing `FAILOVER_TIER.native` splice already named in
`src/model-failover.mjs`. It is not ChatGPT account-pool fallback (native to
another enrolled ChatGPT login). It is not Kimi. It is Grok (or any other
routed model) to the same ChatGPT account the native GPT picker already uses.

On Ryan's machine that account is the current Codex session
(`ryanmartin218@gmail.com`). One account is enough. No second login is
required.

## Why this is a new path, not a toggle

`rankFailoverCandidates` only ranks **registry** models. Native GPT slugs
(`gpt-6-astra`, `gpt-5.6-sol`, ...) have no `provider` in the registry, so they
cannot appear in that list. `attemptModelFailover` always calls
`prepareRoutedRequest` / LiteLLM. Native traffic is the other branch in
`handleResponses`: `nativeHeaders` + `nativeTarget` + `normalizeNativeInput`.

Account-pool fallback (`attemptNativeAccountFailover`) only runs when
`!route` — already-native turns — and only hops to a *different* enrolled
account. With one account it is a no-op even if switched on.

So "Grok, then my OpenAI account" cannot be configured. It has to be built.

## Goals

- Keep `grok-oauth/grok-4.6` as the default / primary routed model.
- After a qualifying routed quota/rate-limit failure, and only before the
  first relayed byte, try the signed-in native ChatGPT plan once.
- Spend that plan on the caller's live Codex session, not a router-owned
  shared session and not a second account.
- Rebuild the native request from the **pristine** payload, through the
  existing native normalizer, never by replaying a flattened routed body.
- Preserve current behavior when the native hop is off, when no session is
  on the request, or when the native model cannot hold the conversation.
- Log the hop the same way routed failover does (`failoverFrom`, never a
  sentence in the transcript).

## Non-goals

- ChatGPT account-pool / second-login fallback (already exists, still off).
- Compaction failover onto native (compaction still uses the routed
  `summarizeWith` gateway path; a native summarizer is a follow-up).
- Subagent *transport* failover onto native (that path stays
  v2-certified routed models only).
- Substituted callers (Cursor / Claude / Gemini / login-free aliases).
  Those turns do not carry a Codex ChatGPT session and must not spend one.
- Making native GPT a registry provider, a LiteLLM model, or a
  `chatgpt-web` route.
- Changing picker visibility, the default model, or re-showing Kimi.
- Claiming OpenAI endorses automatic spend of a ChatGPT plan from a
  third-party routed turn.

## Trigger (unchanged)

The hop uses the existing routed classifier. Only `out_of_usage`, HTTP 402,
or a 429 whose `Retry-After` exceeds 60 seconds qualify. Entitlement, 401,
403, 400, 404, and ordinary 5xx still do not swap. Exact-route probes still
do not swap. `nothingRelayed(response)` is re-checked before the native
fetch.

## Candidate

One synthetic candidate, not a registry model:

| Field | Value |
| --- | --- |
| slug | highest-priority **listed** native catalog model with a live session; on this install that is `gpt-6-astra` |
| provider | `openai` (activity / meter only; not a registry id) |
| native | `true` |
| contextWindow | that model's `context_window` (`272000` for `gpt-6-astra`) |
| searchTool.mode | `hosted` |
| inputModalities | from the native catalog (text + image for Astra) |
| multiAgentVersion | from the native catalog (`v2` for Astra) |

Do not use hidden or unlisted native slugs (`gpt-reserve`, daybreak, auto-review).
Do not invent a slug the catalog does not list.

## Eligibility

All of the following must hold or the hop is skipped and the original routed
failure is returned:

1. `readFailoverSettings().enabled === true`
2. `readFailoverSettings().native === true` (new flag; default **false**)
3. The request is a Codex-authenticated native-capable caller:
   `hasNativeSession(nativeHeaders(request))`
4. `callerBroughtNoUpstreamCredential(request)` is false
5. Discovery is not disabled
6. The native `context_window` can hold `estimateInputTokens` of the body
   about to be sent (Grok is 500k; Astra listed is 272k — a fat Grok
   conversation must not become a native context error)
7. Search contract: Grok's hosted search is preserved by native hosted
   search. If the required mode cannot be preserved, skip.
8. Image turns: native Astra accepts images; a text-only native slug would
   still be eligible only if the vision bridge can stand in, matching routed
   rules.
9. Named chain: if `failover.json` `chain` is non-empty, native is used only
   when the chain names `native/chatgpt` or the chosen native slug. Auto
   ranking (empty chain) splices native at `FAILOVER_TIER.native` (after
   free, before other subscription models).

Ryan's live settings are failover on, empty chain, Kimi hidden. Enabling
`native: true` therefore makes the only auto hop the signed-in ChatGPT plan.

## Request rebuild

Do not call `prepareRoutedRequest` for this candidate.

From the pristine `payload`:

1. Copy payload; set `model` to the native slug (translate any
   native-context-variant slug back the way the native branch already does).
2. `normalizeNativeInput` on `payload.input` with the same flags the native
   branch uses for a Codex caller (not the substituted-caller flags).
3. Age tool results only if native aging is on, matching the native branch.
4. Strip `previous_response_id` unless this is compact v1, matching native.
5. `target = nativeTarget(requestUrl.pathname)`
6. `headers = nativeHeaders(request)` (forwards the caller's ChatGPT
   session; never the router caller key)
7. Refuse the hop if the native body is not portable under the same
   forbidden-key walk as account-pool fallback (`previous_response_id` after
   strip is already gone; still refuse leftover `encrypted_content` /
   `conversation_id` / file ids that cannot be replayed onto ChatGPT).
   If the native normalizer already dropped unusable reasoning, that is the
   portable form.

Fetch that request. On 2xx, adopt it as the serving response:

- `failoverFrom` = the routed slug that failed
- activity provider `openai`, model = native slug
- **do not** run LiteLLM / Z.ai / Grok-reasoning / flattened-namespace
  restore transforms; this response is already native
- meter both the failed routed attempt and the native serving row, with
  `failoverFrom` on the serving row

On native failure, do not walk a second native slug in v1. Record the
outcome, then continue any remaining **routed** candidates (none on Ryan's
install once Kimi is hidden), else return the original Grok failure.

## Settings and control

`failover.json` gains `native` (boolean, default false). Unreadable /
missing file stays `{ enabled: true, chain: [], native: false }` for the new
field so existing installs do not start spending ChatGPT quota.

```
control failover native on|off|status
```

`status` reports `native` plus whether the current request-time gate would
have a session (doctor uses `nativeSessionStatus().usable` as the
offline approximation, and says so).

Ryan's install is switched **on** as part of landing this feature, after
tests pass. That is an operator setting write, not a default-on change for
every Codex Router user.

## Compaction and children

- Ordinary `/responses` turns: native hop in scope.
- Routed compaction (`summarizeWith`): out of scope for v1. If Grok is empty,
  compaction keeps today's routed candidate list.
- Subagent transport failover: out of scope for v1.
- Collaboration parent turns that already went routed: eligible for the
  ordinary native hop if the native slug is v2, which Astra is.

## Failure and logging

Same contract as routed failover:

- Never gated on `CODEX_ROUTER_QUIET`
- `[codex-router] failover model=<routed> status=<n> reason=<k> -> gpt-6-astra outcome=...`
- No assistant-visible notice
- Original routed failure is what the client sees if native is skipped or
  fails

## Tests (must fail first)

Unit (`test/model-failover.test.mjs`):

- Auto ranking with `native: true` and a session splices the native candidate
  at tier `FAILOVER_TIER.native`
- `native: false` (default) does not splice it
- No session / substituted caller / discovery-disabled: no splice
- Context window too small: no splice
- Named chain without `native/chatgpt` or the native slug: no splice
- Named chain with `native/chatgpt`: native is first among eligible

End to end (`test/model-failover-router.test.mjs` or a sibling):

- Routed quota 429, native mock at `CODEX_NATIVE_BASE_URL` answers; client
  bytes are the native marker, not the quota body; `failoverFrom` is the
  routed slug
- Missing Authorization: original quota body reaches the client
- Native 401/500: original routed quota body reaches the client
- After `headersSent`, no native fetch

## Docs

Replace the AGENTS.md paragraph **Not implemented: the native ChatGPT tier**
with the rules above. Doctor's failover line must mention native on/off.

## Rollback

Set `control failover native off`. Behavior returns to today's routed-only
failover. No account-pool or picker change is required to undo it.

## Prior art

Continuing Codex Router's own failover subsystem. External multi-account
proxies (`codex-multi-auth`, `codex-lb`) are the wrong layer: this hop is
routed-provider to the already-signed-in native backend, not a second
OpenAI login. Verdict: **EXISTS — BUT INSUFFICIENT** (the splice is named
in-tree and unimplemented).
