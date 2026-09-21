# Grok repair liveness and pre-header retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a progress-only Grok repair from looking dead to the ten-minute stall guard, and send one new upstream request when the first fetch dies before response headers.

**Architecture:** Both changes stay inside `src/grok-oauth-forwarder.mjs`. The repair reader already forwards `reasoning_content` for a strict after-tool repair; the optional repair uses that same write and still withholds content and tool calls until classification. Pre-header retry calls the existing `isRetryableTransportError` predicate once and does not change the shared native-retry budget.

**Tech Stack:** Node.js, `node:test`, Undici `fetch` via the forwarder's installed dispatcher.

**Spec:** `docs/superpowers/specs/2026-09-21-grok-repair-liveness-and-preheader-retry.md`

## Global Constraints

- Do not change `DEFAULT_GROK_STREAM_STALL_MS` or `NATIVE_RETRY_BUDGET_MS`.
- Do not retry `AbortError`, a fetch that already has `headersAt`, or `response.failed`.
- At most one pre-header retry. The retry gets a new `x-grok-req-id`.
- A repair may write `reasoning_content` before its terminal. It must not write content or tool-call deltas before classification.
- Logs name the error and cause code only. No prompt, response body, or token.
- Live `~/.local/share/codex-router` is not edited until the worktree tests pass and the required review sentinels pass.

---

### Task 1: Stream repair reasoning on the optional path

**Files:**
- Modify: `src/grok-oauth-forwarder.mjs` (repair `consumeResponsesStream` callback)
- Test: `test/grok-oauth-forwarder.test.mjs`

**Interfaces:**
- Consumes: `applyResponsesEvent` deltas shaped `{ reasoning_content }` or `{ content }` or `{ tool_calls }`
- Produces: SSE chunks on the already-open Chat Completions response. Classification helpers are unchanged.

- [ ] **Step 1: Write the failing tests**

1. Hold an optional repair open after a reasoning delta, a content delta, and a function-call item. The client must observe `reasoning_content` before the gate opens, and must not observe the repair sentence or the tool name. After `response.completed`, the tool name is present and the repair sentence is still absent.
2. An optional repair that writes reasoning and then `response.failed` or `response.incomplete` keeps the first answer, keeps the reasoning already written, omits the repair sentence, and does not open a third upstream request.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test --test-name-pattern "optional progress-only repair streams reasoning" test/grok-oauth-forwarder.test.mjs`

Expected: FAIL because the reasoning delta is withheld.

- [ ] **Step 3: Forward reasoning for every streamed repair**

In the repair reader, drop the `strictAfterToolRepair` guard around the `reasoning_content` write. Keep skipping every other delta in that loop.

- [ ] **Step 4: Re-run the forwarder tests**

Run: `node --test test/grok-oauth-forwarder.test.mjs`

Expected: PASS, including the existing strict-repair and keep-first tests.

### Task 2: One pre-header transport retry

**Files:**
- Modify: `src/grok-oauth-forwarder.mjs` (`requestUpstream`)
- Test: `test/grok-oauth-forwarder.test.mjs`

**Interfaces:**
- Consumes: `isRetryableTransportError` from `src/upstream-retry.mjs`
- Produces: a second `fetch` only for the predicate above, and stderr `upstream-preheader-retry=true`

- [ ] **Step 1: Write the failing tests**

Four cases: socket destroyed before any response byte is retried once, the two `x-grok-req-id` headers differ, and the second body is returned; headers then a destroyed body is not retried; the client abort while the first fetch is outstanding produces no second request; two pre-header resets produce two requests and HTTP 502, not a third request.

- [ ] **Step 2: Run them and confirm they fail**

Expected: the destroyed-socket case fails with one inbound request and a 502.

- [ ] **Step 3: Retry once inside `requestUpstream`**

On a thrown error, if `controller.signal.aborted` is false, `isRetryableTransportError(error)` is true, and `error.grokUpstreamAttempt.headersAt` is missing, log the retry and call the same fetch helper once more. Any other error throws.

- [ ] **Step 4: Re-run `node --test test/grok-oauth-forwarder.test.mjs`**

Expected: PASS.

---

## Acceptance ledger

| ID | Observable outcome | Status | Evidence |
| --- | --- | --- | --- |
| A1 | Optional repair reasoning is visible before the terminal; repair text and tool bytes are not | pending | Task 1 tool-gate test |
| A2 | Optional no-tool repair still returns the first answer, with repair reasoning kept and repair text omitted | pending | Task 1 plus existing keep-first test |
| A3 | Strict repair still holds tool calls until completed | pending | Existing terminal-gate test |
| A4 | Pre-header `ECONNRESET` is retried once under a new `x-grok-req-id` | pending | Task 2 test |
| A5 | Post-header failure and caller abort are not retried | pending | Task 2 tests |
| A6 | A second pre-header failure stops | pending | Task 2 test |
| A7 | Optional repair reasoning followed by `failed` or `incomplete` is not replayed; first answer remains | pending | Task 1 test |
