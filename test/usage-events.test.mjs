import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("usage events persist only bounded request metadata in a private file", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?test=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 321,
      inputTokens: 120,
      outputTokens: 35,
      totalTokens: 155,
      prompt: "never persisted",
    });
    assert.deepEqual(usage.recentUsageEvents(), [
      {
        meteringVersion: 1,
        at: usage.recentUsageEvents()[0].at,
        model: "grok-oauth/grok-4.5",
        provider: "grok-oauth",
        status: 200,
        durationMs: 321,
        inputTokens: 120,
        outputTokens: 35,
        totalTokens: 155,
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal(statSync(usage.USAGE_EVENTS_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reading usage events folds protocol variants into their canonical provider", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?variant=${Date.now()}`);
    // Historical events recorded before canonicalization carry the variant id.
    usage.recordUsageEvent({
      model: "opencode-go-messages/minimax-m3",
      provider: "opencode-go-messages",
      status: 200,
      durationMs: 50,
    });
    assert.equal(usage.recentUsageEvents()[0].provider, "opencode-go");
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a quota-fallback event is isolated from model usage and drops hostile fields", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?fallback=${Date.now()}`);
    // STATE_DIR resolves once per process on paths.mjs's first load, so a
    // later test's freshly minted stateDir above has no effect on it. Start
    // from a clean file at whatever path actually resolved.
    rmSync(usage.USAGE_EVENTS_PATH, { force: true });
    usage.recordUsageEvent({
      model: "gpt-5.6-sol",
      provider: "openai",
      status: 200,
      durationMs: 900,
    });
    usage.recordQuotaFallbackEvent({
      nativeProvider: "openai",
      nativeModel: "gpt-5.6-sol",
      fallbackProvider: "kimi-api",
      fallbackModel: "kimi-api/kimi-k3",
      errorClass: "terminal-quota",
      outcome: "skipped-nonportable",
      status: 429,
      durationMs: 18,
      prompt: "must-not-persist",
      bodyText: "must-not-persist",
    });

    assert.equal(usage.recentUsageEvents().length, 1);
    assert.equal(usage.recentUsageEvents()[0].provider, "openai");

    const lastFallback = usage.recentQuotaFallbackEvent();
    assert.deepEqual(lastFallback, {
      at: lastFallback.at,
      nativeProvider: "openai",
      nativeModel: "gpt-5.6-sol",
      fallbackProvider: "kimi-api",
      fallbackModel: "kimi-api/kimi-k3",
      errorClass: "terminal-quota",
      outcome: "skipped-nonportable",
      status: 429,
      durationMs: 18,
    });

    const raw = readFileSync(usage.USAGE_EVENTS_PATH, "utf8");
    assert.equal(raw.includes("must-not-persist"), false);
    if (process.platform !== "win32") {
      assert.equal(statSync(usage.USAGE_EVENTS_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recordQuotaFallbackEvent rejects an unknown outcome without writing a line", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?badoutcome=${Date.now()}`);
    rmSync(usage.USAGE_EVENTS_PATH, { force: true });
    usage.recordQuotaFallbackEvent({
      nativeProvider: "openai",
      nativeModel: "gpt-5.6-sol",
      fallbackProvider: "kimi-api",
      fallbackModel: "kimi-api/kimi-k3",
      errorClass: "terminal-quota",
      outcome: "not-a-real-outcome",
      durationMs: 1,
    });
    assert.equal(existsSync(usage.USAGE_EVENTS_PATH), false);
    assert.equal(usage.recentQuotaFallbackEvent(), null);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("fallback-control rows never evict a model-usage row from the result limit", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?limit=${Date.now()}`);
    rmSync(usage.USAGE_EVENTS_PATH, { force: true });
    usage.recordUsageEvent({
      model: "gpt-5.6-sol",
      provider: "openai",
      status: 200,
      durationMs: 5,
    });
    // Outnumber the small result limit with control rows alone.
    for (let index = 0; index < 20; index += 1) {
      usage.recordQuotaFallbackEvent({
        nativeProvider: "openai",
        nativeModel: "gpt-5.6-sol",
        fallbackProvider: "kimi-api",
        fallbackModel: "kimi-api/kimi-k3",
        errorClass: "terminal-quota",
        outcome: "skipped-cooldown",
        durationMs: 1,
      });
    }
    const events = usage.recentUsageEvents({ limit: 5 });
    assert.equal(events.length, 1);
    assert.equal(events[0].provider, "openai");
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
