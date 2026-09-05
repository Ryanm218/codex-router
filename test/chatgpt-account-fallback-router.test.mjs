import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

process.env.MODEL_ROUTER_TEST_HELPERS = "1";
process.env.CODEX_ROUTER_INTERNAL_KEY = "test-internal-key";
process.env.CODEX_ROUTER_CALLER_KEY = "test-caller-key-abcdefghijklmnopqrstuvwxyz";
const { attemptNativeAccountFailover } = await import("../src/router.mjs");

test("native quota fallback attests the ChatGPT identity and preserves portable state", async () => {
  const calls = [];
  let released = 0;
  const primaryIdentity = "chatgpt-primary";
  const backupIdentity = "chatgpt-backup";
  const backupId = "acct_backup_12345678";
  const pool = {
    version: 1,
    policy: {
      enabled: true,
      mode: "switch",
      fallback: { enabled: true, strategy: "strict-priority", maxHops: 2, affinityTtlSeconds: 604800 },
    },
    accounts: {
      [backupId]: {
        id: backupId,
        state: "active",
        paused: false,
        priority: 1,
        identity: { accountId: backupIdentity },
        subscription: { status: "usable" },
        fallback: {
          enabled: true,
          quota: { state: "clear" },
          catalog: { state: "ready", generation: "abcdefghijklmnopqrstuv", capturedAt: new Date().toISOString(), lastResult: "ok" },
        },
        health: { state: "healthy" },
      },
    },
    sessions: {},
  };
  const result = await attemptNativeAccountFailover({
    request: { headers: { authorization: "Bearer native-token" } },
    response: { headersSent: false, writableEnded: false, destroyed: false },
    target: "https://api.openai.test/v1/responses",
    headers: {
      authorization: "Bearer native-token",
      "chatgpt-account-id": primaryIdentity,
      "content-type": "application/json",
    },
    body: Buffer.from('{"model":"gpt-5.6"}'),
    primaryAccountId: primaryIdentity,
    primaryFailure: { status: 429, headers: {}, bodyText: JSON.stringify({ error: { type: "usage_limit_reached" } }) },
    signal: new AbortController().signal,
    platform: "darwin",
    readPool: () => pool,
    sessionMatches: (token) => token === "native-token",
    subscriptionStatus: () => ({ usable: true }),
    createLease: async () => ({ release: async () => { released += 1; } }),
    authSnapshot: async ({ expectedAccountId }) => {
      assert.equal(expectedAccountId, backupIdentity);
      return { headers: { authorization: "Bearer backup-token", "chatgpt-account-id": backupIdentity } };
    },
    fetchImpl: async (_target, init) => {
      calls.push(init);
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(result.account.id, backupId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["chatgpt-account-id"], backupIdentity);
  assert.equal(released, 0);
  await result.lease.release();
  assert.equal(released, 1);
});

test("native quota fallback refuses opaque account-bound transcript state", async () => {
  const result = await attemptNativeAccountFailover({
    request: { headers: { authorization: "Bearer native-token" } },
    response: { headersSent: false, writableEnded: false, destroyed: false },
    target: "https://api.openai.test/v1/responses",
    headers: {
      authorization: "Bearer native-token",
      "chatgpt-account-id": "chatgpt-primary",
      "x-codex-turn-state": "opaque",
    },
    body: Buffer.from("{}"),
    primaryAccountId: "chatgpt-primary",
    primaryFailure: { status: 429, bodyText: JSON.stringify({ error: { type: "usage_limit_reached" } }) },
    signal: new AbortController().signal,
    platform: "darwin",
    sessionMatches: () => true,
    fetchImpl: async () => { throw new Error("must not send"); },
  });
  assert.equal(result, undefined);
});

test("native quota fallback scans large JSON before compression and replays identical wire bytes", async () => {
  const backupId = "acct_backup_12345678";
  const portableBody = Buffer.from(JSON.stringify({
    model: "gpt-5.6",
    input: [{ role: "system", content: "portable ".repeat(4_000) }],
  }));
  assert.ok(portableBody.length > 16 * 1024);
  const wireBody = zstdCompressSync(portableBody);
  assert.ok(wireBody.length < portableBody.length);
  let sentBody;
  const result = await attemptNativeAccountFailover({
    request: { headers: { authorization: "Bearer native-token" } },
    response: { headersSent: false, writableEnded: false, destroyed: false },
    target: "https://api.openai.test/v1/responses",
    headers: {
      authorization: "Bearer native-token",
      "chatgpt-account-id": "chatgpt-primary",
      "content-encoding": "zstd",
    },
    body: wireBody,
    portableBody,
    primaryAccountId: "chatgpt-primary",
    primaryFailure: {
      status: 429,
      bodyText: JSON.stringify({ error: { type: "usage_limit_reached" } }),
    },
    signal: new AbortController().signal,
    platform: "darwin",
    readPool: () => ({
      version: 1,
      policy: {
        enabled: true,
        mode: "switch",
        fallback: { enabled: true, strategy: "strict-priority", maxHops: 2 },
      },
      accounts: {
        [backupId]: {
          id: backupId,
          state: "active",
          paused: false,
          priority: 1,
          identity: { accountId: "chatgpt-backup" },
          subscription: { status: "usable" },
          fallback: {
            enabled: true,
            quota: { state: "clear" },
            catalog: { state: "ready", generation: "abcdefghijklmnopqrstuv", capturedAt: new Date().toISOString(), lastResult: "ok" },
          },
          health: { state: "healthy" },
        },
      },
      sessions: {},
    }),
    sessionMatches: () => true,
    subscriptionStatus: () => ({ usable: true }),
    createLease: async () => ({ release: async () => {} }),
    authSnapshot: async () => ({
      headers: { authorization: "Bearer backup-token", "chatgpt-account-id": "chatgpt-backup" },
    }),
    fetchImpl: async (_target, init) => {
      sentBody = init.body;
      return new Response("ok", { status: 200 });
    },
  });
  assert.ok(result);
  assert.equal(sentBody, wireBody);
  await result.lease.release();
});

function failoverPool(...accounts) {
  return {
    version: 1,
    policy: {
      enabled: true,
      mode: "switch",
      fallback: { enabled: true, strategy: "strict-priority", maxHops: 2 },
    },
    accounts: Object.fromEntries(accounts.map(({ id, priority, identity }) => [id, {
      id,
      state: "active",
      paused: false,
      priority,
      identity: { accountId: identity },
      subscription: { status: "usable" },
      fallback: {
        enabled: true,
        quota: { state: "clear" },
        catalog: { state: "ready", generation: "abcdefghijklmnopqrstuv", capturedAt: new Date().toISOString(), lastResult: "ok" },
      },
      health: { state: "healthy" },
    }])),
    sessions: {},
  };
}

function failoverRequestOptions(overrides = {}) {
  return {
    request: { headers: { authorization: "Bearer native-token" } },
    response: { headersSent: false, writableEnded: false, destroyed: false },
    target: "https://api.openai.test/v1/responses",
    headers: {
      authorization: "Bearer native-token",
      "chatgpt-account-id": "chatgpt-primary",
      "content-type": "application/json",
    },
    body: Buffer.from('{"model":"gpt-5.6"}'),
    primaryAccountId: "chatgpt-primary",
    primaryFailure: { status: 429, bodyText: JSON.stringify({ error: { type: "usage_limit_reached" } }) },
    signal: new AbortController().signal,
    platform: "darwin",
    sessionMatches: () => true,
    subscriptionStatus: () => ({ usable: true }),
    authSnapshot: async ({ expectedAccountId }) => ({
      headers: { authorization: `Bearer ${expectedAccountId}`, "chatgpt-account-id": expectedAccountId },
    }),
    ...overrides,
  };
}

test("native quota fallback stops after an ambiguous backup transport failure", async () => {
  const attempts = [];
  let released = 0;
  const pool = failoverPool(
    { id: "acct_backup_1", priority: 1, identity: "chatgpt-backup-1" },
    { id: "acct_backup_2", priority: 2, identity: "chatgpt-backup-2" },
  );
  const result = await attemptNativeAccountFailover(failoverRequestOptions({
    readPool: () => pool,
    createLease: async () => ({ release: async () => { released += 1; } }),
    fetchImpl: async (_target, init) => {
      attempts.push(init.headers["chatgpt-account-id"]);
      if (attempts.length === 1) throw new Error("connection reset after write");
      return new Response("ok", { status: 200 });
    },
  }));
  assert.equal(result, undefined);
  assert.deepEqual(attempts, ["chatgpt-backup-1"]);
  assert.equal(released, 1);
});

test("native quota fallback stops when a backup response body cannot be read", async () => {
  const attempts = [];
  let released = 0;
  const pool = failoverPool(
    { id: "acct_backup_1", priority: 1, identity: "chatgpt-backup-1" },
    { id: "acct_backup_2", priority: 2, identity: "chatgpt-backup-2" },
  );
  const unreadableResponse = {
    ok: false,
    status: 429,
    body: {
      getReader: () => ({
        read: async () => { throw new Error("response body read failed"); },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
  const result = await attemptNativeAccountFailover(failoverRequestOptions({
    readPool: () => pool,
    createLease: async () => ({ release: async () => { released += 1; } }),
    fetchImpl: async (_target, init) => {
      attempts.push(init.headers["chatgpt-account-id"]);
      if (attempts.length === 1) return unreadableResponse;
      return new Response("ok", { status: 200 });
    },
  }));
  assert.equal(result, undefined);
  assert.deepEqual(attempts, ["chatgpt-backup-1"]);
  assert.equal(released, 1);
});
