import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "quota-fallback-state-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  QUOTA_FALLBACK_MODEL,
  QUOTA_FALLBACK_STATE_PATH,
  disableQuotaFallback,
  readQuotaFallbackSettings,
  setQuotaFallback,
} = await import("../src/quota-fallback-state.mjs");

test("quota fallback defaults to disabled with the fixed Kimi target", () => {
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
  assert.equal(QUOTA_FALLBACK_MODEL, "kimi-api/kimi-k3");
});

test("quota fallback round-trips through protected atomic state", () => {
  assert.deepEqual(setQuotaFallback("kimi-api/kimi-k3"), {
    version: 1,
    enabled: true,
    model: "kimi-api/kimi-k3",
  });
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: true,
    model: "kimi-api/kimi-k3",
  });
  assert.equal(privateFileIsProtected(QUOTA_FALLBACK_STATE_PATH), true);
  // Windows protects private files with ACLs, not POSIX modes.
  if (process.platform !== "win32") {
    assert.equal(statSync(QUOTA_FALLBACK_STATE_PATH).mode & 0o777, 0o600);
  }
  assert.deepEqual(disableQuotaFallback(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
});

test("quota fallback rejects every target except Kimi K3 API", () => {
  for (const slug of ["", "gpt-5.6-sol", "kimi-oauth/k3", "deepseek/deepseek-v4-pro"]) {
    assert.throws(() => setQuotaFallback(slug), /kimi-api\/kimi-k3/);
  }
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
});

test("a state file naming any target except the fixed Kimi slug fails closed", () => {
  writeFileSync(
    QUOTA_FALLBACK_STATE_PATH,
    JSON.stringify({ version: 1, enabled: true, model: "removed/model" }),
    { mode: 0o600 },
  );
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
});

test("quota fallback state ignores absent, corrupt, wrong-version, or non-boolean state", () => {
  writeFileSync(QUOTA_FALLBACK_STATE_PATH, "{ not json", "utf8");
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });

  writeFileSync(
    QUOTA_FALLBACK_STATE_PATH,
    JSON.stringify({ version: 2, enabled: true, model: "kimi-api/kimi-k3" }),
    "utf8",
  );
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });

  writeFileSync(
    QUOTA_FALLBACK_STATE_PATH,
    JSON.stringify({ version: 1, enabled: "yes", model: "kimi-api/kimi-k3" }),
    "utf8",
  );
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });

  disableQuotaFallback();
});
