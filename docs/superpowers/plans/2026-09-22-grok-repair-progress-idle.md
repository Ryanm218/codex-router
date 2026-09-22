# Grok repair progress idle implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End a Grok repair at 120s after parsed progress stops, and keep a repair that is still producing a tool call or final answer alive until `response.completed`.

**Architecture:** The repair read extends its idle only when a completed block is a progress event or the incomplete tail contains a full progress event type. A sliced `response.in_progress` frame does not. The same recognition writes a throttled U+2060 `reasoning_content` chunk before the frame has to parse. The first Grok Responses transform rewrites a joiner-only delta to `response.in_progress` and strips U+2060 from reasoning done and terminal snapshots.

**Tech Stack:** Node.js ESM, `node:test`, Codex Router forwarder and Responses transforms.

**Spec:** `docs/superpowers/specs/2026-09-22-grok-repair-progress-idle.md`

## Global Constraints

- Do not shorten `GROK_STREAM_STALL_MS`, `grokTransportIdleTimeoutMs`, `grokGatewayStreamTimeoutSeconds`, or the primary-attempt prelude.
- Do not release repair content or tool calls before `response.completed`.
- Strict progress idle still ends as Chat Completions `grok_repair_idle` with no `[DONE]`. Optional progress idle keeps attempt 1. Client abort stays `AbortError`.
- No synthetic status sentence. The only injected delta is `GROK_REPAIR_STALL_KEEPALIVE` (`"\u2060"`).
- No live xAI call. No LiteLLM venv edit. No `http-utils` stream-error change.
- `CODEX_ROUTER_GROK_REPAIR_IDLE_MS=0` disables the idle. `CODEX_ROUTER_GROK_REPAIR_KEEPALIVE_MS` defaults to 30000; `0` emits on every withheld progress event.

---

### Task 1: Progress predicate, idle-tail rule, and keepalive transform

**Files:**
- Create: `src/grok-repair-keepalive.mjs`
- Test: `test/grok-repair-keepalive.test.mjs`

**Interfaces:**
- Produces: `GROK_REPAIR_STALL_KEEPALIVE`, `isRepairProgressEvent(event)`, `repairChunkResetsIdle(previousBuffer, nextBuffer)`, `class GrokRepairKeepaliveTransform`

- [ ] **Step 1: Write the failing unit tests** in `test/grok-repair-keepalive.test.mjs` covering the spec's verification list for these three exports.

- [ ] **Step 2: Run** `node --test test/grok-repair-keepalive.test.mjs` and confirm the module is missing.

- [ ] **Step 3: Implement** `src/grok-repair-keepalive.mjs` to the spec. The transform parses SSE the same way as `ResponsesHeartbeatTransform` (CRLF and LF). It holds an empty reasoning `output_item.added` until the next block.

- [ ] **Step 4: Run the unit file and confirm it passes.**

### Task 2: Repair read and keepalive write

**Files:**
- Modify: `src/grok-oauth-forwarder.mjs` repair `consumeResponsesStream` call and the repair event callback
- Test: `test/grok-repair-progress.test.mjs`

**Interfaces:**
- Consumes: `repairChunkResetsIdle`, `isRepairProgressEvent`, `GROK_REPAIR_STALL_KEEPALIVE`

- [ ] **Step 1: Write the failing forwarder tests** described in the spec: comment idle, completed and sliced `response.in_progress` idle, withheld tool progress that shows U+2060 before the tool arguments, and an incomplete tool frame that shows U+2060 before the frame parses.

- [ ] **Step 2: Run** `node --test test/grok-repair-progress.test.mjs` and confirm those tests fail.

- [ ] **Step 3: Implement.** `consumeResponsesStream` gains `progressIdle`. When it is set, the idle deadline moves only if `repairChunkResetsIdle(previous, next)` is true; `readUpstreamChunk` is then raced against the remaining deadline. The repair call passes `progressIdle: true`. Whenever that reset is for a withheld reason — a parsed content or tool event, an incomplete tail naming a content or tool progress type, or an incomplete reasoning tail whose delta is not forwarded in that same parse — `response.write` one `OPENAI_ROLE_CHUNK` whose delta is `{ reasoning_content: GROK_REPAIR_STALL_KEEPALIVE }`, throttled by `CODEX_ROUTER_GROK_REPAIR_KEEPALIVE_MS`. Do not wait for the incomplete frame to finish. Do not push that delta into `secondState`. A completed reasoning delta is forwarded as itself and does not also get a joiner in that same parse.

- [ ] **Step 4: Run** `node --test test/grok-repair-progress.test.mjs test/grok-oauth-forwarder.test.mjs` and confirm both pass.

### Task 3: Wire the transform and document it

**Files:**
- Modify: `src/router.mjs` `createResponsePipeline`
- Modify: `CHANGELOG.md` Unreleased
- Modify: `docs/TROUBLESHOOTING.md` repair-idle paragraph

- [ ] **Step 1: Insert** `new GrokRepairKeepaliveTransform()` at the front of the Grok OAuth event-stream pipeline, before the reasoning-summary transform and the empty-completion guard.

- [ ] **Step 2: Changelog and troubleshooting.** State that repair idle follows parsed progress, that withheld answer bytes emit U+2060, and that the router rewrites that byte to `response.in_progress`. Name both env vars.

- [ ] **Step 3: Run** `node --test test/grok-repair-keepalive.test.mjs test/grok-repair-progress.test.mjs test/grok-oauth-forwarder.test.mjs test/grok-stream-timeouts.test.mjs test/responses-heartbeat.test.mjs`.

## Self-review

- Spec coverage: progress idle, comment and sliced `in_progress` non-reset, split-frame reset, keepalive on an incomplete tool tail before parse, withheld tool/final answer, U+2060 bridge, snapshot strip, transform placement, strict/optional/abort terminals, primary attempt unchanged. Each has a task above.
- No production edit is in this plan file. Implementation follows a passing Astra design and architecture review.
