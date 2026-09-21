# Grok repair liveness and pre-header retry

Date: 2026-09-21
Status: proposed
Repo: codex-router worktree `fix/grok-repair-liveness` at `288de3ba`

## Problem

Live `grok-oauth/grok-4.7` traffic from 18:08–21:23 BST on 2026-09-21 (242 hops, one Codex client) had 226 HTTP 200s, 7 HTTP 502s, and 9 status-0 client closes. Two of those failure shapes are caused by the forwarder. One is not.

### Silent optional repair, then the 10-minute stall

`src/grok-oauth-forwarder.mjs` opens the Chat Completions SSE response before the upstream body is read. After a progress-only first attempt it starts a repair `POST /responses`.

The strict after-tool repair writes `reasoning_content` deltas to that SSE response as they arrive, and holds content and tool calls until `response.completed`. The optional repair (a user-message progress-only stop, `strictAfterToolRepair === false`) writes nothing until the repair is classified. Tool and content deltas stay withheld on purpose. Reasoning deltas are withheld too.

The router's post-prologue stall guard (`CODEX_ROUTER_GROK_STREAM_STALL_MS`, ten minutes, `src/empty-completion-guard.mjs`) starts when the prologue is released. After that release, any further upstream chunk resets the timer. A repair that writes no chunks for ten minutes is aborted. The forwarder's `AbortController` then fires, and the log is:

```text
[grok-oauth] upstream-phase-failed=true phase=repair ... error=AbortError
[codex-router] timing ... model=grok-oauth/grok-4.7 status=502 total_ms=~632000
```

Four 4.7 hops matched that shape (18:41, 18:52, 19:02, 19:53 BST): headers in 2–3s, a first upstream event within a few seconds, then `repair_total_ms` of 607–624s and router `total_ms` of about 632s. That is the stall bound plus the short first attempt, not an Undici body timeout (the forwarder pool is stall + 60s).

### Pre-header transport failures are not retried

`requestUpstream` performs one `fetch`. `isRetryableTransportError` in `src/upstream-retry.mjs` classifies `EPIPE`, `ETIMEDOUT`, and `UND_ERR_CONNECT_TIMEOUT` as transport failures, and it refuses `AbortError`. The Grok forwarder does not call it. Missing response headers does not prove xAI never started the generation: the POST may already have been accepted. A retry is a second generation and can be billed. That cost is accepted, once, because the alternative observed in the log is a dead turn.

On 2026-09-21 the forwarder logged attempt-phase failures with `attempt_headers_ms=none`:

- `UND_ERR_CONNECT_TIMEOUT` at 10.5s
- `EPIPE` at 69s
- `ETIMEDOUT` at 73s

Those became request failures before `startStream()`, so no client byte had been sent. A dead HTTP/1.1 socket can sit until the OS gives up; a second connection is a different attempt.

### Not this change

- `terminal=failed` on a repair (19:56 and 20:43 BST, 51s and 246s) is xAI's own verdict. `docs/TROUBLESHOOTING.md` releases `response.failed` immediately and does not retry it. Keep that.
- Status 0 lines that match Codex `turn_aborted` reason `interrupted` are the client leaving. Do not retry `AbortError`.
- Do not change `DEFAULT_GROK_STREAM_STALL_MS`. A pause with no events is still the ten-minute guard. Heartbeats stay on the router, after `response.created`, and are not a substitute for forwarded reasoning.
- Do not retry a fetch that already recorded `headersAt`. The body may have been partially read and the SSE head may already be committed.
- Do not retry more than once. Do not change `NATIVE_RETRY_BUDGET_MS` or the shared pool keep-alive.

## Behavior

1. While a streamed progress-only repair is being read, write each `reasoning_content` delta to the already-open SSE response, whether or not the repair is the strict after-tool path. Do not write content deltas or tool-call deltas in that loop.
2. Classification is unchanged. An optional repair that calls a tool still appends only its tool deltas after `response.completed`. Those tool bytes are absent until that terminal. An optional repair that does not call a tool, or that ends `failed` or `incomplete`, still keeps the first answer and still omits the repair's visible text. Reasoning deltas already written stay on the response: discarding the repair does not unsend them. A strict repair still certifies tool calls or a private final answer only after a successful terminal, and a failed terminal is still one Chat Completions `data: {"error":...}` with no `[DONE]`.
3. `requestUpstream` retries once when the fetch throws, the caller signal is not aborted, `isRetryableTransportError` is true, and that attempt has no `headersAt`. The retry is a new `fetch` with a new `x-grok-req-id`. It can bill a second generation if xAI accepted the first POST and this process never saw its headers. That one extra generation is the accepted bound. If the caller signal is already aborted, including when the transport error is `AbortError`, there is no second fetch. Log `upstream-preheader-retry=true` with phase, model, error name, and cause code. No response body and no token. A second failure propagates as it does today (HTTP 502 before the SSE head, or the existing repair-failure path when the failing call is the repair). There is no third fetch.

## Acceptance

| ID | Outcome | Status |
| --- | --- | --- |
| A1 | A streamed optional repair emits `reasoning_content` before the repair terminal, and does not emit the repair's output text or tool-call bytes before that terminal | verified |
| A2 | After an optional repair with no tool call completes, the client still receives the first answer, plus any repair reasoning already streamed, and not the repair's output text | verified |
| A3 | A strict after-tool repair still withholds tool-call bytes until `response.completed`, and still streams reasoning before that | verified |
| A4 | The first `POST /responses` that dies before headers with `ECONNRESET` is sent a second time, the two `x-grok-req-id` values differ, and the client receives the second attempt's completion | verified |
| A5 | A fetch that fails after headers is not retried. A caller abort during the first fetch, including when that surfaces as `AbortError`, is not retried | verified |
| A6 | A second pre-header failure is not followed by a third request | verified |
| A7 | An optional repair that streams reasoning and then ends `failed` or `incomplete` is not replayed. The first answer remains, the repair's visible text does not, and the reasoning already written remains | verified |

## Review

Architecture review on 2026-09-21, Astra Medium, Codex session `01a0c5b1-815a-7ab0-bba7-438322b23fd2`: `ASTRA_ARCHITECTURE: PASS`. That review approved this shape: live repair reasoning only, one fetch-level pre-header retry, no post-header replay, no terminal-failure replay.

Design review in that same session: `ASTRA_DESIGN: BLOCK`. This revision records the duplicate-generation bill, the visible discarded-repair reasoning, the chunk-level stall reset, and the missing abort, request-id, and optional-tool tests.

Second design review on 2026-09-21, Astra Medium, Codex session `01a0c5b3-3f06-7852-945e-85acd2c13caa`: `ASTRA_DESIGN: PASS`.

Final review on 2026-09-21, Astra Medium, Codex session `01a0c5b7-a160-75c1-ab10-59f57829475e`: `ASTRA_REVIEW: PASS`. Evidence: `node --test test/grok-oauth-forwarder.test.mjs` 77 pass, `npm run check` syntax pass, `git diff --check` clean.

## Verification

`node --test test/grok-oauth-forwarder.test.mjs` from the worktree: 77 passed, 0 failed, on 2026-09-21 after the implementation. No live xAI call. No LiteLLM venv edit. No kickstart until a later install step outside this spec.
