import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pickerCommandArgs } from "../src/control-args.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedCatalogRefreshControl(t, catalogModule) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "control-catalog-refresh-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  mkdirSync(path.join(fixtureRoot, "bin"));
  mkdirSync(path.join(fixtureRoot, "src"));
  copyFileSync(path.join(root, "bin", "control"), path.join(fixtureRoot, "bin", "control"));
  chmodSync(path.join(fixtureRoot, "bin", "control"), 0o755);
  copyFileSync(
    path.join(root, "src", "control.mjs"),
    path.join(fixtureRoot, "src", "control.mjs"),
  );
  copyFileSync(
    path.join(root, "src", "control-args.mjs"),
    path.join(fixtureRoot, "src", "control-args.mjs"),
  );
  writeFileSync(path.join(fixtureRoot, "src", "catalog.mjs"), catalogModule);
  return spawnSync(path.join(fixtureRoot, "bin", "control"), ["catalog-refresh"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
}

function probe(target, providers, usageEvents = [], options = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-probe-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  if (usageEvents.length) {
    writeFileSync(
      path.join(stateDir, "usage-events.jsonl"),
      `${usageEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  if (options.nativeModels) {
    writeFileSync(
      path.join(stateDir, "native-models.json"),
      `${JSON.stringify({ models: options.nativeModels })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.selectedModel) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(options.selectedModel)}\n`,
      { mode: 0o600 },
    );
  }
  if (options.loginFree) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(options.selectedModel || "deepseek/deepseek-v4-pro")}\nmodel_provider = "codex-router"\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "codex-provider-mode.json"),
      `${JSON.stringify({
        version: 1,
        previousPresent: false,
        previousModelPresent: false,
      })}\n`,
      { mode: 0o600 },
    );
  }
  try {
    const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--probe"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: stateDir,
        MODEL_ROUTER_TARGET: target,
        MODEL_ROUTER_STATE_DIR: stateDir,
      },
    });
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("codex probe reports enabled models", () => {
  const slice = probe("codex", ["deepseek"]);
  assert.equal(slice.target, "codex");
  const deepseek = slice.models.filter((m) => m.provider === "deepseek");
  assert.ok(deepseek.length > 0 && deepseek.every((m) => m.enabled));
});

test("codex probe folds protocol variants into one provider family", () => {
  const slice = probe("codex", ["opencode-go"]);
  // Models served by the messages/responses variants group under the family
  // id, so the tray renders a single opencode Go row.
  const family = slice.models.filter((m) => m.provider === "opencode-go");
  assert.ok(family.length > 0 && family.every((m) => m.enabled));
  assert.ok(!slice.models.some((m) => m.provider.startsWith("opencode-go-")));
  const providerIds = slice.providers.map((p) => p.id);
  assert.ok(providerIds.includes("opencode-go"));
  assert.ok(!providerIds.some((id) => id.startsWith("opencode-go-")));
});

test("codex probe folds Command Code protocol variants into one provider family", () => {
  const slice = probe("codex", ["commandcode"]);
  const family = slice.models.filter((m) => m.provider === "commandcode");
  assert.ok(family.length > 0 && family.every((m) => m.enabled));
  assert.ok(!slice.models.some((m) => m.provider.startsWith("commandcode-")));
  const providerIds = slice.providers.map((p) => p.id);
  assert.ok(providerIds.includes("commandcode"));
  assert.ok(!providerIds.some((id) => id.startsWith("commandcode-")));
});

test("codex probe exposes only privacy-safe recent usage events", () => {
  const event = {
    at: new Date().toISOString(),
    model: "grok-oauth/grok-4.5",
    provider: "grok-oauth",
    status: 200,
    durationMs: 1234,
    prompt: "must not escape the private event store",
  };
  const slice = probe("codex", ["grok-oauth"], [event]);
  assert.deepEqual(slice.usageEvents, [{
    at: event.at,
    model: event.model,
    provider: event.provider,
    status: event.status,
    durationMs: event.durationMs,
  }]);
  assert.equal("prompt" in slice.usageEvents[0], false);
  assert.equal("response" in slice.usageEvents[0], false);
});

test("codex probe includes native GPT models and the configured default", () => {
  const slice = probe("codex", ["grok-oauth"], [], {
    selectedModel: "gpt-5.6-terra",
    nativeModels: [
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6-Terra",
        visibility: "list",
      },
      {
        slug: "codex-auto-review",
        display_name: "Codex Auto Review",
        visibility: "hide",
      },
    ],
  });

  assert.equal(slice.selectedModel, "gpt-5.6-terra");
  assert.deepEqual(
    slice.models.find((model) => model.slug === "gpt-5.6-terra"),
    {
      slug: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      provider: "openai",
      gatewayModel: "gpt-5.6-terra",
      enabled: true,
      native: true,
      multiAgentVersion: "v1",
      visible: true,
    },
  );
  assert.equal(slice.models.some((model) => model.slug === "codex-auto-review"), false);
  assert.equal(slice.loginFree, false);
  assert.equal(slice.loginFreeManaged, false);
  assert.equal(slice.modelSettings.picker.hidden.length, 0);
  assert.ok(["all", "selected", "proven"].includes(slice.modelSettings.subagents.mode));
});

test("codex probe exposes managed login-free mode without credential details", () => {
  const slice = probe("codex", ["deepseek"], [], { loginFree: true });
  assert.equal(slice.loginFree, true);
  assert.equal(slice.loginFreeManaged, true);
  assert.equal(JSON.stringify(slice).includes("previousModelProvider"), false);
});

test("control exposes subagent and picker settings without credentials", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-settings-"));
  try {
    const env = {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
    };
    const subagents = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "subagents", "status"],
        { cwd: root, encoding: "utf8", env },
      ),
    );
    assert.ok(["all", "selected", "proven"].includes(subagents.mode));
    assert.ok(Array.isArray(subagents.enabled));
    assert.ok(Array.isArray(subagents.disabled));

    const picker = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "picker", "status"],
        { cwd: root, encoding: "utf8", env },
      ),
    );
    assert.deepEqual(picker.hidden, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("picker all accepts the documented show/hide flag position", () => {
  assert.deepEqual(pickerCommandArgs(["picker", "all", "show"]), [
    "all",
    undefined,
    "show",
  ]);
  assert.deepEqual(pickerCommandArgs(["picker", "all", "hide"]), [
    "all",
    undefined,
    "hide",
  ]);
  assert.deepEqual(
    pickerCommandArgs([
      "picker",
      "set",
      "deepseek/deepseek-v4-flash",
      "hide",
    ]),
    ["set", "deepseek/deepseek-v4-flash", "hide"],
  );
});

function probeSet(target, providers, provider, desired) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-set-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "--probe-set", provider, desired],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MODEL_ROUTER_TARGET: target, MODEL_ROUTER_STATE_DIR: stateDir },
      },
    );
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("toggle on adds a provider; toggle off removes it", () => {
  const added = probeSet("codex", ["deepseek"], "grok-oauth", "on");
  assert.deepEqual(added.enabledProviders, ["deepseek", "grok-oauth"]);

  const removed = probeSet("codex", ["grok-oauth", "deepseek"], "deepseek", "off");
  assert.deepEqual(removed.enabledProviders, ["grok-oauth"]);
});

test("toggle rejects an unknown provider", () => {
  assert.throws(() => probeSet("codex", ["deepseek"], "not-a-provider", "on"));
});

test("login-free control selects a ready external model and restores Codex defaults", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-login-free-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          priority: 10,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const runMode = (desired) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "auth-mode", desired],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: stateDir,
            CODEX_BIN: process.execPath,
            MODEL_ROUTER_TARGET: "codex",
            MODEL_ROUTER_STATE_DIR: stateDir,
          },
        },
      ),
    );

  try {
    const enabled = runMode("on");
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.model, "gpt-5.6-sol");
    assert.equal(enabled.model_provider, "codex-router");
    const catalog = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    const aliasEntry = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
    assert.match(aliasEntry.display_name, /DeepSeek/);
    assert.equal(aliasEntry.visibility, "list");
    assert.deepEqual(
      catalog.models
        .filter((model) => model.slug.startsWith("deepseek/"))
        .map((model) => [model.slug, model.visibility]),
      [
        ["deepseek/deepseek-v4-flash", "hide"],
        ["deepseek/deepseek-v4-pro", "list"],
      ],
    );
    const aliases = JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8"));
    assert.deepEqual(aliases, {
      version: 1,
      aliases: { "gpt-5.6-sol": "deepseek/deepseek-v4-flash" },
    });

    const disabled = runMode("off");
    assert.equal(disabled.login_free, false);
    assert.equal(disabled.model, "gpt-5.6-sol");
    assert.equal(disabled.model_provider, "openai");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("login-free aliasing applies even when a ChatGPT credential is still stored", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-login-free-auth-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 10 },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  try {
    const enabled = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "auth-mode", "on"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: stateDir,
            CODEX_BIN: "/usr/bin/true",
            MODEL_ROUTER_TARGET: "codex",
            MODEL_ROUTER_STATE_DIR: stateDir,
          },
        },
      ),
    );
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.model, "gpt-5.6-sol");
    const aliases = JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8"));
    assert.deepEqual(aliases.aliases, { "gpt-5.6-sol": "deepseek/deepseek-v4-flash" });
    const catalog = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    assert.match(
      catalog.models.find((model) => model.slug === "gpt-5.6-sol").display_name,
      /DeepSeek/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("model-set switches the login-free model and rejects unavailable models", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-model-set-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek", "kimi-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          priority: 10,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    CODEX_BIN: process.execPath,
    KIMI_CODE_HOME: path.join(stateDir, "kimi-code"),
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  delete environment.KIMI_API_KEY;
  delete environment.MOONSHOT_API_KEY;
  const runControl = (...commandArgs) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), ...commandArgs],
        { cwd: root, encoding: "utf8", env: environment },
      ),
    );

  try {
    assert.throws(
      () => runControl("model-set", "deepseek/deepseek-v4-flash"),
      /login-free/,
      "model-set must require login-free mode",
    );

    runControl("auth-mode", "on");
    const switched = runControl("model-set", "deepseek/deepseek-v4-flash");
    assert.equal(switched.model, "gpt-5.6-sol");
    assert.equal(switched.model_provider, "codex-router");
    assert.equal(switched.login_free, true);

    const overflow = runControl("model-set", "deepseek/deepseek-v4-pro");
    assert.equal(overflow.model, "deepseek/deepseek-v4-pro");

    assert.throws(
      () => runControl("model-set", "kimi-api/kimi-k3"),
      /enabled, authenticated/,
      "model-set must reject models from unauthenticated providers",
    );
    assert.throws(
      () => runControl("model-set", "gpt-5.6-sol"),
      /enabled, authenticated/,
      "model-set must reject native models",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("aggregate overview covers every target", () => {
  const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const overview = JSON.parse(output);
  assert.deepEqual(Object.keys(overview.targets).sort(), ["codex"]);
});

for (const [status, nativeModels] of [
  ["updated", 9],
  ["unchanged", 8],
  ["skipped", 0],
]) {
  test(`catalog-refresh emits only the narrow ${status} result`, (t) => {
    const result = isolatedCatalogRefreshControl(
      t,
      `export async function refreshNativeCatalog() {
        return ${JSON.stringify({ status, nativeModels, privateDetail: "must-not-escape" })};
      }\n`,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${JSON.stringify({ status, nativeModels })}\n`);
    assert.equal(result.stderr, "");
  });
}

test("catalog-refresh failure exposes fixed operator text and a stable code only", (t) => {
  const result = isolatedCatalogRefreshControl(
    t,
    `export async function refreshNativeCatalog() {
      const error = new Error("RAW_ERROR_MESSAGE_SENTINEL");
      error.code = "CHILD_FAILED";
      error.stdout = "RAW_FIXTURE_STDOUT_SENTINEL";
      error.stderr = "RAW_FIXTURE_STDERR_SENTINEL";
      throw error;
    }\n`,
  );

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Catalog refresh failed; the previous catalog remains active. Reason: CHILD_FAILED.\n",
  );
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /RAW_ERROR_MESSAGE_SENTINEL|RAW_FIXTURE_STDOUT_SENTINEL|RAW_FIXTURE_STDERR_SENTINEL|Error:|at file:/,
  );
});

test("catalog-refresh rejects a negative native-model count with fixed safe output", (t) => {
  const result = isolatedCatalogRefreshControl(
    t,
    `export async function refreshNativeCatalog() {
      return { status: "updated", nativeModels: -1, privateDetail: "RAW_RESULT_SENTINEL" };
    }\n`,
  );

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Catalog refresh failed; the previous catalog remains active. Reason: CATALOG_REFRESH_RESULT_INVALID.\n",
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RAW_RESULT_SENTINEL|Error:|at file:/);
});

// --- quota fallback: status, control commands, doctor visibility ----------
//
// Every case below runs control.mjs as its own subprocess with an isolated,
// single-provider Kimi registry (no keychain services, no CLI session) and a
// scrubbed environment, so no test can ever discover or exercise a real Kimi
// credential on this machine.

function isolatedKimiRegistry(stateDir, { includeKimi = true } = {}) {
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
    `${JSON.stringify({
      version: 1,
      providers: includeKimi ? [provider] : [],
      models: includeKimi ? modelDocument.models : [],
    })}\n`,
    { mode: 0o600 },
  );
  return registryPath;
}

function quotaControl(stateDir, ...command) {
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_REGISTRY: isolatedKimiRegistry(stateDir),
  };
  for (const name of [
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "MODEL_ROUTER_SHOW_ALL_MODELS",
    "CODEX_ROUTER_SHOW_ALL_MODELS",
  ]) {
    delete environment[name];
  }
  return spawnSync(process.execPath, [path.join(root, "src", "control.mjs"), ...command], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
}

function readyKimiState(t, { configuredModel } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-quota-ready-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["kimi-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "kimi-api-key.secret"), "TEST_KIMI_KEY\n", {
    mode: 0o600,
  });
  if (configuredModel) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(configuredModel)}\n`,
      { mode: 0o600 },
    );
  }
  return stateDir;
}

test("quota fallback set fails closed until Kimi is selected and credential-ready", (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-quota-not-ready-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const result = quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Enable kimi-api|API key/);
  assert.equal(existsSync(path.join(stateDir, "quota-fallback.json")), false);
});

test("quota fallback status and probe expose only the safe optional snapshot", (t) => {
  const stateDir = readyKimiState(t);
  assert.equal(quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3").status, 0);
  const status = JSON.parse(quotaControl(stateDir, "quota-fallback", "status", "--json").stdout);
  const probe = JSON.parse(quotaControl(stateDir, "--probe").stdout);
  assert.equal(status.readiness, "ready");
  assert.deepEqual(probe.modelSettings.quotaFallback, status);
  assert.doesNotMatch(JSON.stringify(status), /path|source|secret|TEST_KIMI_KEY/i);
});

test("quota fallback off leaves Kimi selected and the configured Codex model unchanged", (t) => {
  const stateDir = readyKimiState(t, { configuredModel: "gpt-5.6-sol" });
  const selectionBefore = readFileSync(path.join(stateDir, "enabled-providers.json"), "utf8");
  const configBefore = readFileSync(path.join(stateDir, "config.toml"), "utf8");
  assert.equal(quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3").status, 0);
  assert.equal(quotaControl(stateDir, "quota-fallback", "off").status, 0);
  assert.equal(readFileSync(path.join(stateDir, "enabled-providers.json"), "utf8"), selectionBefore);
  assert.equal(readFileSync(path.join(stateDir, "config.toml"), "utf8"), configBefore);
});

test("quota fallback status human output names on/off, target, readiness, and last outcome", (t) => {
  const stateDir = readyKimiState(t);
  assert.equal(quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3").status, 0);
  const human = quotaControl(stateDir, "quota-fallback", "status");
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Quota fallback: on; target kimi-api\/kimi-k3; readiness ready/);
  assert.match(human.stdout, /last outcome none/);
});

test("quota fallback rejects unknown subcommands and malformed set targets", (t) => {
  const stateDir = readyKimiState(t);
  const usage = /Usage: control quota-fallback status \[--json\]\|set kimi-api\/kimi-k3\|off/;
  assert.match(quotaControl(stateDir, "quota-fallback", "bogus").stderr, usage);
  assert.match(quotaControl(stateDir, "quota-fallback", "set", "not-kimi/model").stderr, usage);
  assert.match(quotaControl(stateDir, "quota-fallback", "set").stderr, usage);
  assert.match(quotaControl(stateDir, "quota-fallback", "status", "--json", "extra").stderr, usage);
});

test("quota fallback reports target-not-registered against a registry that omits Kimi", (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-quota-no-target-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_REGISTRY: isolatedKimiRegistry(stateDir, { includeKimi: false }),
  };
  for (const name of ["KIMI_API_KEY", "MOONSHOT_API_KEY"]) delete environment[name];
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "control.mjs"), "quota-fallback", "status", "--json"],
    { cwd: root, encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.readiness, "target-not-registered");
  assert.equal(status.providerReady, false);
});

test("quota fallback doctor row reflects readiness without ever touching a real credential", (t) => {
  const stateDir = readyKimiState(t);
  assert.equal(quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3").status, 0);
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_REGISTRY: isolatedKimiRegistry(stateDir),
  };
  for (const name of ["KIMI_API_KEY", "MOONSHOT_API_KEY"]) delete environment[name];
  const doctor = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout: 120_000,
  });
  // Unrelated checks (native Codex config, other providers) can fail in this
  // isolated state dir; only the Quota fallback row itself is under test.
  const parsed = JSON.parse(doctor.stdout);
  const check = parsed.checks.find((item) => item.name === "Quota fallback");
  assert.ok(check, "doctor must report a Quota fallback row");
  assert.equal(check.status, "ok");
  assert.match(check.detail, /enabled; Kimi K3 ready/);
});
