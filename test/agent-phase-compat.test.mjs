import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  AgentPhaseCompatTransform,
  agentPhaseCompatTransform,
} from "../src/agent-phase-compat.mjs";
import { ItemLifecycleNormalizer } from "../src/item-lifecycle-normalizer.mjs";

function block(event, sep = "\n\n") {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}${sep}`;
}

async function transform(input, { chunkSize = 0, TransformClass = AgentPhaseCompatTransform } = {}) {
  const stream = new TransformClass();
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const source = [];
  if (chunkSize > 0) {
    const buf = Buffer.from(input);
    for (let at = 0; at < buf.length; at += chunkSize) {
      source.push(buf.subarray(at, at + chunkSize));
    }
  } else {
    source.push(Buffer.from(input));
  }
  await pipeline(Readable.from(source), stream, collector);
  return Buffer.concat(chunks).toString("utf8");
}

function events(body) {
  return body
    .split(/\r?\n\r?\n/)
    .map((chunk) => {
      const dataLines = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (!dataLines.length) return undefined;
      const dataText = dataLines.join("\n");
      if (dataText === "[DONE]") return { type: "[DONE]" };
      try {
        return JSON.parse(dataText);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function messageItem(id, text, phase) {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: text == null ? [] : [{ type: "output_text", text }],
    ...(phase ? { phase } : {}),
  };
}

test("factory is SSE-only and not provider-gated", () => {
  assert.ok(agentPhaseCompatTransform("text/event-stream"));
  assert.ok(agentPhaseCompatTransform("text/event-stream; charset=utf-8"));
  assert.equal(agentPhaseCompatTransform("application/json"), undefined);
});

test("a note followed by a tool call is tagged commentary", async () => {
  const note = messageItem("msg_note", "Checking the files.");
  const tool = { id: "call_1", type: "function_call", name: "exec_command", arguments: "{}" };
  const body = await transform([
    block({ type: "response.output_item.added", output_index: 0, item: { ...note, status: "in_progress", content: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "msg_note", delta: "Checking the files." }),
    block({ type: "response.output_item.done", output_index: 0, item: note }),
    block({ type: "response.output_item.added", output_index: 1, item: tool }),
    block({ type: "response.output_item.done", output_index: 1, item: tool }),
    block({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [note, tool] } }),
  ].join(""));
  const out = events(body);
  const added = out.find((event) => event.type === "response.output_item.added" && event.item?.id === "msg_note");
  const done = out.find((event) => event.type === "response.output_item.done" && event.item?.id === "msg_note");
  const completed = out.find((event) => event.type === "response.completed");
  assert.equal(added.item.phase, "commentary");
  assert.equal(done.item.phase, "commentary");
  assert.equal(completed.response.output[0].phase, "commentary");
  assert.equal(completed.response.output[1].type, "function_call");
});

test("a last no-tool message is tagged final_answer", async () => {
  const answer = messageItem("msg_done", "Staged on clawdbot.");
  const body = await transform([
    block({ type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "msg_done", delta: "Staged on clawdbot." }),
    block({ type: "response.output_item.done", output_index: 0, item: answer }),
    block({ type: "response.completed", response: { id: "resp_2", status: "completed", output: [answer] } }),
  ].join(""));
  const out = events(body);
  const added = out.find((event) => event.type === "response.output_item.added");
  const done = out.find((event) => event.type === "response.output_item.done");
  const completed = out.find((event) => event.type === "response.completed");
  assert.equal(added.item.phase, "commentary");
  assert.equal(done.item.phase, "final_answer");
  assert.equal(completed.response.output[0].phase, "final_answer");
});

test("the first of two assistant messages stays commentary; the last is final_answer", async () => {
  const note = messageItem("msg_note", "I'll inspect the host.");
  const answer = messageItem("msg_done", "Mini-3 is still live.");
  const tool = { id: "call_1", type: "function_call", name: "exec_command", arguments: "{}" };
  const body = await transform([
    block({ type: "response.output_item.added", output_index: 0, item: { ...note, status: "in_progress", content: [] } }),
    block({ type: "response.output_item.done", output_index: 0, item: note }),
    block({ type: "response.output_item.added", output_index: 1, item: tool }),
    block({ type: "response.output_item.done", output_index: 1, item: tool }),
    block({ type: "response.output_item.added", output_index: 2, item: { ...answer, status: "in_progress", content: [] } }),
    block({ type: "response.output_item.done", output_index: 2, item: answer }),
    block({
      type: "response.completed",
      response: { id: "resp_3", status: "completed", output: [note, tool, answer] },
    }),
  ].join(""));
  const out = events(body);
  const noteDone = out.find((event) => event.type === "response.output_item.done" && event.item?.id === "msg_note");
  const answerDone = out.find((event) => event.type === "response.output_item.done" && event.item?.id === "msg_done");
  const completed = out.find((event) => event.type === "response.completed");
  assert.equal(noteDone.item.phase, "commentary");
  assert.equal(answerDone.item.phase, "final_answer");
  assert.equal(completed.response.output[0].phase, "commentary");
  assert.equal(completed.response.output[2].phase, "final_answer");
});

test("an already-set native phase is left alone", async () => {
  const note = messageItem("msg_native", "Native note.", "commentary");
  const answer = messageItem("msg_native_done", "Native answer.", "final_answer");
  const body = await transform([
    block({ type: "response.output_item.added", output_index: 0, item: note }),
    block({ type: "response.output_item.done", output_index: 0, item: note }),
    block({ type: "response.output_item.added", output_index: 1, item: answer }),
    block({ type: "response.output_item.done", output_index: 1, item: answer }),
    block({
      type: "response.completed",
      response: { id: "resp_4", status: "completed", output: [note, answer] },
    }),
  ].join(""));
  const out = events(body);
  assert.equal(out.find((event) => event.item?.id === "msg_native").item.phase, "commentary");
  const answerDone = out.find((event) => event.type === "response.output_item.done" && event.item?.id === "msg_native_done");
  assert.equal(answerDone.item.phase, "final_answer");
  assert.equal(out.at(-1).response.output[1].phase, "final_answer");
});

test("an empty assistant message before a tool is still commentary", async () => {
  const empty = messageItem("msg_empty", null);
  empty.content = [];
  const tool = { id: "call_1", type: "custom_tool_call", name: "view_image", input: "{}" };
  const body = await transform([
    block({ type: "response.output_item.added", output_index: 0, item: { ...empty, status: "in_progress" } }),
    block({ type: "response.output_item.done", output_index: 0, item: empty }),
    block({ type: "response.output_item.added", output_index: 1, item: tool }),
    block({ type: "response.completed", response: { id: "resp_5", status: "completed", output: [empty, tool] } }),
  ].join(""));
  const done = events(body).find((event) => event.type === "response.output_item.done" && event.item?.id === "msg_empty");
  assert.equal(done.item.phase, "commentary");
});

test("held done is flushed even when the stream ends without response.completed", async () => {
  const answer = messageItem("msg_eof", "Done.");
  const body = await transform([
    block({ type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } }),
    block({ type: "response.output_item.done", output_index: 0, item: answer }),
  ].join(""));
  const done = events(body).find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.phase, "final_answer");
});

test("runs after the item-lifecycle normalizer on an interleaved message/tool stream", async () => {
  const note = messageItem("m1", "Checking.");
  const tool = { id: "f1", type: "function_call", name: "t", arguments: "{}" };
  const interleaved = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...note, status: "in_progress", content: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "Checking." }),
    block({ type: "response.output_item.added", output_index: 1, item: tool }),
    block({ type: "response.output_item.done", output_index: 1, item: tool }),
    block({ type: "response.output_item.done", output_index: 0, item: note }),
    block({ type: "response.completed", response: { id: "resp_6", status: "completed", output: [note, tool] } }),
  ].join("");
  const ordered = await transform(interleaved, { TransformClass: ItemLifecycleNormalizer });
  const body = await transform(ordered);
  const out = events(body);
  const addedIndex = out.findIndex((event) => event.type === "response.output_item.added" && event.item?.id === "m1");
  const noteDoneIndex = out.findIndex((event) => event.type === "response.output_item.done" && event.item?.id === "m1");
  const toolAddedIndex = out.findIndex((event) => event.type === "response.output_item.added" && event.item?.id === "f1");
  assert.ok(addedIndex < noteDoneIndex);
  assert.ok(noteDoneIndex < toolAddedIndex);
  assert.equal(out[noteDoneIndex].item.phase, "commentary");
  assert.equal(out.at(-1).response.output[0].phase, "commentary");
});

test("survives fragmented SSE frames", async () => {
  const answer = messageItem("msg_frag", "Hello.");
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } }),
    block({ type: "response.output_item.done", output_index: 0, item: answer }),
    block({ type: "response.completed", response: { id: "resp_7", status: "completed", output: [answer] } }),
  ].join("");
  const body = await transform(input, { chunkSize: 17 });
  const done = events(body).find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.phase, "final_answer");
});

test("native-phased done is not held past the next item", async () => {
  const note = messageItem("msg_native", "Native note.", "commentary");
  const tool = { id: "call_1", type: "function_call", name: "t", arguments: "{}" };
  const body = await transform([
    block({ type: "response.output_item.added", output_index: 0, item: note }),
    block({ type: "response.output_item.done", output_index: 0, item: note }),
    block({ type: "response.output_item.added", output_index: 1, item: tool }),
  ].join(""));
  const out = events(body);
  const doneIndex = out.findIndex((event) => event.type === "response.output_item.done" && event.item?.id === "msg_native");
  const toolIndex = out.findIndex((event) => event.type === "response.output_item.added" && event.item?.id === "call_1");
  assert.ok(doneIndex >= 0 && toolIndex > doneIndex);
  assert.equal(out[doneIndex].item.phase, "commentary");
});
