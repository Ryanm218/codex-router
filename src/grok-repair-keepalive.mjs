import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

import { parseSseBlockEvent } from "./grok-oauth-turn.mjs";

// U+2060 WORD JOINER. LiteLLM only forwards a non-empty reasoning_content
// field, and Codex already ignores response.in_progress. The character is not
// a status sentence. The transform below removes it before any reasoning
// snapshot can store it.
export const GROK_REPAIR_STALL_KEEPALIVE = "\u2060";

const PROGRESS_EVENT_TYPES = [
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
];

const REASONING_DELTA_TYPES = new Set([
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
]);

const REASONING_SNAPSHOT_TYPES = new Set([
  "response.reasoning_summary_text.done",
  "response.reasoning_text.done",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_part.added",
]);

const TERMINAL_RESPONSE_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

export function grokRepairKeepaliveMs(environment = process.env) {
  if (!Object.hasOwn(environment, "CODEX_ROUTER_GROK_REPAIR_KEEPALIVE_MS")) return 30_000;
  const raw = environment.CODEX_ROUTER_GROK_REPAIR_KEEPALIVE_MS;
  if (raw === 0 || raw === "0") return 0;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
}

export function isRepairProgressEvent(event) {
  if (!event || typeof event !== "object") return false;
  switch (event.type) {
    case "response.output_text.delta":
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta":
      return typeof event.delta === "string" && event.delta.length > 0;
    case "response.output_item.added":
    case "response.output_item.done": {
      const type = event.item?.type;
      return type === "function_call" || type === "custom_tool_call";
    }
    case "response.function_call_arguments.done":
    case "response.custom_tool_call_input.done": {
      const payload = event.arguments ?? event.input ?? event.text;
      return typeof payload === "string" && payload.length > 0;
    }
    default:
      return false;
  }
}

function nextSseBoundary(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) return { at: lf, size: 2 };
  if (lf === -1) return { at: crlf, size: 4 };
  return crlf < lf ? { at: crlf, size: 4 } : { at: lf, size: 2 };
}

function splitComplete(buffer) {
  const blocks = [];
  let rest = buffer;
  let boundary;
  while ((boundary = nextSseBoundary(rest))) {
    blocks.push(rest.slice(0, boundary.at));
    rest = rest.slice(boundary.at + boundary.size);
  }
  return { blocks, tail: rest };
}

function joinedData(tail) {
  const lines = [];
  for (const line of tail.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    lines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return lines.join("\n");
}

// One SSE event. An `event:` line wins. Otherwise the type is the top-level
// field at the start of the joined `data:` payload. A later data line that
// happens to begin with a nested `{"type":...}` is not a new event.
function declaredEventType(tail) {
  for (const line of tail.split(/\r?\n/)) {
    if (line.startsWith("event:")) return line.slice(6).trim();
  }
  const match = /^\{\s*"type"\s*:\s*"([^"]+)"/.exec(joinedData(tail).trimStart());
  return match ? match[1] : "";
}

function tailNamesProgress(tail) {
  const type = declaredEventType(tail);
  if (PROGRESS_EVENT_TYPES.includes(type)) return true;
  if (type !== "response.output_item.added" && type !== "response.output_item.done") return false;
  return /"item"\s*:\s*\{[^}]*"type"\s*:\s*"(?:function_call|custom_tool_call)"/.test(tail);
}

// Comment lines are not progress. A `: ping` after an unfinished tool frame
// must not look like a new answer byte.
function progressBody(tail) {
  return tail
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith(":"))
    .join("\n");
}

function progressTailAdvanced(previousTail, nextTail) {
  const previousBody = progressBody(previousTail);
  const nextBody = progressBody(nextTail);
  return nextBody !== previousBody && tailNamesProgress(nextBody);
}

export function repairChunkResetsIdle(previousBuffer, nextBuffer) {
  const previous = splitComplete(previousBuffer || "");
  const next = splitComplete(nextBuffer || "");
  if (progressTailAdvanced(previous.tail, next.tail)) return true;
  const fresh = next.blocks.slice(previous.blocks.length);
  return fresh.some((block) => isRepairProgressEvent(parseSseBlockEvent(block)));
}

// A completed reasoning delta is forwarded as itself. Every other idle reset
// is answer text or a tool call that Codex has not been shown yet, or a
// progress frame that has not finished, so the stall bridge has to go out now.
export function repairKeepaliveDue(previousBuffer, nextBuffer) {
  const previous = splitComplete(previousBuffer || "");
  const next = splitComplete(nextBuffer || "");
  const fresh = next.blocks.slice(previous.blocks.length);
  for (const block of fresh) {
    const event = parseSseBlockEvent(block);
    if (!isRepairProgressEvent(event)) continue;
    if (!REASONING_DELTA_TYPES.has(event.type)) return true;
  }
  return progressTailAdvanced(previous.tail, next.tail);
}

function isKeepaliveOnly(text) {
  return typeof text === "string"
    && text.length > 0
    && text.split(GROK_REPAIR_STALL_KEEPALIVE).join("").length === 0;
}

function stripKeepaliveText(text) {
  return typeof text === "string" ? text.split(GROK_REPAIR_STALL_KEEPALIVE).join("") : text;
}

function containsKeepalive(value) {
  if (typeof value === "string") return value.includes(GROK_REPAIR_STALL_KEEPALIVE);
  if (Array.isArray(value)) return value.some(containsKeepalive);
  if (value && typeof value === "object") return Object.values(value).some(containsKeepalive);
  return false;
}

function stripKeepaliveValue(value) {
  if (typeof value === "string") return stripKeepaliveText(value);
  if (Array.isArray(value)) return value.map(stripKeepaliveValue);
  if (value && typeof value === "object") {
    const stripped = {};
    for (const [key, inner] of Object.entries(value)) stripped[key] = stripKeepaliveValue(inner);
    return stripped;
  }
  return value;
}

function isEmptyReasoningAdded(event) {
  if (event?.type !== "response.output_item.added" || event.item?.type !== "reasoning") return false;
  const summary = event.item.summary;
  if (summary == null) return true;
  if (!Array.isArray(summary) || summary.length === 0) return true;
  return summary.every((part) => typeof part?.text !== "string" || part.text.length === 0);
}

function responseIdentity(event) {
  const response = event?.response;
  if (!response || typeof response.id !== "string") return undefined;
  return {
    id: response.id,
    object: "response",
    ...(Number.isFinite(response.created_at) ? { created_at: response.created_at } : {}),
    ...(typeof response.model === "string" ? { model: response.model } : {}),
    status: "in_progress",
    output: [],
  };
}

function inProgressBlock(identity) {
  const response = identity || { object: "response", status: "in_progress", output: [] };
  return `event: response.in_progress\ndata: ${JSON.stringify({
    type: "response.in_progress",
    response,
  })}\n\n`;
}

function encodeBlock(event) {
  const type = typeof event?.type === "string" ? event.type : "message";
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sanitizeReasoningEvent(event) {
  if (!containsKeepalive(event)) return { action: "forward", event };
  if (REASONING_DELTA_TYPES.has(event.type)) {
    if (isKeepaliveOnly(event.delta)) return { action: "keepalive" };
    return { action: "rewrite", event: { ...event, delta: stripKeepaliveText(event.delta) } };
  }
  if (REASONING_SNAPSHOT_TYPES.has(event.type) || (event.type === "response.output_item.done" && event.item?.type === "reasoning")) {
    const stripped = stripKeepaliveValue(event);
    const text = stripped.text ?? stripped.part?.text;
    if (typeof event.text === "string" && isKeepaliveOnly(event.text)) return { action: "drop" };
    if (typeof event.part?.text === "string" && isKeepaliveOnly(event.part.text) && stripKeepaliveText(event.part.text).length === 0 && !stripped.item) {
      return { action: "drop" };
    }
    if (text === "") return { action: "drop" };
    return { action: "rewrite", event: stripped };
  }
  if (TERMINAL_RESPONSE_TYPES.has(event.type) && Array.isArray(event.response?.output)) {
    const output = event.response.output.map((item) => (
      item?.type === "reasoning" ? stripKeepaliveValue(item) : item
    ));
    return { action: "rewrite", event: { ...event, response: { ...event.response, output } } };
  }
  return { action: "forward", event };
}

// First Grok Responses transform. A joiner-only reasoning delta becomes
// response.in_progress so the empty-completion stall resets. The original
// response.created event is forwarded unchanged.
export class GrokRepairKeepaliveTransform extends Transform {
  #decoder = new StringDecoder("utf8");
  #parseBuffer = "";
  #identity;
  #held;

  _transform(chunk, _encoding, callback) {
    this.#parseBuffer += this.#decoder.write(Buffer.from(chunk));
    let boundary;
    while ((boundary = nextSseBoundary(this.#parseBuffer))) {
      const raw = this.#parseBuffer.slice(0, boundary.at);
      const separator = this.#parseBuffer.slice(boundary.at, boundary.at + boundary.size);
      this.#parseBuffer = this.#parseBuffer.slice(boundary.at + boundary.size);
      this.#consume(raw, separator);
    }
    callback();
  }

  _flush(callback) {
    if (this.#held) this.push(this.#held.raw + this.#held.separator);
    this.#held = undefined;
    const rest = this.#parseBuffer + this.#decoder.end();
    if (rest) this.push(rest);
    this.#parseBuffer = "";
    callback();
  }

  #consume(raw, separator) {
    const event = parseSseBlockEvent(raw);
    if (event?.type === "response.created" || event?.type === "response.in_progress") {
      this.#identity = responseIdentity(event) ?? this.#identity;
    }
    if (this.#held && isEmptyReasoningAdded(event) === false) {
      const decision = event ? sanitizeReasoningEvent(event) : { action: "forward" };
      if (decision.action === "keepalive") {
        this.#held = undefined;
        this.push(inProgressBlock(this.#identity));
        return;
      }
      this.push(this.#held.raw + this.#held.separator);
      this.#held = undefined;
    }
    if (isEmptyReasoningAdded(event)) {
      if (this.#held) this.push(this.#held.raw + this.#held.separator);
      this.#held = { raw, separator };
      return;
    }
    if (!event) {
      this.push(raw + separator);
      return;
    }
    const decision = sanitizeReasoningEvent(event);
    if (decision.action === "keepalive") {
      this.push(inProgressBlock(this.#identity));
      return;
    }
    if (decision.action === "drop") return;
    if (decision.action === "rewrite") {
      this.push(encodeBlock(decision.event));
      return;
    }
    this.push(raw + separator);
  }
}
