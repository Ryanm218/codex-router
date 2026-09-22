import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-grok-internal-service-key-with-sufficient-length";
const auth = { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" };

function sse(events) {
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

async function mockBackend(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function startForwarder(port, backendPort, authPath, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, "src", "grok-oauth-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_GROK_OAUTH_PORT: String(port),
      GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${backendPort}`,
      GROK_CLI: path.join(root, "test", "fixtures", "missing-grok-cli"),
      GROK_AUTH_PATH: authPath,
      MODEL_ROUTER_QUIET: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  child.testErrors = () => errors;
  return child;
}

function writeSession(dir) {
  const authPath = path.join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ "https://auth.x.ai::test-client-id": { key: "fake-access" } }),
    { mode: 0o600 },
  );
  return authPath;
}

async function waitHealth(base, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`exited: ${child.testErrors()}`);
    try {
      const response = await fetch(`${base}/health`, { headers: auth });
      if (response.ok) return;
    } catch {
      // The listener is still coming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`health timeout: ${child.testErrors()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

function chatCompletionErrorFrames(body) {
  return String(body)
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) return [];
      try {
        const json = JSON.parse(dataLine.slice(5).trim());
        return json.error ? [json.error] : [];
      } catch {
        return [];
      }
    });
}

const afterToolBody = {
  model: "grok-4.7",
  messages: [
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "tool output" },
  ],
  tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
  stream: true,
};

function progressOnlyAttempt() {
  return sse([
    { type: "response.output_text.delta", delta: "Status only." },
    { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 500 } } },
  ]);
}

async function readUntil(reader, predicate, timeoutMs) {
  const decoder = new TextDecoder();
  let body = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(body)) {
    if (Date.now() > deadline) throw new Error(`read timeout: ${body.slice(0, 400)}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended early: ${body.slice(0, 400)}`);
    body += decoder.decode(value, { stream: true });
  }
  return body;
}

test("comment keepalive does not keep a strict repair past the progress idle", async () => {
  let inbound = 0;
  let held;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (inbound === 1) {
      res.end(progressOnlyAttempt());
      return;
    }
    res.flushHeaders();
    const timer = setInterval(() => res.write(": ping\n\n"), 40);
    held = res;
    res.once("close", () => clearInterval(timer));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-repair-progress-comments-"));
  const child = startForwarder(port, backend.port, writeSession(dir), {
    CODEX_ROUTER_GROK_REPAIR_IDLE_MS: "200",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(afterToolBody),
    });
    const body = await Promise.race([
      response.text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("comment stream was still open after the progress idle")), 2_000)),
    ]);
    const errors = chatCompletionErrorFrames(body);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "grok_repair_idle");
    assert.doesNotMatch(body, /\[DONE\]|exec_command/);
  } finally {
    held?.destroy();
    await stop(child);
    await new Promise((resolve) => backend.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("response.in_progress does not keep a strict repair past the progress idle", async () => {
  let inbound = 0;
  let held;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (inbound === 1) {
      res.end(progressOnlyAttempt());
      return;
    }
    res.flushHeaders();
    const timer = setInterval(() => {
      res.write(sse([{ type: "response.in_progress", response: { id: "resp_repair", status: "in_progress", output: [] } }]));
    }, 40);
    held = res;
    res.once("close", () => clearInterval(timer));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-repair-progress-lifecycle-"));
  const child = startForwarder(port, backend.port, writeSession(dir), {
    CODEX_ROUTER_GROK_REPAIR_IDLE_MS: "200",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(afterToolBody),
    });
    const body = await Promise.race([
      response.text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("lifecycle stream was still open after the progress idle")), 2_000)),
    ]);
    assert.equal(chatCompletionErrorFrames(body)[0]?.code, "grok_repair_idle");
    assert.doesNotMatch(body, /\[DONE\]/);
  } finally {
    held?.destroy();
    await stop(child);
    await new Promise((resolve) => backend.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sliced response.in_progress frames do not keep a strict repair past the progress idle", async () => {
  let inbound = 0;
  let held;
  const frame = sse([{ type: "response.in_progress", response: { id: "resp_repair", status: "in_progress", output: [] } }]);
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (inbound === 1) {
      res.end(progressOnlyAttempt());
      return;
    }
    res.flushHeaders();
    let at = 0;
    const timer = setInterval(() => {
      res.write(frame.slice(at, at + 8));
      at += 8;
      if (at >= frame.length) at = 0;
    }, 40);
    held = res;
    res.once("close", () => clearInterval(timer));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-repair-progress-sliced-"));
  const child = startForwarder(port, backend.port, writeSession(dir), {
    CODEX_ROUTER_GROK_REPAIR_IDLE_MS: "200",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(afterToolBody),
    });
    const body = await Promise.race([
      response.text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("sliced lifecycle stream was still open after the progress idle")), 2_000)),
    ]);
    assert.equal(chatCompletionErrorFrames(body)[0]?.code, "grok_repair_idle");
  } finally {
    held?.destroy();
    await stop(child);
    await new Promise((resolve) => backend.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an incomplete tool frame emits the stall keepalive before the frame parses", async () => {
  let inbound = 0;
  let held;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (inbound === 1) {
      res.end(progressOnlyAttempt());
      return;
    }
    res.flushHeaders();
    res.write('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"');
    held = res;
    await new Promise((resolve) => res.once("close", resolve));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-repair-progress-partial-"));
  const child = startForwarder(port, backend.port, writeSession(dir), {
    CODEX_ROUTER_GROK_REPAIR_IDLE_MS: "2000",
    CODEX_ROUTER_GROK_REPAIR_KEEPALIVE_MS: "0",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(afterToolBody),
    });
    const reader = response.body.getReader();
    const before = await readUntil(reader, (body) => body.includes("\u2060"), 1_500);
    assert.doesNotMatch(before, /grok_repair_idle|function_call_arguments/);
  } finally {
    held?.destroy();
    await stop(child);
    await new Promise((resolve) => backend.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withheld tool progress emits a stall keepalive and releases the tool only after completed", async () => {
  let inbound = 0;
  let releaseCompleted;
  const completedGate = new Promise((resolve) => {
    releaseCompleted = resolve;
  });
  const args = JSON.stringify({ cmd: "kept-alive" });
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (inbound === 1) {
      res.end(progressOnlyAttempt());
      return;
    }
    res.flushHeaders();
    res.write(sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_live", call_id: "call_live", name: "exec_command" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_live", delta: args },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_live", call_id: "call_live", name: "exec_command", arguments: args } },
    ]));
    await completedGate;
    res.end(sse([
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 110, output_tokens: 30 } } },
    ]));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-repair-progress-tool-"));
  const child = startForwarder(port, backend.port, writeSession(dir), {
    CODEX_ROUTER_GROK_REPAIR_IDLE_MS: "300",
    CODEX_ROUTER_GROK_REPAIR_KEEPALIVE_MS: "0",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(afterToolBody),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const before = await readUntil(reader, (body) => body.includes("\u2060"), 2_000);
    assert.doesNotMatch(before, /kept-alive/);
    releaseCompleted();
    const decoder = new TextDecoder();
    let body = before;
    const deadline = Date.now() + 2_000;
    while (!body.includes("kept-alive")) {
      if (Date.now() > deadline) throw new Error(`tool call missing after completed: ${body.slice(0, 500)}`);
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    assert.match(body, /kept-alive/);
    assert.doesNotMatch(body, /grok_repair_idle/);
  } finally {
    releaseCompleted();
    await stop(child);
    await new Promise((resolve) => backend.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
