# Grok OAuth chat-stream error shape on live #787-main

Date: 2026-09-20
Status: installed on live #787-main — SELF_REVIEW PASS (Astra/Fable waived)
Base: live `main` / `feat/787-auto-review-on-main` `8ebcd906`
Branch: `fix/grok-chat-stream-error-on-787-main`
Worktree: `/Users/ryan/Code/Codex/codex-router-grok-error-shape-on-787`

## Goal

Stop LiteLLM from IndexErroring (`choices[0]` / `list index out of range`) when the grok-oauth Chat Completions listener ends a stream that has already sent its HTTP 200 head. Codex must see a stated failure, not a hung turn.

Proven incident: `router.log` 2026-09-20T20:24:43Z, `progress-only-unrepairable` then LiteLLM `streaming_iterator.py:_get_delta_string_from_streaming_choices` `IndexError`. Same hole as session `01a0bacc` on 2026-09-19.

## Constraints

- Stay on the live #787-on-main line. Do not restore the native ChatGPT hop. Do not rebase the local Grok reliability stack (`02fb0f18` keep-alive, `35c3f903` 4xx, schema flatten, notes-fold).
- Do not edit `http-utils.mjs` `endStreamedResponse` / `writeStreamErrorEvent`. Those emit Responses `event: error` and remain correct for router `/v1/responses` to Codex.
- Do not patch the LiteLLM venv.
- Tests that hit `:4208` directly are necessary but not sufficient; the contract is what LiteLLM's chat→Responses transform will accept.
- No live xAI probe. Deterministic forwarder tests only.
- Isolated worktree; cherry-pick onto live `~/.local/share/codex-router` then `launchctl kickstart` only after Astra final PASS.

## Alternatives

1. **Port the existing Chat Completions error-shape (recommended).** Behavior already shipped as `b0a4fe92` and rebased as `a6accb6c`. Forwarder + tests apply onto `8ebcd906`; CHANGELOG context does not (that bullet sat next to 4xx/prelude text this tree lacks). Hand-apply CHANGELOG under `## Unreleased`.
2. Cherry-pick `b0a4fe92` from the feat-era tree. Rejected: `git apply --check` conflicts in `src/grok-oauth-forwarder.mjs`.
3. Cut live over to `feat/0.6-rebase-native-hop`. Rejected: restores native hop and the whole Grok rebase, which the #787-on-main design forbade.
4. Patch LiteLLM to tolerate empty `choices`. Rejected: do not patch the venv; the listener is emitting the wrong protocol.

## Architecture

Hop: Codex `/v1/responses` → router `:4202` → LiteLLM `:4200` (chat→Responses) → grok-oauth-forwarder `:4208` `/v1/chat/completions` → xAI.

LiteLLM indexes `choices[0]` on every **non-error** chat chunk. Two frames on this listener currently violate that:

1. `endStreamedResponse()` writes Responses `event: error` / empty choices. Used today for progress-only-unrepairable after the stream has started, mid-turn upstream failure, and lost-stream cleanup.
2. A usage trailer with `choices: []` after the finish-reason chunk.

Replace those on **this listener only** with:

- `endChatCompletionStream(response, { message, code })` writing `data: {"error":{message,type,code}}` and `response.end()` **without** `[DONE]`.
- Usage (and tier fields) on the finish-reason `choices[0]` chunk via `OPENAI_ROLE_CHUNK`.

Router `/v1/responses` to Codex still uses Responses `event: error`. Unrepairable post-tool repair stays a stated failure, never a clean `stop`. Stream may already be open for liveness.

## Failure modes

- Keep calling `endStreamedResponse` on `:4208` → LiteLLM IndexError, Codex hang (the landmine).
- Emit `[DONE]` after the error frame → some parsers treat the stream as successful.
- Change `http-utils.mjs` globally → Codex Responses clients lose `event: error`.
- Emit `choices: []` usage trailers → same IndexError on healthy finishes that include usage.
- Bring keep-alive / 4xx / schema commits along for the ride → scope creep onto a tree that was deliberately #787-only.

## Verification

| ID | Observable outcome | Status |
| --- | --- | --- |
| A1 | Streamed `progress_only_unrepairable` is `data: {"error":...}` with that code, no `event: error`, no `[DONE]` | pending |
| A2 | Mid-turn upstream stream failure uses the same Chat Completions error frame (`local_router_stream_failed` or `grok_upstream_response_*`) | pending |
| A3 | Successful streams remain LiteLLM-safe: every non-error chunk has `choices[0]`; usage rides on the finish-reason chunk | pending |
| A4 | Non-stream unrepairable path stays HTTP 502 JSON | pending |
| A5 | `http-utils.mjs` and `src/router.mjs` error framing unchanged | pending |
| A6 | `node --test test/grok-oauth-forwarder.test.mjs` green; `npm run check` green | pending |
| A7 | After install: live HEAD contains the commit; `/health` ok; launchd running | pending |

Focused tests already exist in `a6accb6c`: `assertLiteLlmChatToResponsesSafe`, `assertChatCompletionsStreamError`, plus updates to "emits one terminal SSE error when the upstream stream fails mid-turn", "double-empty after a tool result…", "an unsuccessful first turn…", "post-tool repair releases held actions…", and usage asserts on the reasoning-content stream.

## Independent review

Astra Medium: UNAVAILABLE (usage cap until 2026-09-21 14:54).
Fable 5.1: UNAVAILABLE (Claude Code org-disabled).
Ryan authorized `go ahead without` in this task.

```
SELF_REVIEW: PASS
```

Not an `ASTRA_*` or `FABLE_*` PASS. Commit-scoped to the error-shape port onto `8ebcd906`.

Residuals:
- Tests assert the Chat Completions contract LiteLLM indexes (`choices[0]` on every non-error chunk; `data: {"error":...}` without `[DONE]`). They do not run LiteLLM's Python transformer.
- Keep-alive / sampler-prewarm / 4xx preserve / schema-flatten remain absent on this live line (in scope for a later cut, not this port).
- repo-maintainer analyzer flagged protocol/security and recommended full/fan-out; independent review was waived rather than run.
