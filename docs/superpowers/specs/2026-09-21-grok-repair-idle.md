# Grok repair idle — design

Date: 2026-09-21. Base: live `main` `310fd3f9`. No production code in this revision; the tests that name the new behavior are red on purpose.

## Goal

A Grok OAuth progress-only repair that stops sending bytes must end on its own, instead of holding the Codex turn silent until the 10-minute stream stall or a manual cancel.

## What is failing

Codex `/v1/responses` → router `:4202` → LiteLLM `:4200` → grok-oauth-forwarder `:4208` → `cli-chat-proxy`. After a progress-only stop the forwarder opens a second upstream POST (the repair). Visible text and tool calls stay withheld until that repair is classified. Reasoning bytes are forwarded, but a dead repair often sends one early event and then nothing.

The router's post-prologue stall (`CODEX_ROUTER_GROK_STREAM_STALL_MS`, default 10 minutes) is the only bound on that silence. It is the right bound for a primary attempt, because Grok can pause between reasoning events for minutes and those events reset the timer. It is the wrong bound for a repair: the client has no answer to read, so the turn looks frozen.

Evidence from `~/.codex/codex-router/router.log` and `router.log.1` (read 2026-09-21 22:10 BST):

- 147 completed `progress-only-retried=true` repairs. Time from `repair_first_event_ms` to `repair_total_ms`: p50 12s, p90 39s, p99 76s, max 91s.
- 71 `phase=repair` failures. 53 lasted at least 60s; the long ones are `AbortError` at roughly 250–662s. That is the client cancel (`turn_aborted` / `interrupted`, hop status 0) or the 10-minute stall (hop status 502, `emptyCompletionPreludeLimit=time`, duration about 632s).
- Tonight's breakout-study thread (`01a076be`, grok-4.7, ~440k input) produced 10 interrupts. After the 21:47 liveness patch, 22:00 and 22:04 BST were still repair `AbortError`s (246s and 238s) with a first event near 26s and then silence.

Headers on these hops still arrive in about 2s. The router process is healthy. The freeze is the repair body.

## Constraints

- Do not shorten `GROK_STREAM_STALL_MS`, `grokTransportIdleTimeoutMs`, or `grokGatewayStreamTimeoutSeconds`. Primary-attempt reasoning pauses stay on the 10-minute guard, and every ordinary hop must still outlast that guard.
- The repair idle applies only to the repair body's read loop. It is an exception to "every hop outlasts the stall", scoped to the second POST.
- Idle resets on every upstream byte, not on parsed reasoning events. A repair that keeps sending bytes may run longer than the idle.
- Default idle is 120s. That sits above the longest observed successful repair tail (91s) and well under the stall. `CODEX_ROUTER_GROK_REPAIR_IDLE_MS=0` disables it. A non-finite, negative, or timer-unsafe value falls back to 120s.
- Strict after-tool repair stays a stated failure. On idle, write one Chat Completions `data: {"error":{message,type,code}}` frame with code `grok_repair_idle` and close without `[DONE]`. Do not emit Responses `event: error`, an empty `choices` array, or a clean `stop`. Do not release the held progress sentence.
- Optional repair (after a user message) keeps attempt 1. Idle discards the repair the same way an incomplete optional repair is discarded today. Reasoning already written is not unsent.
- A client abort (`controller.signal` already aborted) is not converted into `grok_repair_idle`. Rethrow so the hop stays status 0.
- No live xAI call in tests. Both attempts can still be billed when xAI accepted the repair POST; the idle does not add another POST.
- Do not change `http-utils` `endStreamedResponse` / `writeStreamErrorEvent`.

## Alternatives

- Shorten the global stall to a minute. Rejects legitimate primary-attempt reasoning pauses. Not acceptable.
- Emit synthetic "still working" commentary while the repair is silent. Adds chatter on a path that already restates plans, and the turn still does not finish. Not acceptable.
- Retry the repair POST. The silence starts after headers and often after a first event, so this is not a connect failure. A second POST can bill another generation and hang the same way. The existing pre-header retry stays as it is.
- 60s idle. Nine successful repairs had a first-event-to-end tail over 60s (max 91s). A silent gap that long would be clipped. 120s is the evidence-based floor.

## Architecture

- `grokRepairIdleMs()` lives next to `grokStreamStallMs()` in `src/grok-stream-timeouts.mjs`. The forwarder reads it once per repair.
- `consumeResponsesStream` takes an optional idle. Only the repair call site passes it. The primary attempt is unchanged.
- The idle races `reader.read()`. On expiry it cancels the reader and rejects with `error.name === "GrokRepairIdleError"`. Any received byte clears the timer.
- The repair `catch` maps that error, when the client signal is not aborted, onto the existing branches: `repairFailure.code = "grok_repair_idle"` when `strictAfterToolRepair`, otherwise leave attempt 1 in place and do not classify the partial repair. Log `repair-idle=true` with the same `repair_*` timing fields, not gated on `MODEL_ROUTER_QUIET`.
- The router's empty-completion guard then sees either attempt-1 output or one terminal error frame, so it does not sit until `GROK_STREAM_STALL_MS`.

## Failure modes

- Idle too short clips a slow valid repair. Optional turns fall back to the first answer. Strict turns get a stated error the client can retry. The 120s default is above every successful tail in the log sample.
- Idle races a client cancel. The aborted signal wins; no synthetic error is written onto a dead socket.
- Reasoning was already forwarded. It stays. Strict idle does not also emit the held prose. Optional idle still emits attempt-1 content afterwards.
- Idle disabled (`0`) restores today's wait. The 10-minute stall remains the backstop whenever the idle does not fire.
- The repair POST may already have been billed. Idle does not hide that and does not send a third request.

## Verification

- `grokRepairIdleMs` unit cases: default 120000, `0` disables, garbage falls back, a positive value is honored. Transport and gateway bounds stay at 660s when the repair idle is set.
- Streamed strict repair: attempt 1 is a short completed progress sentence. Attempt 2 calls `flushHeaders()`, writes one reasoning SSE event, then sends no further bytes. The idle is armed on the following read. With the idle set to a few hundred milliseconds, the client receives one `grok_repair_idle` Chat Completions error, no `[DONE]`, and no released tool or progress text. This fails today because that second body is still open when the test deadline passes.
- Streamed optional repair with the same flushed-then-silent second body: the client receives attempt 1's text and a normal stop, and stderr contains `repair-idle=true`.
- Byte reset, not a total-duration timer and not a parsed-event timer: idle 300ms. The repair writes incomplete SSE fragments (no blank-line boundary, so nothing is parsed) every 100ms for 700ms, then a certified tool call and `response.completed`. Gaps stay under the idle, the whole repair lasts longer than the idle, and the first parsed event arrives after the idle. The client receives the tool call and no `grok_repair_idle`.
- Client abort after the repair body has started: abort the client fetch before the idle. Stderr shows the abort and does not contain `repair-idle=true`. The hop is not relabeled as `grok_repair_idle`.
- Idle implementation: the timeout rejection settles the read promise before `reader.cancel()`. A later EOF or abort from that cancel must not replace `GrokRepairIdleError`. Clear the timer on every exit, including the byte-received path and the caller-abort path.
- Existing `test/grok-oauth-forwarder.test.mjs` and `test/grok-stream-timeouts.test.mjs` stay green. No live xAI probe.

## Review

- 2026-09-21 architecture: `ASTRA_ARCHITECTURE: PASS`. Reviewer gpt-6-astra at medium reasoning, Codex session `01a0c5d2-b396-7d53-a8dc-728dfd47c67b`. Scope: repair-only byte idle, primary stall and transport bounds unchanged, strict `grok_repair_idle` versus optional keep-first, client abort rethrown.
- 2026-09-21 design, first cycle: `ASTRA_DESIGN: BLOCK — Silent mocks do not flush headers; reset and repair-abort verification must cover the stated invariants.`
- 2026-09-21 design, second cycle: `ASTRA_DESIGN: PASS`. Reviewer gpt-6-astra at medium reasoning, Codex session `01a0c5d5-b444-7c63-a56d-2df084bcd598`.

## Install

After the tests pass and an independent final review passes: cherry-pick onto the live checkout `~/.local/share/codex-router` and kickstart `io.github.codex-router`. Kickstart drops in-flight turns. Undo of this layer only: `git -C ~/.local/share/codex-router reset --hard 310fd3f9` then kickstart. Setting `CODEX_ROUTER_GROK_REPAIR_IDLE_MS=0` in the service environment disables the idle without a reset.
