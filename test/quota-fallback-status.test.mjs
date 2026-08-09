import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This whole file runs as one Node process, so MODEL_ROUTER_REGISTRY and
// MODEL_ROUTER_STATE_DIR (like every other path in paths.mjs / model-registry.mjs)
// resolve once at first import. A single isolated Kimi-only registry -- with no
// keychain services and no CLI session -- covers every case this file needs
// (ready, provider-not-selected, credential-missing) without ever risking a
// real credential on this machine. target-not-registered needs a *different*
// registry and is covered separately, as a subprocess, in control.test.mjs.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "quota-fallback-status-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
for (const name of [
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MODEL_ROUTER_SHOW_ALL_MODELS",
  "CODEX_ROUTER_SHOW_ALL_MODELS",
]) {
  delete process.env[name];
}

function isolatedKimiRegistryPath() {
  const providerDocument = JSON.parse(
    readFileSync(path.join(root, "config", "kimi", "kimi.json"), "utf8"),
  );
  const modelDocument = JSON.parse(
    readFileSync(path.join(root, "config", "kimi", "api", "kimi-k3.json"), "utf8"),
  );
  const provider = structuredClone(
    providerDocument.providers.find((item) => item.id === "kimi-api"),
  );
  provider.credential.keychainServices = [];
  delete provider.credential.cliSession;
  const registryPath = path.join(stateDir, "isolated-kimi-registry.json");
  writeFileSync(
    registryPath,
    `${JSON.stringify({ version: 1, providers: [provider], models: modelDocument.models })}\n`,
    { mode: 0o600 },
  );
  return registryPath;
}
process.env.MODEL_ROUTER_REGISTRY = isolatedKimiRegistryPath();

const { quotaFallbackDoctorCheck, quotaFallbackStatus } = await import(
  "../src/quota-fallback-status.mjs"
);
const { disableQuotaFallback, setQuotaFallback } = await import("../src/quota-fallback-state.mjs");
const { clearNativeRedirect, setNativeRedirect } = await import("../src/native-redirect.mjs");
const { PROVIDER_SELECTION_PATH } = await import("../src/paths.mjs");
const { recordQuotaFallbackEvent, USAGE_EVENTS_PATH } = await import("../src/usage-events.mjs");

const CREDENTIAL_PATH = path.join(stateDir, "kimi-api-key.secret");

function selectProviders(providers) {
  writeFileSync(
    PROVIDER_SELECTION_PATH,
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
}

function writeCredential() {
  writeFileSync(CREDENTIAL_PATH, "TEST_KIMI_KEY_DO_NOT_LEAK\n", { mode: 0o600 });
}

function reset() {
  disableQuotaFallback();
  selectProviders([]);
  rmSync(CREDENTIAL_PATH, { force: true });
  clearNativeRedirect();
  rmSync(USAGE_EVENTS_PATH, { force: true });
}

test("quota fallback status pins the exact safe shape when nothing is configured", () => {
  reset();
  assert.deepEqual(quotaFallbackStatus(), {
    enabled: false,
    model: "kimi-api/kimi-k3",
    providerReady: false,
    readiness: "provider-not-selected",
    readinessHint: "Enable kimi-api. Regional endpoints use KIMI_API_BASE_URL.",
    nativeRedirectPrecedence: false,
    lastOutcome: null,
  });
});

test("quota fallback status resolves to credential-missing once the provider is selected", () => {
  reset();
  selectProviders(["kimi-api"]);
  const status = quotaFallbackStatus();
  assert.equal(status.readiness, "credential-missing");
  assert.equal(status.providerReady, false);
  assert.match(status.readinessHint, /provider-key kimi-api set/);
});

test("quota fallback status resolves to ready once the provider is selected and credentialed", () => {
  reset();
  selectProviders(["kimi-api"]);
  writeCredential();
  const status = quotaFallbackStatus();
  assert.equal(status.readiness, "ready");
  assert.equal(status.providerReady, true);
  assert.equal(status.readinessHint, null);
});

test("a configured native redirect sets nativeRedirectPrecedence without changing readiness", () => {
  reset();
  selectProviders(["kimi-api"]);
  writeCredential();
  setNativeRedirect("some-other-routed/model");
  const status = quotaFallbackStatus();
  assert.equal(status.nativeRedirectPrecedence, true);
  assert.equal(status.readiness, "ready");
  clearNativeRedirect();
  assert.equal(quotaFallbackStatus().nativeRedirectPrecedence, false);
});

test("quota fallback status narrows lastOutcome to at, outcome, and optional status only", () => {
  reset();
  recordQuotaFallbackEvent({
    nativeProvider: "openai",
    nativeModel: "gpt-5.6-sol",
    fallbackProvider: "kimi-api",
    fallbackModel: "kimi-api/kimi-k3",
    errorClass: "quota",
    outcome: "succeeded",
    status: 200,
    durationMs: 12,
    prompt: "must-not-appear",
    bodyText: "must-not-appear",
  });
  const status = quotaFallbackStatus();
  assert.ok(status.lastOutcome);
  assert.deepEqual(Object.keys(status.lastOutcome).sort(), ["at", "outcome", "status"]);
  assert.equal(status.lastOutcome.outcome, "succeeded");
  assert.equal(status.lastOutcome.status, 200);

  recordQuotaFallbackEvent({
    nativeProvider: "openai",
    nativeModel: "gpt-5.6-sol",
    fallbackProvider: "kimi-api",
    fallbackModel: "kimi-api/kimi-k3",
    errorClass: "quota",
    outcome: "skipped-cooldown",
    durationMs: 1,
  });
  const withoutStatus = quotaFallbackStatus().lastOutcome;
  assert.deepEqual(Object.keys(withoutStatus).sort(), ["at", "outcome"]);
});

test("quota fallback status never leaks paths, sources, secrets, or the endpoint override value", () => {
  reset();
  selectProviders(["kimi-api"]);
  writeCredential();
  process.env.KIMI_API_BASE_URL = "https://leaked-override.example/v1";
  try {
    const ready = quotaFallbackStatus();
    const serialized = JSON.stringify(ready);
    assert.equal(ready.readiness, "ready");
    assert.doesNotMatch(serialized, /TEST_KIMI_KEY_DO_NOT_LEAK/);
    assert.doesNotMatch(serialized, /leaked-override\.example/);
    assert.doesNotMatch(serialized, /"path"|"source"|"secret"|"prompt"/i);

    // A hint may name the variable, but never echo the leaked value it holds.
    selectProviders([]);
    const notSelected = quotaFallbackStatus();
    assert.equal(notSelected.readiness, "provider-not-selected");
    assert.match(notSelected.readinessHint, /KIMI_API_BASE_URL/);
    assert.doesNotMatch(notSelected.readinessHint, /leaked-override\.example/);
  } finally {
    delete process.env.KIMI_API_BASE_URL;
  }
});

test("quota fallback off is doctor ok", () => {
  reset();
  const check = quotaFallbackDoctorCheck();
  assert.deepEqual(check, {
    status: "ok",
    name: "Quota fallback",
    detail: "off",
    fix: "Run ./bin/control quota-fallback set kimi-api/kimi-k3 after Kimi is ready.",
  });
});

test("quota fallback enabled and ready is doctor ok", () => {
  reset();
  selectProviders(["kimi-api"]);
  writeCredential();
  setQuotaFallback("kimi-api/kimi-k3");
  const check = quotaFallbackDoctorCheck();
  assert.equal(check.status, "ok");
  assert.equal(check.name, "Quota fallback");
  assert.match(check.detail, /enabled; Kimi K3 ready/);
});

test("quota fallback enabled but unready is doctor warn with a concrete fix", () => {
  reset();
  selectProviders(["kimi-api"]);
  writeCredential();
  setQuotaFallback("kimi-api/kimi-k3");
  rmSync(CREDENTIAL_PATH, { force: true });
  const check = quotaFallbackDoctorCheck();
  assert.equal(check.status, "warn");
  assert.match(check.detail, /credential-missing/);
  assert.match(check.fix, /provider-key kimi-api set/);
});

test("native redirect precedence is noted in the doctor detail only while enabled", () => {
  reset();
  selectProviders(["kimi-api"]);
  writeCredential();
  setQuotaFallback("kimi-api/kimi-k3");
  setNativeRedirect("some-other-routed/model");
  const check = quotaFallbackDoctorCheck();
  assert.match(check.detail, /native redirect takes precedence/);
  clearNativeRedirect();
  reset();
});
