import assert from "node:assert/strict";
import test from "node:test";

import { emptyCompletionPreludeMs } from "../src/empty-completion-prelude.mjs";

test("grok-oauth uses a longer empty-completion prelude than other providers", () => {
  const env = {};
  assert.equal(emptyCompletionPreludeMs("kimi-api", env), 30_000);
  assert.equal(emptyCompletionPreludeMs("openai", env), 30_000);
  assert.equal(emptyCompletionPreludeMs("grok-oauth", env), 90_000);
});

test("CODEX_ROUTER_GROK_EMPTY_COMPLETION_PRELUDE_MS overrides the Grok prelude", () => {
  assert.equal(
    emptyCompletionPreludeMs("grok-oauth", {
      CODEX_ROUTER_GROK_EMPTY_COMPLETION_PRELUDE_MS: "120000",
    }),
    120_000,
  );
  assert.equal(
    emptyCompletionPreludeMs("kimi-api", {
      CODEX_ROUTER_GROK_EMPTY_COMPLETION_PRELUDE_MS: "120000",
    }),
    30_000,
  );
});

test("the shared prelude env still applies to non-Grok providers", () => {
  assert.equal(
    emptyCompletionPreludeMs("kimi-api", {
      CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS: "25",
    }),
    25,
  );
  assert.equal(
    emptyCompletionPreludeMs("grok-oauth", {
      CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS: "25",
    }),
    90_000,
  );
});
