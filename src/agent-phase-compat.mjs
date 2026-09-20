import { Transform } from "node:stream";
import { TextDecoder } from "node:util";

// LiteLLM's chat-completions -> Responses bridge never copies Codex's
// `message.phase`. Native Codex tags in-flight notes `commentary` and the
// close-out `final_answer`, which is what Desktop folds under "Worked for".
// Bridged models therefore land unphased AgentMessages that stay expanded.
//
// After the item-lifecycle normalizer has made items sequential, this stage
// assigns those phases for every routed SSE provider:
//   * assistant message followed by a tool call -> commentary
//   * last assistant message of the turn with no following tool -> final_answer
//   * an already-set native phase is left alone and is not held
// Added events are tagged commentary immediately so live notes can fold;
// the held `output_item.done` (and `response.completed` output[]) get the
// final assignment once the next item or the terminal event arrives.
const CRLF_SEP = Buffer.from("\r\n\r\n");
const LF_SEP = Buffer.from("\n\n");
const TOOL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);
const TERMINAL_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.done",
  "error",
]);
const KNOWN_PHASES = new Set(["commentary", "final_answer"]);

function fatalUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function findFrameEnd(buffer) {
  const crlf = buffer.indexOf(CRLF_SEP);
  const lf = buffer.indexOf(LF_SEP);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, separator: CRLF_SEP };
  }
  if (lf !== -1) return { index: lf, separator: LF_SEP };
  return undefined;
}

function parseFrame(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/u);
  const dataLines = [];
  const dataIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    dataIndexes.push(index);
  }
  if (!dataLines.length) return undefined;
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { terminal: true, lines, newline, dataIndexes };
  try {
    return { event: JSON.parse(dataText), lines, newline, dataIndexes, dataText };
  } catch {
    return undefined;
  }
}

function rewrittenFrame(parsed, event, separator) {
  const dataText = JSON.stringify(event);
  if (dataText === parsed.dataText) {
    return Buffer.concat([Buffer.from(parsed.lines.join(parsed.newline)), separator]);
  }
  const lines = [...parsed.lines];
  if (parsed.dataIndexes.length === 1) {
    lines[parsed.dataIndexes[0]] = `data: ${dataText}`;
  } else {
    const first = parsed.dataIndexes[0];
    const last = parsed.dataIndexes[parsed.dataIndexes.length - 1];
    lines.splice(first, last - first + 1, `data: ${dataText}`);
  }
  return Buffer.concat([Buffer.from(lines.join(parsed.newline)), separator]);
}

function isAssistantMessage(item) {
  return item?.type === "message" && (item.role == null || item.role === "assistant");
}

function knownPhase(item) {
  return typeof item?.phase === "string" && KNOWN_PHASES.has(item.phase) ? item.phase : undefined;
}

function withPhase(item, phase) {
  if (!item || item.phase === phase) return item;
  return { ...item, phase };
}

export class AgentPhaseCompatTransform extends Transform {
  #buffer = Buffer.alloc(0);
  #passthrough = false;
  #pending;
  #phases = new Map();

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#passthrough) {
      this.push(piece);
      callback();
      return;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    this.#drain(false);
    callback();
  }

  _flush(callback) {
    if (this.#passthrough) {
      if (this.#buffer.length) this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
      this.#flushPending("final_answer");
      callback();
      return;
    }
    this.#drain(true);
    this.#flushPending("final_answer");
    callback();
  }

  #disable(original) {
    this.#flushPending("commentary");
    if (original?.length) this.push(original);
    if (this.#buffer.length) {
      this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
    }
    this.#passthrough = true;
  }

  #drain(flush) {
    while (this.#buffer.length && !this.#passthrough) {
      const found = findFrameEnd(this.#buffer);
      if (!found) {
        if (!flush) return;
        const original = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#handleFrame(original, Buffer.alloc(0));
        return;
      }
      const block = this.#buffer.subarray(0, found.index);
      const separator = found.separator;
      const original = this.#buffer.subarray(0, found.index + separator.length);
      this.#buffer = this.#buffer.subarray(found.index + separator.length);
      this.#handleFrame(original, separator, block);
    }
  }

  #handleFrame(original, separator, block = original) {
    let text;
    try {
      text = fatalUtf8(block);
    } catch {
      this.#disable(original);
      return;
    }
    const parsed = parseFrame(text);
    if (!parsed || parsed.terminal || !parsed.event) {
      if (parsed?.terminal) this.#flushPending("final_answer");
      this.push(Buffer.from(original));
      return;
    }
    const event = parsed.event;
    const type = event?.type;
    if (TERMINAL_TYPES.has(type)) {
      this.#flushPending("final_answer");
      this.push(this.#rewriteCompleted(parsed, event, separator, original));
      return;
    }
    if (type === "response.output_item.added") {
      const item = event.item;
      if (isAssistantMessage(item)) {
        this.#flushPending("commentary");
        const native = knownPhase(item);
        const assigned = native ?? "commentary";
        if (item.id) this.#phases.set(item.id, assigned);
        if (!native) {
          this.#pending = {
            id: item.id,
            assigned,
            done: undefined,
          };
        }
        const nextItem = assigned === item.phase ? item : withPhase(item, assigned);
        if (nextItem === item) this.push(Buffer.from(original));
        else this.push(rewrittenFrame(parsed, { ...event, item: nextItem }, separator));
        return;
      }
      if (TOOL_ITEM_TYPES.has(item?.type)) {
        this.#flushPending("commentary");
        this.push(Buffer.from(original));
        return;
      }
      this.push(Buffer.from(original));
      return;
    }
    if (type === "response.output_item.done" && isAssistantMessage(event.item)) {
      const item = event.item;
      if (this.#pending && this.#pending.id === item.id && !this.#pending.done) {
        this.#pending.done = { parsed, event, separator, original };
        return;
      }
      if (knownPhase(item)) {
        if (item.id) this.#phases.set(item.id, item.phase);
        this.push(Buffer.from(original));
        return;
      }
      const assigned = this.#phases.get(item.id) ?? knownPhase(item);
      if (!assigned || item.phase === assigned) {
        this.push(Buffer.from(original));
        return;
      }
      this.push(rewrittenFrame(parsed, { ...event, item: withPhase(item, assigned) }, separator));
      return;
    }
    this.push(Buffer.from(original));
  }

  #flushPending(phase) {
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    const assigned = phase === "final_answer" ? "final_answer" : "commentary";
    if (pending.id) this.#phases.set(pending.id, assigned);
    const held = pending.done;
    if (!held) return;
    const item = held.event.item;
    if (item.phase === assigned) {
      this.push(Buffer.from(held.original));
      return;
    }
    this.push(rewrittenFrame(
      held.parsed,
      { ...held.event, item: withPhase(item, assigned) },
      held.separator,
    ));
  }

  #rewriteCompleted(parsed, event, separator, original) {
    const output = event.response?.output;
    if (!Array.isArray(output) || this.#phases.size === 0) {
      return Buffer.from(original);
    }
    let changed = false;
    const nextOutput = output.map((item) => {
      if (!isAssistantMessage(item) || !item.id) return item;
      const assigned = this.#phases.get(item.id);
      if (!assigned || item.phase === assigned) return item;
      changed = true;
      return withPhase(item, assigned);
    });
    if (!changed) return Buffer.from(original);
    return rewrittenFrame(
      parsed,
      { ...event, response: { ...event.response, output: nextOutput } },
      separator,
    );
  }
}

export function agentPhaseCompatTransform(contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new AgentPhaseCompatTransform();
}
