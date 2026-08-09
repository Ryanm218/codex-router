import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "router-resilience-state-")),
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

// Read the routed turn with the raw client so a socket reset stays
// distinguishable from a complete message. A reset mid-chunked-body leaves
// `response.complete` false, which is the transport failure a reqwest client
// reports as "error decoding response body".
function readRouted(port, body) {
  const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () =>
          resolve({ status: response.statusCode, body: text, complete: response.complete });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

// A gateway that dies partway through an SSE body used to reach the client as a
// bare socket reset: `.pipe()` never forwarded the error, so the response stayed
// half-written until the top-level handler destroyed it, and the log said only
// "[codex-router] request failed".
test("a gateway that dies mid-stream ends the routed body and logs the cause", async () => {
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    // Reset the upstream socket without the terminating chunk, exactly as an
    // edge that drops a live stream does.
    setTimeout(() => response.destroy(), 60);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, {
      model: "deepseek/deepseek-v4-pro",
      input: "hello",
      stream: true,
    });

    assert.equal(result.status, 200);
    assert.equal(
      result.complete,
      true,
      "the chunked body was reset instead of reaching its terminator",
    );
    // What the upstream managed to send survives, and the failure is stated
    // rather than passed off as a short successful turn.
    assert.match(result.body, /event: response\.created/);
    assert.match(result.body, /event: error/);
    assert.match(result.body, /local_router_stream_failed/);

    // The log has to name the cause; the bare string it used to write is why
    // this was undiagnosable in production.
    const deadline = Date.now() + 2_000;
    while (!/request failed: /.test(router.testErrors()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(router.testErrors(), /\[codex-router\] request failed: \w+: .+/);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

// A bare `listen()` failure is an unhandled 'error' event: the process exits
// silently, the supervisor restarts it, and the port is never bound with
// nothing in the log to say why.
test("a taken port exits with a named cause and a distinguishable code", async () => {
  const holder = net.createServer();
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", resolve);
  });
  const takenPort = holder.address().port;
  const router = run({ CODEX_ROUTER_PORT: String(takenPort) });

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("router never exited")), 10_000);
      router.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 98);
    assert.match(router.testErrors(), /cannot listen: 127\.0\.0\.1:\d+ is already in use/);
  } finally {
    await stopChild(router);
    await new Promise((resolve) => holder.close(resolve));
  }
});

// The router must keep answering /health and keep routing when the selection
// file names a provider this build does not have; that read used to throw out
// of the first statement of healthPayload().
test("a selection file naming an unknown provider does not wedge the router", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-resilience-selection-"));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({
      version: 1,
      providers: ["deepseek", "provider-from-a-newer-build"],
    })}\n`,
    { mode: 0o600 },
  );
  const gateway = await mockServer((request, response) => {
    const payload = Buffer.from(JSON.stringify({ ok: true, route: "external" }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // The known provider in the same file still routes.
    const routed = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer codex-caller-auth",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hello" }),
    });
    assert.equal(routed.status, 200);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function readyKimiFallbackStateDir() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-resilience-quota-fallback-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["kimi-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "kimi-api-key.secret"), "TEST_KIMI_KEY\n", { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "quota-fallback.json"),
    `${JSON.stringify({ version: 1, enabled: true, model: "kimi-api/kimi-k3" })}\n`,
    { mode: 0o600 },
  );
  return stateDir;
}

function quotaBody() {
  return {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
  };
}

// Once Kimi's stream has committed (its first byte reached the router), a
// later break is a genuine stream failure -- surfaced exactly like any other
// mid-stream upstream failure -- never a silent replay of the saved native
// quota body.
test("Kimi fallback stream: a break after the first byte surfaces the failure, never the native body", async () => {
  const native = await mockServer((request, response) => {
    const payload = Buffer.from(
      JSON.stringify({ error: { type: "insufficient_quota", message: "quota exhausted" } }),
      "utf8",
    );
    response.writeHead(429, { "Content-Type": "application/json", "Content-Length": String(payload.length) });
    response.end(payload);
  });
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(payload.length) });
      response.end(payload);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    setTimeout(() => response.destroy(), 60);
  });
  const routerPort = await openPort();
  const stateDir = readyKimiFallbackStateDir();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, quotaBody());

    assert.equal(result.status, 200);
    assert.equal(result.complete, true, "the chunked body was reset instead of reaching its terminator");
    assert.match(result.body, /event: response\.created/);
    assert.match(result.body, /event: error/);
    assert.match(result.body, /local_router_stream_failed/);
    assert.doesNotMatch(result.body, /insufficient_quota/);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A 2xx from Kimi is not yet a committed switch. If its stream ends or throws
// before any byte, the router must still hand Codex the original, untouched
// native quota response -- byte-identical -- with no trace of the attempt.
test("Kimi fallback stream: a pre-first-byte failure preserves the exact native response", async () => {
  const nativeBody = Buffer.from(
    JSON.stringify({ error: { type: "insufficient_quota", message: "quota exhausted, no bytes from kimi" } }),
    "utf8",
  );
  const native = await mockServer((request, response) => {
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(nativeBody.length),
      "X-Test-Native": "preserved",
    });
    response.end(nativeBody);
  });
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(payload.length) });
      response.end(payload);
      return;
    }
    // A 200 that never sends a single body byte before dying.
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    setTimeout(() => response.destroy(), 30);
  });
  const routerPort = await openPort();
  const stateDir = readyKimiFallbackStateDir();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer codex-caller-auth" },
      body: JSON.stringify(quotaBody()),
    });
    const bytes = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-test-native"), "preserved");
    assert.equal(Buffer.compare(bytes, nativeBody), 0, "native response bytes were not preserved exactly");
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A real SSE server flushes its headers immediately, well before any body
// byte. That makes fetch() itself resolve successfully -- the failure can
// only surface later, while priming the first body chunk. This is the framing
// the writeHead()-then-destroy() mock above never reaches, because Node
// buffers headers until the first write and so that mock fails at fetch()
// instead. Both framings must preserve the native response identically.
test("Kimi fallback stream: a pre-first-byte failure after headers arrive still preserves the exact native response", async () => {
  const nativeBody = Buffer.from(
    JSON.stringify({ error: { type: "insufficient_quota", message: "quota exhausted, headers but no bytes" } }),
    "utf8",
  );
  const native = await mockServer((request, response) => {
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(nativeBody.length),
      "X-Test-Native": "preserved",
    });
    response.end(nativeBody);
  });
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(payload.length) });
      response.end(payload);
      return;
    }
    // Headers reach the wire immediately; the connection then dies before any
    // body byte follows -- a real network failure inside primeResponseBody's
    // first read, not a fetch()-level connection failure.
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.flushHeaders();
    setTimeout(() => response.destroy(), 30);
  });
  const routerPort = await openPort();
  const stateDir = readyKimiFallbackStateDir();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer codex-caller-auth" },
      body: JSON.stringify(quotaBody()),
    });
    const bytes = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-test-native"), "preserved");
    assert.equal(Buffer.compare(bytes, nativeBody), 0, "native response bytes were not preserved exactly");
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
