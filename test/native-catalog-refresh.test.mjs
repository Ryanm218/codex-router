import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireNativeCatalog } from "../src/native-catalog-refresh.mjs";

const CLIENT_VERSION = "codex-cli 0.153.3";
const CACHE_CLIENT_VERSION = "0.153.3";

function listedModel(slug = "gpt-5.6") {
  return {
    slug,
    display_name: "GPT-5.6",
    description: "Native model",
    priority: 10,
    visibility: "list",
    base_instructions: "You are Codex.",
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
  };
}

function writeCache(
  home,
  models,
  fetchedAt = new Date().toISOString(),
  version = CACHE_CLIENT_VERSION,
) {
  const cachePath = path.join(home, "models_cache.json");
  writeFileSync(
    cachePath,
    JSON.stringify({ client_version: version, fetched_at: fetchedAt, models }),
    { mode: 0o644 },
  );
  chmodSync(cachePath, 0o644);
}

function createHarness(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-catalog-refresh-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const authDir = path.join(root, ".codex");
  const authPath = path.join(authDir, "auth.json");
  const codexBinary = path.join(root, "Codex.app", "Contents", "Resources", "codex");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(codexBinary), { recursive: true });
  writeFileSync(authPath, "fixture credential bytes", { mode: 0o600 });
  writeFileSync(codexBinary, "#!/bin/sh\nexit 99\n", { mode: 0o755 });

  const model = listedModel();
  let calls = 0;
  const runner = overrides.runner ?? ((command, args, options) => {
    void command;
    calls += 1;
    if (args.length === 1 && args[0] === "--version") {
      return { status: 0, stdout: `${CLIENT_VERSION}\n`, stderr: "" };
    }
    writeCache(options.env.CODEX_HOME, [{ slug: model.slug }]);
    return { status: 0, stdout: JSON.stringify({ models: [model] }), stderr: "" };
  });
  const options = {
    authPath,
    stateDir,
    codexBinary,
    uid: process.geteuid(),
    now: Date.now,
    env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      TMPDIR: os.tmpdir(),
      LANG: "en_GB.UTF-8",
      LC_ALL: "C",
      TZ: "Europe/London",
      OPENAI_API_KEY: "must-not-pass",
      OPENAI_BASE_URL: "https://must-not-pass.invalid",
      HTTPS_PROXY: "https://must-not-pass.invalid",
      ALL_PROXY: "socks://must-not-pass.invalid",
      ANTHROPIC_API_KEY: "must-not-pass",
      CODEX_ROUTER_BASE_URL: "https://must-not-pass.invalid",
    },
    runner,
    routedSlugs: new Set(),
    ...overrides,
  };
  return { root, stateDir, authDir, authPath, codexBinary, model, options, calls: () => calls };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function setRunner(harness, {
  versionStatus = 0,
  versionStderr = "",
  versionStdout = `${CLIENT_VERSION}\n`,
  status = 0,
  stderr = "",
  stdout = { models: [harness.model] },
  cache = { models: [{ slug: harness.model.slug }] },
  cacheMode = 0o644,
  cacheMtime,
  mutate,
} = {}) {
  harness.options.runner = (command, args, options) => {
    void command;
    if (args.length === 1 && args[0] === "--version") {
      return { status: versionStatus, stderr: versionStderr, stdout: versionStdout };
    }
    if (cache !== null) {
      const value = {
        client_version: CACHE_CLIENT_VERSION,
        fetched_at: new Date().toISOString(),
        ...cache,
      };
      const cachePath = path.join(options.env.CODEX_HOME, "models_cache.json");
      writeFileSync(cachePath, JSON.stringify(value), {
        mode: cacheMode,
      });
      chmodSync(cachePath, cacheMode);
      if (cacheMtime !== undefined) {
        const instant = new Date(cacheMtime);
        utimesSync(path.join(options.env.CODEX_HOME, "models_cache.json"), instant, instant);
      }
    }
    mutate?.(options.env.CODEX_HOME);
    return {
      status,
      stderr,
      stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    };
  };
}

test("missing auth skips before spawning", (t) => {
  const harness = createHarness(t);
  unlinkSync(harness.authPath);

  assert.deepEqual(acquireNativeCatalog(harness.options), {
    status: "skipped",
    reason: "signed-out",
  });
  assert.equal(harness.calls(), 0);
});

test("an auth-file symlink is rejected before spawning", (t) => {
  const harness = createHarness(t);
  const target = path.join(harness.root, "credential-target.json");
  writeFileSync(target, "fixture", { mode: 0o600 });
  unlinkSync(harness.authPath);
  symlinkSync(target, harness.authPath);

  expectCode(() => acquireNativeCatalog(harness.options), "AUTH_NOT_REGULAR");
  assert.equal(harness.calls(), 0);
});

test("wrong auth mode is rejected before spawning", (t) => {
  const harness = createHarness(t);
  chmodSync(harness.authPath, 0o640);

  expectCode(() => acquireNativeCatalog(harness.options), "AUTH_MODE_INVALID");
  assert.equal(harness.calls(), 0);
});

test("wrong auth owner is rejected before spawning", (t) => {
  const harness = createHarness(t, { uid: process.geteuid() + 1 });

  expectCode(() => acquireNativeCatalog(harness.options), "AUTH_OWNER_MISMATCH");
  assert.equal(harness.calls(), 0);
});

test("an auth path replaced during metadata admission is rejected before spawning", (t) => {
  const harness = createHarness(t);
  const realpathSync = (value) => {
    if (value === harness.authPath) return path.join(harness.root, "replacement-auth.json");
    return path.resolve(value);
  };

  expectCode(
    () => acquireNativeCatalog({ ...harness.options, fileSystem: { realpathSync } }),
    "AUTH_PATH_CHANGED",
  );
  assert.equal(harness.calls(), 0);
});

test("runner resolves the normalized version and catalog through the explicit binary and allowlisted env", (t) => {
  const invocations = [];
  const fetchedAt = new Date().toISOString();
  const harness = createHarness(t, {
    runner(command, args, options) {
      invocations.push({ command, args, options });
      const homeMetadata = lstatSync(options.env.CODEX_HOME);
      assert.equal(homeMetadata.mode & 0o777, 0o700);
      assert.equal(homeMetadata.uid, process.geteuid());
      assert.equal(lstatSync(path.join(options.env.CODEX_HOME, "auth.json")).isSymbolicLink(), true);
      assert.equal(readlinkSync(path.join(options.env.CODEX_HOME, "auth.json")), harness.authPath);
      assert.equal(lstatSync(path.join(options.env.CODEX_HOME, "config.toml"), { throwIfNoEntry: false }), undefined);
      if (args.length === 1 && args[0] === "--version") {
        return { status: 0, stdout: `  ${CLIENT_VERSION}\r\n`, stderr: "" };
      }
      writeCache(options.env.CODEX_HOME, [{ slug: harness.model.slug }], fetchedAt);
      return {
        status: 0,
        stdout: JSON.stringify({ models: [harness.model] }),
        stderr: "",
      };
    },
  });

  const result = acquireNativeCatalog(harness.options);

  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations.map(({ command }) => command), [
    harness.codexBinary,
    harness.codexBinary,
  ]);
  assert.deepEqual(invocations.map(({ args }) => args), [
    ["--version"],
    [
      "-c",
      'cli_auth_credentials_store="file"',
      "debug",
      "models",
    ],
  ]);
  assert.deepEqual(invocations.map(({ options }) => options.timeout), [10_000, 30_000]);
  assert.deepEqual(invocations[0].options.env, invocations[1].options.env);
  for (const invocation of invocations) {
    assert.equal(invocation.options.cwd, invocation.options.env.CODEX_HOME);
    assert.deepEqual(
      Object.keys(invocation.options.env).sort(),
      ["CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"].sort(),
    );
    for (const forbidden of [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "ANTHROPIC_API_KEY",
      "CODEX_ROUTER_BASE_URL",
    ]) {
      assert.equal(invocation.options.env[forbidden], undefined);
    }
  }
  assert.deepEqual(result, {
    status: "acquired",
    candidate: { models: [harness.model] },
    attestation: { fetchedAt },
    clientVersion: CLIENT_VERSION,
  });
});

for (const [name, versionResult, code] of [
  [
    "a failed version invocation",
    { versionStatus: 23, versionStdout: "RAW_VERSION_SECRET_SENTINEL" },
    "VERSION_FAILED",
  ],
  [
    "version stderr",
    { versionStderr: "RAW_VERSION_SECRET_SENTINEL" },
    "VERSION_STDERR",
  ],
  [
    "an empty normalized version",
    { versionStdout: " \r\n" },
    "VERSION_INVALID",
  ],
  [
    "a bare cache version without the CLI product prefix",
    { versionStdout: `${CACHE_CLIENT_VERSION}\n` },
    "VERSION_INVALID",
  ],
  [
    "an unrecognized CLI version",
    { versionStdout: "codex-cli rolling\n" },
    "VERSION_INVALID",
  ],
  [
    "a malformed semantic CLI version",
    { versionStdout: "codex-cli 01.153.3\n" },
    "VERSION_INVALID",
  ],
]) {
  test(`${name} is rejected before catalog acquisition with a stable code`, (t) => {
    const harness = createHarness(t);
    let invocations = 0;
    setRunner(harness, versionResult);
    const runner = harness.options.runner;
    harness.options.runner = (...args) => {
      invocations += 1;
      return runner(...args);
    };

    assert.throws(
      () => acquireNativeCatalog(harness.options),
      (error) =>
        error?.code === code &&
        !error.message.includes("RAW_VERSION_SECRET_SENTINEL"),
    );
    assert.equal(invocations, 1);
  });
}

test("child failures expose only a stable code", (t) => {
  const harness = createHarness(t);
  setRunner(harness, {
    status: 23,
    stderr: "RAW_CHILD_SECRET_SENTINEL",
    stdout: "RAW_CHILD_SECRET_SENTINEL",
    cache: null,
  });

  assert.throws(
    () => acquireNativeCatalog(harness.options),
    (error) =>
      error?.code === "CHILD_FAILED" &&
      !error.message.includes("RAW_CHILD_SECRET_SENTINEL"),
  );
});

test("a runner exception exposes only a stable code", (t) => {
  const harness = createHarness(t);
  harness.options.runner = (command, args) => {
    void command;
    if (args.length === 1 && args[0] === "--version") {
      return { status: 0, stdout: `${CLIENT_VERSION}\n`, stderr: "" };
    }
    throw new Error("RAW_RUNNER_SECRET_SENTINEL");
  };

  assert.throws(
    () => acquireNativeCatalog(harness.options),
    (error) =>
      error?.code === "CHILD_FAILED" &&
      !error.message.includes("RAW_RUNNER_SECRET_SENTINEL"),
  );
});

test("non-empty child stderr is rejected without rendering it", (t) => {
  const harness = createHarness(t);
  setRunner(harness, { stderr: "RAW_STDERR_SECRET_SENTINEL" });

  assert.throws(
    () => acquireNativeCatalog(harness.options),
    (error) =>
      error?.code === "CHILD_STDERR" &&
      !error.message.includes("RAW_STDERR_SECRET_SENTINEL"),
  );
});

for (const [name, stdout] of [
  ["invalid JSON stdout", "RAW_INVALID_JSON_SENTINEL"],
  ["empty stdout catalog", { models: [] }],
]) {
  test(`${name} is rejected with a stable code`, (t) => {
    const harness = createHarness(t);
    setRunner(harness, { stdout });

    assert.throws(
      () => acquireNativeCatalog(harness.options),
      (error) =>
        error?.code === "STDOUT_INVALID" &&
        !error.message.includes("RAW_INVALID_JSON_SENTINEL"),
    );
  });
}

test("an absent cache attestation is rejected", (t) => {
  const harness = createHarness(t);
  setRunner(harness, { cache: null });

  expectCode(() => acquireNativeCatalog(harness.options), "CACHE_MISSING");
});

test("a non-regular cache attestation is rejected", (t) => {
  const harness = createHarness(t);
  setRunner(harness, {
    cache: null,
    mutate(home) {
      mkdirSync(path.join(home, "models_cache.json"));
    },
  });

  expectCode(() => acquireNativeCatalog(harness.options), "CACHE_NOT_REGULAR");
});

for (const cacheMode of [0o600, 0o640, 0o644]) {
  test(`a ${cacheMode.toString(8)} cache without group/world write bits is admitted`, (t) => {
    const harness = createHarness(t);
    setRunner(harness, { cacheMode });

    assert.equal(acquireNativeCatalog(harness.options).status, "acquired");
  });
}

for (const cacheMode of [0o620, 0o602, 0o666]) {
  test(`a ${cacheMode.toString(8)} group/world-writable cache is rejected`, (t) => {
    const harness = createHarness(t);
    setRunner(harness, { cacheMode });

    expectCode(() => acquireNativeCatalog(harness.options), "CACHE_MODE_INVALID");
  });
}

test("a cache file not created during the invocation is rejected", (t) => {
  const harness = createHarness(t);
  setRunner(harness, { cacheMtime: Date.now() - 60_000 });

  expectCode(() => acquireNativeCatalog(harness.options), "CACHE_FILE_STALE");
});

test("a stale fetched_at attestation is rejected", (t) => {
  const harness = createHarness(t);
  setRunner(harness, {
    cache: {
      fetched_at: new Date(Date.now() - 60_000).toISOString(),
      models: [{ slug: harness.model.slug }],
    },
  });

  expectCode(() => acquireNativeCatalog(harness.options), "CACHE_FETCH_STALE");
});

test("a cache from a different exact normalized client version is rejected", (t) => {
  const harness = createHarness(t);
  setRunner(harness, {
    cache: { client_version: "0.153.2", models: [{ slug: harness.model.slug }] },
  });

  expectCode(() => acquireNativeCatalog(harness.options), "CACHE_VERSION_MISMATCH");
});

for (const [name, stdoutModels, cacheModels, code] of [
  ["empty stdout slug", [{ ...listedModel(), slug: "" }], [{ slug: "" }], "CATALOG_SLUG_INVALID"],
  [
    "duplicate stdout slug",
    [listedModel(), listedModel()],
    [{ slug: "gpt-5.6" }],
    "CATALOG_SLUG_DUPLICATE",
  ],
  [
    "duplicate cache slug",
    [listedModel()],
    [{ slug: "gpt-5.6" }, { slug: "gpt-5.6" }],
    "CACHE_SLUG_DUPLICATE",
  ],
  [
    "stdout/cache slug mismatch",
    [listedModel()],
    [{ slug: "gpt-5.7" }],
    "CATALOG_SLUG_MISMATCH",
  ],
]) {
  test(`${name} is rejected`, (t) => {
    const harness = createHarness(t);
    setRunner(harness, {
      stdout: { models: stdoutModels },
      cache: { models: cacheModels },
    });

    expectCode(() => acquireNativeCatalog(harness.options), code);
  });
}

test("a native slug colliding with a routed slug is rejected", (t) => {
  const harness = createHarness(t);
  harness.options.routedSlugs = new Set([harness.model.slug]);

  expectCode(() => acquireNativeCatalog(harness.options), "CATALOG_ROUTE_COLLISION");
});

for (const [field, value] of [
  ["base_instructions", ""],
  ["display_name", ""],
  ["priority", 1.5],
  ["visibility", ""],
]) {
  test(`a listed model missing valid ${field} is rejected`, (t) => {
    const harness = createHarness(t);
    setRunner(harness, { stdout: { models: [{ ...harness.model, [field]: value }] } });

    expectCode(() => acquireNativeCatalog(harness.options), "CATALOG_MODEL_INVALID");
  });
}

for (const reasoningChange of [
  { supported_reasoning_levels: [] },
  { supported_reasoning_levels: [{ effort: "high", description: "" }] },
  { default_reasoning_level: "max" },
]) {
  test("an invalid listed-model reasoning structure is rejected", (t) => {
    const harness = createHarness(t);
    setRunner(harness, { stdout: { models: [{ ...harness.model, ...reasoningChange }] } });

    expectCode(() => acquireNativeCatalog(harness.options), "CATALOG_REASONING_INVALID");
  });
}

test("the complete stdout candidate survives validation without field loss", (t) => {
  const harness = createHarness(t);
  const fetchedAt = new Date().toISOString();
  const completeModel = {
    ...harness.model,
    additional_speed_tiers: [{ name: "fast", multiplier: 2 }],
    service_tiers: ["priority"],
    model_messages: { instructions_template: "Template {{ personality }}" },
    unknown_upstream_field: { nested: [1, 2, 3] },
  };
  const candidate = { models: [completeModel], unknown_top_level: "preserve-me" };
  setRunner(harness, {
    stdout: candidate,
    cache: { fetched_at: fetchedAt, models: [{ slug: harness.model.slug }] },
  });

  assert.deepEqual(acquireNativeCatalog(harness.options), {
    status: "acquired",
    candidate,
    attestation: { fetchedAt },
    clientVersion: CLIENT_VERSION,
  });
});

test("successful acquisition exposes only attestation metadata from the validated cache", (t) => {
  const harness = createHarness(t);
  const fetchedAt = new Date().toISOString();
  const candidate = {
    models: [harness.model],
    fetched_at: "stdout-must-not-win",
    etag: "stdout-must-not-win",
  };
  setRunner(harness, {
    stdout: candidate,
    cache: {
      fetched_at: fetchedAt,
      etag: "account-etag-exact",
      private_cache_field: "must-not-be-exposed",
      models: [{ slug: harness.model.slug }],
    },
  });

  assert.deepEqual(acquireNativeCatalog(harness.options), {
    status: "acquired",
    candidate,
    attestation: {
      fetchedAt,
      etag: "account-etag-exact",
    },
    clientVersion: CLIENT_VERSION,
  });
});

for (const [name, etag] of [
  ["missing", undefined],
  ["empty", ""],
]) {
  test(`${name} cache etag is omitted from the successful attestation`, (t) => {
    const harness = createHarness(t);
    const fetchedAt = new Date().toISOString();
    setRunner(harness, {
      cache: {
        fetched_at: fetchedAt,
        ...(etag === undefined ? {} : { etag }),
        models: [{ slug: harness.model.slug }],
      },
    });

    assert.deepEqual(acquireNativeCatalog(harness.options), {
      status: "acquired",
      candidate: { models: [harness.model] },
      attestation: { fetchedAt },
      clientVersion: CLIENT_VERSION,
    });
  });
}

test("cleanup unlinks the expected auth symlink before removing the generated tree", (t) => {
  const harness = createHarness(t);
  const events = [];
  let tempHome;
  setRunner(harness, {
    mutate(home) {
      tempHome = home;
    },
  });
  harness.options.cleanup = {
    unlink(target) {
      events.push(["unlink", target, lstatSync(target).isSymbolicLink()]);
      unlinkSync(target);
    },
    removeTree(target, options) {
      events.push([
        "removeTree",
        target,
        lstatSync(path.join(target, "auth.json"), { throwIfNoEntry: false }),
      ]);
      rmSync(target, options);
    },
  };

  acquireNativeCatalog(harness.options);

  assert.deepEqual(events, [
    ["unlink", path.join(tempHome, "auth.json"), true],
    ["removeTree", tempHome, undefined],
  ]);
  assert.equal(lstatSync(tempHome, { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(harness.authPath).isFile(), true);
});

for (const [name, mutateTempAuth] of [
  [
    "type",
    (tempAuthPath) => {
      unlinkSync(tempAuthPath);
      writeFileSync(tempAuthPath, "replacement", { mode: 0o600 });
    },
  ],
  [
    "target",
    (tempAuthPath, harness) => {
      const other = path.join(harness.root, "other-auth.json");
      writeFileSync(other, "other", { mode: 0o600 });
      unlinkSync(tempAuthPath);
      symlinkSync(other, tempAuthPath);
    },
  ],
]) {
  test(`a temporary auth ${name} change leaves the private tree for recovery`, (t) => {
    const harness = createHarness(t);
    let tempHome;
    setRunner(harness, {
      mutate(home) {
        tempHome = home;
        mutateTempAuth(path.join(home, "auth.json"), harness);
      },
    });

    expectCode(
      () => acquireNativeCatalog(harness.options),
      "TEMP_AUTH_POSTFLIGHT_INVALID",
    );
    assert.equal(lstatSync(tempHome).isDirectory(), true);
    assert.equal(lstatSync(path.join(tempHome, "auth.json"))[
      name === "type" ? "isFile" : "isSymbolicLink"
    ](), true);
  });
}

test("an in-place auth write preserving the canonical inode is admitted", (t) => {
  const harness = createHarness(t);
  const before = lstatSync(harness.authPath);
  setRunner(harness, {
    mutate() {
      appendFileSync(harness.authPath, " refreshed-in-place");
    },
  });

  const result = acquireNativeCatalog(harness.options);
  const after = lstatSync(harness.authPath);

  assert.equal(result.status, "acquired");
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o600);
});

test("an unexpected canonical auth inode replacement aborts and cleans the safe temp link", (t) => {
  const harness = createHarness(t);
  let tempHome;
  setRunner(harness, {
    mutate(home) {
      tempHome = home;
      renameSync(harness.authPath, `${harness.authPath}.old`);
      writeFileSync(harness.authPath, "replacement", { mode: 0o600 });
    },
  });

  expectCode(() => acquireNativeCatalog(harness.options), "AUTH_POSTFLIGHT_CHANGED");
  assert.equal(lstatSync(tempHome, { throwIfNoEntry: false }), undefined);
});

test("a canonical auth path resolution change after the child aborts", (t) => {
  const harness = createHarness(t);
  let authRealpathCalls = 0;
  const realpathSync = (value) => {
    if (value === harness.authPath) {
      authRealpathCalls += 1;
      return authRealpathCalls === 1
        ? harness.authPath
        : path.join(harness.root, "replacement-auth.json");
    }
    return path.resolve(value);
  };
  harness.options.fileSystem = { realpathSync };

  expectCode(() => acquireNativeCatalog(harness.options), "AUTH_POSTFLIGHT_CHANGED");
  assert.equal(authRealpathCalls, 2);
});

test("a replaced temporary root is left intact instead of recursively deleted", (t) => {
  const harness = createHarness(t);
  let tempHome;
  setRunner(harness, {
    mutate(home) {
      tempHome = home;
      renameSync(home, `${home}.generated`);
      mkdirSync(home, { mode: 0o700 });
      symlinkSync(harness.authPath, path.join(home, "auth.json"));
      writeCache(home, [{ slug: harness.model.slug }]);
    },
  });

  expectCode(
    () => acquireNativeCatalog(harness.options),
    "TEMP_HOME_POSTFLIGHT_CHANGED",
  );
  assert.equal(lstatSync(tempHome).isDirectory(), true);
  assert.equal(lstatSync(path.join(tempHome, "auth.json")).isSymbolicLink(), true);
});

test("retargeting a symlinked auth parent is detected against its preflight resolution", (t) => {
  const harness = createHarness(t);
  const firstRealParent = path.join(harness.root, "auth-parent-before");
  const secondRealParent = path.join(harness.root, "auth-parent-after");
  renameSync(harness.authDir, firstRealParent);
  symlinkSync(firstRealParent, harness.authDir);
  const before = lstatSync(harness.authPath);
  setRunner(harness, {
    mutate() {
      renameSync(firstRealParent, secondRealParent);
      unlinkSync(harness.authDir);
      symlinkSync(secondRealParent, harness.authDir);
    },
  });

  expectCode(() => acquireNativeCatalog(harness.options), "AUTH_POSTFLIGHT_CHANGED");
  const after = lstatSync(harness.authPath);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
});

test("an auth-symlink cleanup failure is sanitized and leaves the tree intact", (t) => {
  const harness = createHarness(t);
  let tempHome;
  let removeCalls = 0;
  setRunner(harness, {
    mutate(home) {
      tempHome = home;
    },
  });
  harness.options.cleanup = {
    unlink() {
      throw new Error("RAW_CLEANUP_UNLINK_SENTINEL");
    },
    removeTree() {
      removeCalls += 1;
    },
  };

  assert.throws(
    () => acquireNativeCatalog(harness.options),
    (error) =>
      error?.code === "CLEANUP_UNLINK_FAILED" &&
      !error.message.includes("RAW_CLEANUP_UNLINK_SENTINEL"),
  );
  assert.equal(removeCalls, 0);
  assert.equal(lstatSync(tempHome).isDirectory(), true);
  assert.equal(lstatSync(path.join(tempHome, "auth.json")).isSymbolicLink(), true);
});

test("a generated-tree removal failure is sanitized after the auth link is unlinked", (t) => {
  const harness = createHarness(t);
  let tempHome;
  setRunner(harness, {
    mutate(home) {
      tempHome = home;
    },
  });
  harness.options.cleanup = {
    unlink: unlinkSync,
    removeTree() {
      throw new Error("RAW_CLEANUP_REMOVE_SENTINEL");
    },
  };

  assert.throws(
    () => acquireNativeCatalog(harness.options),
    (error) =>
      error?.code === "CLEANUP_REMOVE_FAILED" &&
      !error.message.includes("RAW_CLEANUP_REMOVE_SENTINEL"),
  );
  assert.equal(lstatSync(tempHome).isDirectory(), true);
  assert.equal(
    lstatSync(path.join(tempHome, "auth.json"), { throwIfNoEntry: false }),
    undefined,
  );
});
