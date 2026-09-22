# Grok repair progress idle — design

Date: 2026-09-22. Base: live `main` `700e19dd`. The tests that name the new behavior are red until implementation.

## Goal

A Grok OAuth progress-only repair that is still receiving a tool call or a final answer stays open until `response.completed`, then releases that answer. A repair whose parsed progress has stopped ends at 120s. Raw keepalive bytes do not keep the turn alive. The primary attempt's 10-minute stall and the transport bounds stay as they are.

## What is failing

Codex `/v1/responses` → router `:4202` → LiteLLM `:4200` → grok-oauth-forwarder `:4208` → `cli-chat-proxy`. After a progress-only stop the forwarder opens a repair POST. It forwards `reasoning_content` and holds content and tool-call deltas until `response.completed`.

The repair idle (`CODEX_ROUTER_GROK_REPAIR_IDLE_MS`, default 120s) resets on every upstream byte. Two different byte streams then miss it:

- SSE comments and `response.in_progress` keep the idle warm without an answer.
- Content and tool-call deltas are the answer, but they are withheld from Codex. They also keep the idle warm. The router's post-release stall (`CODEX_ROUTER_GROK_STREAM_STALL_MS`, 10 minutes) sees a silent client stream and aborts the socket. The forwarder logs `AbortError` and drops the buffered answer.

Evidence from 2026-09-22, metered `grok-oauth` from 15:01 BST: 555 HTTP 200, 36 HTTP 502, 5 status 0. The long 502s are `phase=repair` `AbortError` at about 603–632s, one at 18 minutes. `repair-idle=true` does not appear in the current `router.log`. The forwarder process has been running since 2026-09-21 22:25 BST and loaded the 120s idle (`15479197`).

## Constraints

- Do not shorten `GROK_STREAM_STALL_MS`, `grokTransportIdleTimeoutMs`, `grokGatewayStreamTimeoutSeconds`, or the primary-attempt empty-completion prelude.
- The new idle rule applies only to the repair body's read. The primary `consumeResponsesStream` call stays unbounded by this idle.
- Strict after-tool repair still withholds content and tool calls until `response.completed`. An `item.done` followed by EOF is not a certified repair. Do not stream those deltas to Codex early.
- On a true progress idle, keep today's terminal: strict repair writes one Chat Completions `data: {"error":...}` with code `grok_repair_idle` and no `[DONE]`. Optional repair keeps attempt 1. A client abort is still `AbortError`, not `grok_repair_idle`.
- Do not emit synthetic status sentences. The stall bridge is U+2060 WORD JOINER on `reasoning_content`, and the router rewrites that delta to `response.in_progress` before any reasoning transform sees it.
- No live xAI call. No LiteLLM venv edit. No change to `http-utils` `endStreamedResponse` / `writeStreamErrorEvent`.
- `CODEX_ROUTER_GROK_REPAIR_IDLE_MS=0` still disables the idle. The keepalive gap defaults to 30s (`CODEX_ROUTER_GROK_REPAIR_KEEPALIVE_MS`). `0` emits a keepalive on every withheld progress event.

## Alternatives

- Keep resetting the idle on every byte and only add the stall bridge. A comment stream would still sit until the 10-minute stall. Rejected.
- Release tool-call deltas as they arrive. That resets the stall and shows progress, and it stores an uncertified call if the socket dies before `response.completed`. Rejected.
- Shorten the global stall. That cuts real primary-attempt reasoning pauses. Rejected.
- Let the router's existing `response.in_progress` heartbeat reset the stall. The heartbeat is generated locally after the guard, including when upstream is dead, so the stall would never fire. Rejected.
- Send a visible "still working" sentence. Rejected by the 2026-09-21 repair-idle design.

## Architecture

`src/grok-repair-keepalive.mjs` owns the shared rules.

- `GROK_REPAIR_STALL_KEEPALIVE` is `"\u2060"`.
- `isRepairProgressEvent(event)` is true for a non-empty `response.output_text.delta`, `response.reasoning_summary_text.delta`, or `response.reasoning_text.delta`; for `response.output_item.added` / `done` whose item type is `function_call` or `custom_tool_call`; and for a non-empty `response.function_call_arguments.delta`, `response.custom_tool_call_input.delta`, or the matching `.done` payload (`arguments`, `input`, or `text`). Everything else is false, including `response.created`, `response.in_progress`, `response.completed`, and empty deltas.
- `repairChunkResetsIdle(previousBuffer, nextBuffer)` is true only when a newly completed block parses as a progress event, or when the incomplete tail contains a full progress event type string (`response.output_text.delta`, `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.custom_tool_call_input.delta`, `response.custom_tool_call_input.done`, or `response.output_item.added` / `response.output_item.done` together with `function_call` or `custom_tool_call`). A sliced `response.in_progress` frame, a comment, a completed lifecycle event, and a prefix that only says `event: response.re` do not reset it. The existing split-frame test still passes once the tail contains `response.reasoning_summary_text.delta`.
- `GrokRepairKeepaliveTransform` is the first Responses transform on a Grok OAuth event stream. It remembers `response.created` / `response.in_progress` identity (`id`, `created_at`, `model` only). A reasoning delta whose text is only U+2060 is replaced with one `response.in_progress` that carries that identity and `output: []`. An `output_item.added` for an empty reasoning item is held; if the next event is a keepalive delta, both are dropped and one `in_progress` is emitted; if the next event is anything else, the held item is released unchanged. U+2060 is removed from every reasoning string the transform forwards: delta, `text`, summary part text, and reasoning items inside `response.completed` / `response.incomplete` / `response.failed` output. A reasoning `done` event whose text is empty after that removal is dropped. Tool-call arguments are not rewritten. Instructions and tool schemas are never copied into the replacement.

The forwarder repair read passes `progressIdle: true` with the existing `idleMs`. The deadline extends only when `repairChunkResetsIdle` is true. Non-progress bytes leave the deadline where it is. Expiry is still `GrokRepairIdleError`.

Whenever `repairChunkResetsIdle` is true for a withheld reason — a parsed content or tool event, or an incomplete tail that names a content or tool progress type — the forwarder writes one Chat Completions chunk `delta.reasoning_content = GROK_REPAIR_STALL_KEEPALIVE`, at most once per keepalive gap. An incomplete reasoning tail gets the same throttled chunk, because that reasoning is not forwarded until the frame completes. A completed reasoning delta is forwarded as itself and is not also given a joiner in that same parse. The chunk is not pushed into the repair turn state, so it cannot become the certified answer or the stored reasoning text. LiteLLM turns a non-empty `reasoning_content` into a reasoning summary delta, and its later reasoning `done` text can repeat the accumulated characters. The transform strips those characters from the delta and from the done/terminal snapshots, then turns a joiner-only delta into `response.in_progress`. After the empty-completion guard has released on liveness, each of those `in_progress` chunks resets `maxStreamStallMs`. The default 30s gap is inside the 10-minute stall, so a repair that keeps extending the idle also keeps the stall reset. Codex already ignores `response.in_progress`.

## Failure modes

- Idle too short while a real frame is split across TCP reads. The tail extends the deadline only after it contains a full progress event type. A comment or a sliced `response.in_progress` does not.
- A split tool or content frame extends the idle before it parses. The same recognition writes the throttled keepalive, so the router stall does not run for the whole split.
- Keepalive opens an empty reasoning item. The transform holds that `output_item.added` and drops it when the delta is only U+2060.
- LiteLLM repeats accumulated `reasoning_content` in a reasoning `done` or terminal `output` snapshot. The transform strips U+2060 from those strings. A snapshot that becomes empty is dropped. Tool arguments are left alone.
- Joiner before `response.created`. The replacement `in_progress` omits `id` until identity has been seen. The stall guard only needs the bytes.
- Client abort during the repair. `controller.signal.aborted` still wins; no `grok_repair_idle` frame is written.
- Primary attempt. No progress idle and no keepalive chunk.
- Keepalive gap longer than the stall. The default 30s gap is inside the 10-minute stall. A configured gap above the stall can still lose the race; the env value is documented and not clamped up to the stall, so an operator can see that misconfiguration.

## Verification

- Unit: `isRepairProgressEvent` and `repairChunkResetsIdle` for the cases in the architecture section.
- Unit: sliced `response.in_progress` never resets the idle. `event: response.re` does not reset. A tail that contains `response.reasoning_summary_text.delta` does.
- Unit: `GrokRepairKeepaliveTransform` passes a normal reasoning delta through; replaces a joiner-only delta, including one that was preceded by an empty reasoning `output_item.added`; strips U+2060 from a mixed delta, from `reasoning_summary_text.done`, and from a reasoning summary inside `response.completed`; drops a done event whose text is only U+2060; uses the created response id and does not copy instructions or tools. Three successive joiner deltas produce three `response.in_progress` events.
- Unit: those `in_progress` events, fed through `EmptyCompletionGuard` after a reasoning liveness release, reset a short `maxStreamStallMs` so a withheld repair that emits a joiner every 50ms survives past one stall interval.
- Forwarder, strict repair, idle 200ms: the repair body is only `: ping` comments every 40ms. The client receives `grok_repair_idle` within 2s.
- Forwarder, strict repair, idle 200ms: the repair body is `response.in_progress` sliced into 8-byte writes every 40ms. Same `grok_repair_idle` result. A completed `response.in_progress` every 40ms does the same.
- Forwarder, strict repair, idle 300ms: tool-call events are written and `response.completed` is withheld. The client receives U+2060 before the tool arguments. After `response.completed`, the client receives the tool call and does not receive `grok_repair_idle`.
- Forwarder, strict repair: the repair writes `event: response.function_call_arguments.delta` plus an unfinished `data:` line and then sends nothing else. The client receives U+2060 while that frame is still incomplete. The tool arguments are not in that prefix.
- Existing repair-idle tests stay green: silence after one reasoning event, optional silence keeps attempt 1, split-frame bytes still deliver the tool call, client abort is not relabeled.
- `node --test test/grok-repair-keepalive.test.mjs test/grok-repair-progress.test.mjs test/grok-oauth-forwarder.test.mjs test/grok-stream-timeouts.test.mjs test/responses-heartbeat.test.mjs`. No live xAI probe.

## Review

- 2026-09-22 design and architecture, first cycle: `ASTRA_DESIGN: BLOCK — Fragmented response.in_progress frames reset the proposed idle indefinitely; tests omit fragmented lifecycle traffic, sustained router-stall protection, and keepalive-bearing completion snapshots.` `ASTRA_ARCHITECTURE: BLOCK — Partial frames extend idle but emit no stall bridge until parsed, allowing live repairs to hit the router stall; delta-only sanitization also leaves reasoning done/terminal snapshots able to reintroduce U+2060.` Reviewer gpt-6-astra at medium reasoning, Codex session `01a0cb28-35f9-79a3-89eb-202dbd8c297a`.
- Revision after that block: incomplete tails reset the idle only when they contain a full progress event type; sliced `response.in_progress` does not. The stall keepalive is emitted when a withheld or still-incomplete progress tail extends the idle, not only after a frame parses. The transform strips U+2060 from reasoning done and terminal snapshots.
- 2026-09-22 second cycle: `ASTRA_ARCHITECTURE: PASS`. `ASTRA_DESIGN: BLOCK — Plan Task 2 still emits keepalives only after parsing, omitting the revised partial-frame bridge and its regression test; keepalive tests also incorrectly reject unchanged response.created metadata and count one done event’s two textual occurrences as one.` Reviewer gpt-6-astra at medium reasoning, Codex session `01a0cb2b-433f-7031-879c-bfd397c18637`.
- 2026-09-22 third design cycle: `ASTRA_DESIGN: PASS`. Reviewer gpt-6-astra at medium reasoning, Codex session `01a0cb31-064b-7c03-b3b4-512b33f65c74`. Architecture approval remains the second-cycle `ASTRA_ARCHITECTURE: PASS`.
- 2026-09-22 final, first cycle: `ASTRA_REVIEW: BLOCK — Non-progress tails can reset idle and emit keepalives; consecutive empty reasoning openings silently lose an event.` Session `01a0cb35-a9ca-7e42-8e13-76f9bc4ebf24`.
- 2026-09-22 final, second cycle: `ASTRA_REVIEW: BLOCK — Multiline lifecycle data can promote a nested type to progress, allowing comments to reset idle and emit keepalives.` Session `01a0cb38-b93f-7892-b78a-737b6ae7d54e`.
- 2026-09-22 final, third cycle: `ASTRA_REVIEW: BLOCK — Comments appended to an incomplete progress frame still reset repair idle and emit stall keepalives.` Session `01a0cb3d-7644-78f2-9b2f-ef26649ae2e6`.
- 2026-09-22 final, fourth cycle: `ASTRA_REVIEW: PASS`. Reviewer gpt-6-astra at medium reasoning, Codex session `01a0cb46-6cd1-7e11-8bcf-aef76ffb0a8a`. Comment lines no longer advance an unfinished progress tail.
