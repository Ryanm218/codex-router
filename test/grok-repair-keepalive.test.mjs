import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { EmptyCompletionGuard } from "../src/empty-completion-guard.mjs";
import {
  GROK_REPAIR_STALL_KEEPALIVE,
  GrokRepairKeepaliveTransform,
  isRepairProgressEvent,
  repairChunkResetsIdle,
  repairKeepaliveDue,
} from "../src/grok-repair-keepalive.mjs";

const KEEPALIVE = GROK_REPAIR_STALL_KEEPALIVE;

function sse(events) {
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function collect(transform) {
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(Buffer.from(chunk).toString("utf8")));
  return () => chunks.join("");
}

const CREATED = sse([{
  type: "response.created",
  response: {
    id: "resp_1",
    object: "response",
    created_at: 1700000000,
    model: "grok-4.7",
    status: "in_progress",
    instructions: "private-instructions-marker",
    tools: [{ type: "function", name: "exec_command" }],
    output: [],
  },
}]);

test("isRepairProgressEvent accepts answer and reasoning deltas only", () => {
  assert.equal(KEEPALIVE, "\u2060");
  assert.equal(isRepairProgressEvent({ type: "response.output_text.delta", delta: "answer" }), true);
  assert.equal(isRepairProgressEvent({ type: "response.output_text.delta", delta: "" }), false);
  assert.equal(isRepairProgressEvent({ type: "response.reasoning_summary_text.delta", delta: "think" }), true);
  assert.equal(isRepairProgressEvent({ type: "response.reasoning_text.delta", delta: "think" }), true);
  assert.equal(isRepairProgressEvent({ type: "response.reasoning_text.delta", delta: "" }), false);
  assert.equal(isRepairProgressEvent({
    type: "response.output_item.added",
    item: { type: "function_call", name: "exec_command" },
  }), true);
  assert.equal(isRepairProgressEvent({
    type: "response.output_item.done",
    item: { type: "custom_tool_call", name: "exec" },
  }), true);
  assert.equal(isRepairProgressEvent({
    type: "response.output_item.added",
    item: { type: "message" },
  }), false);
  assert.equal(isRepairProgressEvent({ type: "response.function_call_arguments.delta", delta: "{" }), true);
  assert.equal(isRepairProgressEvent({ type: "response.function_call_arguments.delta", delta: "" }), false);
  assert.equal(isRepairProgressEvent({ type: "response.function_call_arguments.done", arguments: "{}" }), true);
  assert.equal(isRepairProgressEvent({ type: "response.custom_tool_call_input.delta", delta: "x" }), true);
  assert.equal(isRepairProgressEvent({ type: "response.in_progress" }), false);
  assert.equal(isRepairProgressEvent({ type: "response.created" }), false);
  assert.equal(isRepairProgressEvent({ type: "response.completed" }), false);
  assert.equal(isRepairProgressEvent(null), false);
});

test("repairChunkResetsIdle ignores comments and lifecycle events", () => {
  assert.equal(repairChunkResetsIdle("", ": ping\n\n"), false);
  assert.equal(repairChunkResetsIdle("", sse([{ type: "response.in_progress", response: { id: "resp_1" } }])), false);
  assert.equal(repairChunkResetsIdle("", "\n"), false);
  const partial = 'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"x"}';
  assert.equal(repairChunkResetsIdle("", partial), true);
  assert.equal(
    repairChunkResetsIdle("", sse([{ type: "response.function_call_arguments.delta", delta: "x" }])),
    true,
  );
  const head = 'event: response.output_text.delta\n';
  const full = `${head}data: {"type":"response.output_text.delta","delta":"a"}\n\n`;
  assert.equal(repairChunkResetsIdle(head, full), true);
  assert.equal(repairChunkResetsIdle("", "event: response.re"), false);
  const lifecycle = sse([{ type: "response.in_progress", response: { id: "resp_1", output: [] } }]);
  let previous = "";
  for (let at = 0; at < lifecycle.length; at += 8) {
    const next = lifecycle.slice(0, at + 8);
    assert.equal(repairChunkResetsIdle(previous, next), false, next);
    previous = next;
  }
  assert.equal(
    repairChunkResetsIdle("", 'event: response.reasoning_summary_text.delta\ndata: {"delta":"st"'),
    true,
  );
  const comment = ": last-event response.function_call_arguments.delta";
  assert.equal(repairChunkResetsIdle("", comment), false);
  assert.equal(repairKeepaliveDue("", comment), false);
  const mentioned = 'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"instructions":"Use response.output_text.delta for text"';
  assert.equal(repairChunkResetsIdle("", mentioned), false);
  assert.equal(repairKeepaliveDue("", mentioned), false);
  assert.equal(repairChunkResetsIdle(mentioned, `${mentioned} `), false);
  const multiline = 'data: {"type":"response.in_progress",\ndata: "response":{"metadata":\ndata: {"type":"response.output_text.delta"}}}';
  assert.equal(repairChunkResetsIdle("", multiline), false);
  assert.equal(repairKeepaliveDue("", multiline), false);
  assert.equal(repairChunkResetsIdle(multiline, `${multiline}\n: ping`), false);
  assert.equal(repairKeepaliveDue(multiline, `${multiline}\n: ping`), false);
  const tool = 'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"';
  assert.equal(repairChunkResetsIdle("", tool), true);
  assert.equal(repairKeepaliveDue("", tool), true);
  let cursor = tool;
  for (let index = 0; index < 3; index += 1) {
    const next = `${cursor}\n: ping`;
    assert.equal(repairChunkResetsIdle(cursor, next), false);
    assert.equal(repairKeepaliveDue(cursor, next), false);
    cursor = next;
  }
  assert.equal(repairChunkResetsIdle(tool, `${tool}x`), true);
  assert.equal(repairKeepaliveDue(tool, `${tool}x`), true);
});

test("a joiner-only reasoning delta becomes in_progress and drops the empty reasoning item", () => {
  const transform = new GrokRepairKeepaliveTransform();
  const read = collect(transform);
  transform.write(CREATED);
  transform.write(sse([{
    type: "response.output_item.added",
    item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: null },
  }]));
  transform.write(sse([{ type: "response.reasoning_summary_text.delta", delta: KEEPALIVE }]));
  transform.end();
  const body = read();
  assert.match(body, /private-instructions-marker/);
  assert.match(body, /exec_command/);
  assert.match(body, /event: response\.in_progress/);
  assert.doesNotMatch(body, /\u2060/);
  assert.doesNotMatch(body, /output_item\.added/);
  const progress = JSON.parse(body.slice(body.indexOf("event: response.in_progress")).split("\n\n")[0].replace(/^event: response\.in_progress\ndata: /, ""));
  assert.equal(progress.response.id, "resp_1");
  assert.equal(progress.response.instructions, undefined);
  assert.equal(progress.response.tools, undefined);
  assert.deepEqual(progress.response.output, []);
  assert.equal(progress.response.model, "grok-4.7");
});

test("real reasoning stays, and a later joiner does not stick to it", () => {
  const transform = new GrokRepairKeepaliveTransform();
  const read = collect(transform);
  transform.write(CREATED);
  transform.write(sse([{ type: "response.reasoning_summary_text.delta", delta: "thinking" }]));
  transform.write(sse([{ type: "response.reasoning_summary_text.delta", delta: KEEPALIVE }]));
  transform.write(sse([{ type: "response.reasoning_summary_text.delta", delta: `think${KEEPALIVE}ing` }]));
  transform.end();
  const body = read();
  assert.match(body, /thinking/);
  assert.match(body, /thinking/);
  assert.match(body, /"delta":"thinking"/);
  assert.doesNotMatch(body, /\u2060/);
  assert.match(body, /event: response\.in_progress/);
});

test("reasoning done and completed snapshots cannot carry the keepalive", () => {
  const transform = new GrokRepairKeepaliveTransform();
  const read = collect(transform);
  transform.write(CREATED);
  transform.write(sse([{ type: "response.reasoning_summary_text.done", text: `Plan${KEEPALIVE}` }]));
  transform.write(sse([{ type: "response.reasoning_summary_text.done", text: KEEPALIVE }]));
  transform.write(sse([{
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: `Done${KEEPALIVE}` }] }],
    },
  }]));
  transform.end();
  const body = read();
  assert.match(body, /"text":"Plan"/);
  assert.match(body, /"text":"Done"/);
  assert.doesNotMatch(body, /\u2060/);
  assert.equal((body.match(/^event: response\.reasoning_summary_text\.done$/gm) || []).length, 1);
});

test("a second empty reasoning item does not drop the first", () => {
  const transform = new GrokRepairKeepaliveTransform();
  const read = collect(transform);
  transform.end(`${sse([
    { type: "response.output_item.added", item: { id: "r1", type: "reasoning", summary: [] } },
    { type: "response.output_item.added", item: { id: "r2", type: "reasoning", summary: [] } },
  ])}data: {"type":"response.reasoning_summary_text.delta","delta":"real reasoning"}\n\n`);
  const body = read();
  assert.match(body, /"id":"r1"/);
  assert.match(body, /"id":"r2"/);
  assert.match(body, /real reasoning/);
});

test("each joiner delta is its own stall reset", () => {
  const transform = new GrokRepairKeepaliveTransform();
  const read = collect(transform);
  transform.write(CREATED);
  transform.write(sse([{ type: "response.reasoning_summary_text.delta", delta: "thinking" }]));
  for (let index = 0; index < 3; index += 1) {
    transform.write(sse([{ type: "response.reasoning_summary_text.delta", delta: KEEPALIVE }]));
  }
  transform.end();
  const body = read();
  assert.equal((body.match(/event: response\.in_progress/g) || []).length, 3);
  assert.doesNotMatch(body, /\u2060/);
});

test("in_progress replacements keep a released stall guard alive", async () => {
  const keepalive = new GrokRepairKeepaliveTransform();
  const guard = new EmptyCompletionGuard("text/event-stream", {
    maxPreludeMs: 1_000,
    maxStreamStallMs: 90,
  });
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const source = Readable.from((async function* frames() {
    yield CREATED;
    yield sse([{ type: "response.reasoning_summary_text.delta", delta: "thinking" }]);
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield sse([{ type: "response.reasoning_summary_text.delta", delta: KEEPALIVE }]);
    }
    yield sse([{
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [] },
    }]);
  })());
  await pipeline(source, keepalive, guard, collector);
  const body = Buffer.concat(chunks).toString("utf8");
  assert.match(body, /response\.completed/);
  assert.equal(guard.preludeLimitKind(), undefined);
  assert.doesNotMatch(body, /\u2060/);
});
