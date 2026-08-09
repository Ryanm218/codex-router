import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cloneNativePayloadForFallback,
  createFallbackFailureGuard,
  nativeFallbackPortability,
} from "../src/native-fallback-policy.mjs";

const portablePayload = {
  model: "gpt-5.6-sol",
  previous_response_id: "resp_native",
  client_metadata: { workspace: "private" },
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
};

test("native fallback accepts a complete ordinary Responses replay", () => {
  assert.deepEqual(
    nativeFallbackPortability({ pathname: "/responses", payload: portablePayload }),
    { ok: true },
  );
  assert.deepEqual(
    nativeFallbackPortability({ pathname: "/v1/responses", payload: portablePayload }),
    { ok: true },
  );
});

test("native fallback accepts a router-owned, decodable compaction summary", () => {
  const payload = {
    ...portablePayload,
    input: [
      { type: "compaction", encrypted_content: `kcr1:${Buffer.from("earlier summary").toString("base64")}` },
      ...portablePayload.input,
    ],
  };
  assert.deepEqual(nativeFallbackPortability({ pathname: "/responses", payload }), { ok: true });
});

test("native fallback rejects compact, missing replay, and opaque native state", () => {
  const cases = [
    { pathname: "/responses/compact", payload: portablePayload, reason: "unsupported-endpoint" },
    { pathname: "/chat/completions", payload: portablePayload, reason: "unsupported-endpoint" },
    { pathname: "/responses", payload: { model: "gpt-5.6-sol", input: "first turn" }, reason: "missing-replay" },
    { pathname: "/responses", payload: { model: "gpt-5.6-sol" }, reason: "missing-replay" },
    {
      pathname: "/responses",
      payload: { ...portablePayload, input: [{ type: "compaction_trigger" }] },
      reason: "compaction-state",
    },
    {
      pathname: "/responses",
      payload: {
        ...portablePayload,
        input: [{ type: "compaction", encrypted_content: "opaque-openai-native-format" }],
      },
      reason: "compaction-state",
    },
    {
      pathname: "/responses",
      payload: { ...portablePayload, input: [{ type: "reasoning", encrypted_content: "gAAAAAopaque=" }] },
      reason: "opaque-native-state",
    },
    {
      pathname: "/responses",
      payload: {
        ...portablePayload,
        input: [{ type: "reasoning", encrypted_content: "genuine-openai-encrypted-content" }],
      },
      reason: "opaque-native-state",
    },
  ];
  for (const item of cases) {
    assert.deepEqual(
      nativeFallbackPortability(item),
      { ok: false, reason: item.reason },
      `unexpected result for ${item.pathname} / ${JSON.stringify(item.payload).slice(0, 80)}`,
    );
  }
});

test("native fallback recursively rejects Fernet-shaped agent state anywhere in the payload", () => {
  const payload = {
    ...portablePayload,
    input: [
      ...portablePayload.input,
      {
        type: "agent_message",
        content: [{ type: "encrypted_content", encrypted_content: "gAAAAABleZ9x_-Abc123==" }],
      },
    ],
  };
  assert.deepEqual(nativeFallbackPortability({ pathname: "/responses", payload }), {
    ok: false,
    reason: "opaque-native-state",
  });
});

test("fallback clone strips OpenAI continuation fields without mutating native input", () => {
  const clone = cloneNativePayloadForFallback(portablePayload);
  assert.equal(clone.previous_response_id, undefined);
  assert.equal(clone.client_metadata, undefined);
  assert.deepEqual(clone.input, portablePayload.input);
  clone.input[0].role = "assistant";
  assert.equal(portablePayload.input[0].role, "user");
  // The original payload itself must never be mutated.
  assert.equal(portablePayload.previous_response_id, "resp_native");
  assert.equal(portablePayload.client_metadata.workspace, "private");
});

test("fallback failure guard blocks a repeat within 30s and opens exactly at expiry", () => {
  let clock = 0;
  const guard = createFallbackFailureGuard({ guardMs: 30_000, now: () => clock, maxEntries: 256 });
  const key = guard.keyFor({ decodedBody: Buffer.from("same request"), pathname: "/responses", nativeModel: "gpt-5.6-sol" });

  assert.equal(guard.isBlocked(key), false);
  guard.recordFailure(key);
  assert.equal(guard.isBlocked(key), true);

  clock = 29_999;
  assert.equal(guard.isBlocked(key), true);

  clock = 30_000;
  assert.equal(guard.isBlocked(key), false);
});

test("fallback failure guard keys on the exact request bytes, route, and native model", () => {
  let clock = 0;
  const guard = createFallbackFailureGuard({ guardMs: 30_000, now: () => clock, maxEntries: 256 });
  const keyA = guard.keyFor({ decodedBody: Buffer.from("request A"), pathname: "/responses", nativeModel: "gpt-5.6-sol" });
  const keyB = guard.keyFor({ decodedBody: Buffer.from("request B"), pathname: "/responses", nativeModel: "gpt-5.6-sol" });

  guard.recordFailure(keyA);
  assert.equal(guard.isBlocked(keyA), true);
  assert.equal(guard.isBlocked(keyB), false);
});

test("fallback failure guard clears on success and prunes beyond its entry cap", () => {
  let clock = 0;
  const guard = createFallbackFailureGuard({ guardMs: 30_000, now: () => clock, maxEntries: 4 });
  const keys = Array.from({ length: 6 }, (_, index) =>
    guard.keyFor({ decodedBody: Buffer.from(`request ${index}`), pathname: "/responses", nativeModel: "gpt-5.6-sol" }),
  );

  for (const key of keys) guard.recordFailure(key);

  // Oldest two of six must have been pruned once the cap of four was exceeded.
  assert.equal(guard.isBlocked(keys[0]), false);
  assert.equal(guard.isBlocked(keys[1]), false);
  assert.equal(guard.isBlocked(keys[2]), true);
  assert.equal(guard.isBlocked(keys[5]), true);

  guard.clear(keys[5]);
  assert.equal(guard.isBlocked(keys[5]), false);
});
