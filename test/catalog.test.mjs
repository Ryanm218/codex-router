import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTO_ANNOUNCE_WINDOW_MS,
  annotateNewModelAnnouncements,
  applyAllMultiAgent,
  buildCatalogArtifacts,
  buildMergedCatalog,
  buildLoginFreeCatalog,
  catalogArtifactPaths,
  clampModelEfforts,
  codexEffortVocabulary,
  nativeCatalogIsReusable,
  publishCatalogArtifacts,
  promoteNativeMultiAgent,
  refreshNativeCatalog,
  routedModel,
} from "../src/catalog.mjs";

const template = {
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  description: "Native template",
  priority: 10,
  visibility: "list",
  base_instructions:
    "You are Codex, a coding agent based on GPT-5. You and the user share one workspace.",
  model_messages: {
    instructions_template:
      "You are Codex, a coding agent based on GPT-5. {{ personality }}",
    instructions_variables: {
      personality_default: "",
    },
  },
  apply_patch_tool_type: "freeform",
};

const grok = {
  slug: "grok-oauth/grok-4.5",
  displayName: "Grok 4.5 (OAuth)",
  description: "Grok through OAuth",
  priority: 1,
  defaultEffort: "high",
  reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
  contextWindow: 500000,
  autoCompact: 440000,
  inputModalities: ["text", "image"],
  compHash: "grok-oauth-grok-4-5-v1",
  multiAgentVersion: "v2",
};

test("routed models rewrite GPT identity text to the external model name", () => {
  const model = routedModel(template, grok);
  assert.equal(model.slug, "grok-oauth/grok-4.5");
  assert.equal(model.display_name, "Grok 4.5 (OAuth)");
  assert.match(model.base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(model.base_instructions, /GPT-5/);
  assert.match(model.model_messages.instructions_template, /based on Grok 4\.5/);
  assert.doesNotMatch(model.model_messages.instructions_template, /GPT-5/);
  assert.equal(model.model_messages.instructions_variables.personality_default, "");
  assert.equal(model.multi_agent_version, "v2");
});

test("routed models are native v2 spawn-agent model overrides", () => {
  const model = routedModel(template, grok);
  assert.equal(model.visibility, "list");
  assert.equal(model.supported_in_api, true);
  assert.equal(model.multi_agent_version, "v2");
});

test("routed models advertise reasoning summaries only when the registry opts in", () => {
  // Default stays off: external models must not claim summary support untested.
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_reasoning_summaries, false);
  assert.equal(plain.default_reasoning_summary, "none");
  const summarized = routedModel(template, {
    ...grok,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: "auto",
  });
  assert.equal(summarized.supports_reasoning_summaries, true);
  assert.equal(summarized.default_reasoning_summary, "auto");
});

test("routed models advertise search and image detail only when the registry opts in", () => {
  // Defaults stay off: external models must not claim capabilities untested.
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_search_tool, false);
  assert.equal(plain.supports_image_detail_original, false);
  const capable = routedModel(template, {
    ...grok,
    searchTool: { mode: "hosted" },
    supportsImageDetailOriginal: true,
  });
  assert.equal(capable.supports_search_tool, true);
  assert.equal(capable.supports_image_detail_original, true);
});

test("routed models inherit apply_patch unless the registry opts out", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.apply_patch_tool_type, "freeform");
  const noPatch = routedModel(template, {
    ...grok,
    supportsApplyPatchTool: false,
  });
  assert.equal(noPatch.apply_patch_tool_type, null);
});

test("routed models announce availability only when curated with NUX copy", () => {
  // Default stays null: an empty announcement card must never render.
  const plain = routedModel(template, grok);
  assert.equal(plain.availability_nux, null);
  const announced = routedModel(template, {
    ...grok,
    availabilityNux: "  Grok 4.5 now routes through your own X subscription.  ",
  });
  assert.deepEqual(announced.availability_nux, {
    message: "Grok 4.5 now routes through your own X subscription.",
  });
});

test("first capture seeds announcement state without announcing anything", () => {
  const { models, announcedAt } = annotateNewModelAnnouncements([grok], null, new Set(), 1000);
  assert.equal(models[0].availabilityNux, undefined);
  assert.equal(announcedAt.get(grok.slug), 0);
});

test("models new since the last capture announce for a window, then go quiet", () => {
  const seeded = new Map([["kimi-oauth/k3", 0]]);
  const now = 5000;
  const { models, announcedAt } = annotateNewModelAnnouncements([grok], seeded, new Set(), now);
  assert.equal(
    models[0].availabilityNux,
    "Grok 4.5 (OAuth) just landed in your model picker. It comes with a 500K-token context window and image input.",
  );
  assert.equal(announcedAt.get(grok.slug), now);
  // Within the window the copy persists across rebuilds; after it, silence.
  const later = annotateNewModelAnnouncements([grok], announcedAt, new Set(), now + 1);
  assert.ok(later.models[0].availabilityNux);
  const expired = annotateNewModelAnnouncements(
    [grok],
    announcedAt,
    new Set(),
    now + AUTO_ANNOUNCE_WINDOW_MS,
  );
  assert.equal(expired.models[0].availabilityNux, undefined);
  assert.equal(expired.announcedAt.get(grok.slug), now);
});

test("curated copy and locally curated models are left alone by auto-announce", () => {
  const seeded = new Map();
  const curated = { ...grok, availabilityNux: "Hand-written copy." };
  const { models } = annotateNewModelAnnouncements([curated], seeded, new Set(), 1000);
  assert.equal(models[0].availabilityNux, "Hand-written copy.");
  const userModel = { ...grok, slug: "deepseek/user-added" };
  const skipped = annotateNewModelAnnouncements(
    [userModel],
    seeded,
    new Set(["deepseek/user-added"]),
    1000,
  );
  assert.equal(skipped.models[0].availabilityNux, undefined);
});

test("routed models carry a migration prompt only when curated with upgradeTo", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.upgrade, null);
  const upgraded = routedModel(template, {
    ...grok,
    upgradeTo: {
      model: "kimi-oauth/k3",
      markdown: "# Introducing Kimi K3\n\nSwitch from {model_from} to {model_to}.\n",
    },
  });
  assert.deepEqual(upgraded.upgrade, {
    model: "kimi-oauth/k3",
    migration_markdown: "# Introducing Kimi K3\n\nSwitch from {model_from} to {model_to}.",
  });
});

test("unverified routed models retain conservative v1 collaboration", () => {
  const model = routedModel(template, {
    ...grok,
    slug: "example/model",
    multiAgentVersion: undefined,
  });
  assert.equal(model.multi_agent_version, "v1");
});

test("all-models multi-agent mode promotes every selected model to v2", () => {
  const models = [
    { slug: "opencode-go/deepseek-v4-flash" },
    { slug: "qwen-plan/qwen3.8-max", multiAgentVersion: "v1" },
  ];
  const promoted = applyAllMultiAgent(models, true);
  assert.deepEqual(
    promoted.map((model) => model.multiAgentVersion),
    ["v2", "v2"],
  );
  assert.equal(applyAllMultiAgent(models, false), models);
});

test("merged catalog preserves native GPT identity while rewriting routed models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok]);
  const bySlug = new Map(merged.map((model) => [model.slug, model]));
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on GPT-5/);
  assert.equal(bySlug.get("gpt-5.5").supports_reasoning_summaries, false);
  assert.match(bySlug.get("grok-oauth/grok-4.5").base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(bySlug.get("grok-oauth/grok-4.5").base_instructions, /GPT-5/);
});

test("merged catalog preserves an explicit native reasoning summary capability", () => {
  const native = {
    ...template,
    supports_reasoning_summaries: true,
  };
  const merged = buildMergedCatalog({ models: [native] }, []);
  assert.equal(merged[0].supports_reasoning_summaries, true);
});

test("login-free catalogs contain only authenticated external models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok], {
    includeNative: false,
  });
  assert.deepEqual(merged.map((model) => model.slug), ["grok-oauth/grok-4.5"]);
});

test("login-free catalog republishes external models under native slugs", () => {
  const kimi = {
    ...grok,
    slug: "kimi-oauth/k3",
    displayName: "Kimi K3 (OAuth)",
    priority: 2,
    compHash: "kimi-oauth-k3-v1",
  };
  const secondNative = {
    ...template,
    slug: "gpt-5.4",
    display_name: "GPT-5.4",
    priority: 20,
  };
  const { models, aliases } = buildLoginFreeCatalog(
    { models: [secondNative, template] },
    [grok, kimi],
  );

  assert.deepEqual(aliases, {
    "gpt-5.5": "grok-oauth/grok-4.5",
    "gpt-5.4": "kimi-oauth/k3",
  });

  const bySlug = new Map(models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("gpt-5.5").display_name, "Grok 4.5 (OAuth)");
  assert.equal(bySlug.get("gpt-5.5").visibility, "list");
  assert.equal(bySlug.get("gpt-5.5").priority, 10);
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on Grok 4\.5/);
  assert.equal(bySlug.get("gpt-5.4").display_name, "Kimi K3 (OAuth)");
  assert.equal(bySlug.get("grok-oauth/grok-4.5").visibility, "hide");
  assert.equal(bySlug.get("kimi-oauth/k3").visibility, "hide");
});

test("login-free catalog keeps overflow models visible under their own slugs", () => {
  const overflow = {
    ...grok,
    slug: "kimi-oauth/kimi-for-coding",
    displayName: "K2.7 Coding (OAuth)",
    priority: 3,
    compHash: "kimi-oauth-kimi-for-coding-v1",
  };
  const { models, aliases } = buildLoginFreeCatalog(
    { models: [template] },
    [grok, overflow],
  );

  assert.deepEqual(aliases, { "gpt-5.5": "grok-oauth/grok-4.5" });
  const bySlug = new Map(models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("kimi-oauth/kimi-for-coding").visibility, "list");
  assert.equal(bySlug.get("grok-oauth/grok-4.5").visibility, "hide");
});

test("effort vocabulary follows the installed codex build's enum history", () => {
  // max and ultra joined the enum in 0.143.0.
  const legacy = codexEffortVocabulary("codex-cli 0.142.5");
  assert.deepEqual(
    [...legacy].sort(),
    ["high", "low", "medium", "minimal", "xhigh"],
  );
  assert.ok(codexEffortVocabulary("codex-cli 0.143.0").has("max"));
  assert.ok(codexEffortVocabulary("codex-cli 0.147.0-alpha.1.2").has("ultra"));
  // A prerelease of the boundary build may predate the variants, and an
  // unknown version must clamp rather than risk an unparseable picker level.
  assert.ok(!codexEffortVocabulary("codex-cli 0.143.0-alpha.3").has("max"));
  assert.ok(!codexEffortVocabulary(undefined).has("max"));
});

test("efforts the installed codex build cannot parse clamp to the nearest supported tier", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.141.0");
  const [deepseek] = clampModelEfforts(
    [
      {
        ...grok,
        defaultEffort: "max",
        reasoningLevels: [
          { effort: "low", description: "Faster reasoning" },
          { effort: "high", description: "Deep reasoning" },
          { effort: "max", description: "Maximum reasoning" },
        ],
      },
    ],
    vocabulary,
  );
  // Codex 0.141 drops unknown enum variants, so "max" must reach it as xhigh
  // (issue #57); the forwarder already folds xhigh back to the upstream max.
  assert.deepEqual(deepseek.reasoningLevels, [
    { effort: "low", description: "Faster reasoning" },
    { effort: "high", description: "Deep reasoning" },
    { effort: "xhigh", description: "Maximum reasoning" },
  ]);
  assert.equal(deepseek.defaultEffort, "xhigh");
});

test("clamped duplicates collapse onto the model's genuine entry for that tier", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.141.0");
  const [opus] = clampModelEfforts(
    [
      {
        ...grok,
        defaultEffort: "max",
        reasoningLevels: [
          { effort: "xhigh", description: "Extended reasoning" },
          { effort: "max", description: "Maximum reasoning" },
        ],
      },
    ],
    vocabulary,
  );
  assert.deepEqual(opus.reasoningLevels, [
    { effort: "xhigh", description: "Extended reasoning" },
  ]);
  assert.equal(opus.defaultEffort, "xhigh");
});

test("models stay untouched when the installed build understands their efforts", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.146.1");
  const original = {
    ...grok,
    defaultEffort: "max",
    reasoningLevels: [
      { effort: "high", description: "Deep reasoning" },
      { effort: "max", description: "Maximum reasoning" },
    ],
  };
  const [unchanged] = clampModelEfforts([original], vocabulary);
  assert.equal(unchanged, original);
});

test("native catalog cache is reusable only for the codex build that captured it", () => {
  const captured = { captured_with: "codex-cli 0.142.5", models: [template] };

  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.142.5"), true);
  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.146.1"), false);
  // Unknown current version: no binary to re-ask, so keep what we have.
  assert.equal(nativeCatalogIsReusable(captured, undefined), true);
  // Un-stamped caches predate version tracking; re-capture when we can ask.
  assert.equal(nativeCatalogIsReusable({ models: [template] }, "codex-cli 0.146.1"), false);
  assert.equal(nativeCatalogIsReusable({ models: [template] }, undefined), true);
  // Invalid or empty caches are never reusable.
  assert.equal(nativeCatalogIsReusable(undefined, undefined), false);
  assert.equal(nativeCatalogIsReusable({ models: [] }, "codex-cli 0.146.1"), false);
});

test("native listed models follow the local subagent opt-in", () => {
  // Upstream still ships gpt-5.6-luna as v1 while it runs fine on the v2
  // backend, and spawn_agent filters child models on that static value.
  const native = [
    { slug: "gpt-5.6-terra", visibility: "list", multi_agent_version: "v2" },
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "codex-auto-review", visibility: "hide", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "all",
    enabled: [],
    disabled: [],
  });
  assert.equal(promoted[1].multi_agent_version, "v2");
  // Hidden native entries are never advertised as spawn targets.
  assert.equal(promoted[2].multi_agent_version, "v1");
});

test("native promotion honours disabled models and picker-hidden slugs", () => {
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.5", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(
    native,
    { mode: "all", enabled: [], disabled: ["gpt-5.6-luna"] },
    new Set(["gpt-5.5"]),
  );
  assert.equal(promoted[0].multi_agent_version, "v1");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

function completeNative(slug = "gpt-5.6-sol", priority = 10) {
  return {
    ...template,
    slug,
    display_name: slug,
    priority,
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
    additional_speed_tiers: [{ name: "fast", multiplier: 2 }],
    service_tiers: ["priority"],
    unknown_upstream_field: { nested: [1, 2, 3] },
  };
}

const kimi = {
  ...grok,
  slug: "kimi-api/kimi-k3",
  displayName: "Kimi K3 (API)",
  description: "Kimi through the routed API",
  priority: 2,
  compHash: "kimi-api-kimi-k3-v1",
};

function artifactInput(overrides = {}) {
  return {
    candidate: {
      models: [completeNative()],
      captured_with: "stdout-version-must-not-be-trusted",
      etag: "stdout-must-not-be-trusted",
      fetched_at: "1999-01-01T00:00:00.000Z",
      unknown_top_level: { keep: true },
    },
    attestation: {
      fetchedAt: "2026-09-05T01:59:59.000Z",
      etag: "attested-cache-etag",
    },
    clientVersion: "codex-cli 0.147.0-alpha.6.5",
    routedModels: [kimi],
    announcedAt: new Map([[kimi.slug, 0]]),
    userSlugs: new Set(),
    hiddenModels: new Set(),
    multiAgentSettings: { mode: "selected", enabled: [], disabled: [] },
    loginFree: false,
    openaiAuthenticated: true,
    now: Date.parse("2026-09-05T02:00:00.000Z"),
    visionEngine: undefined,
    ...overrides,
  };
}

test("complete catalog artifacts are built without filesystem writes and preserve upstream fields", () => {
  const before = process.cwd();
  const artifacts = buildCatalogArtifacts(artifactInput());

  assert.equal(process.cwd(), before);
  assert.equal(artifacts.nativeCatalog.unknown_top_level.keep, true);
  assert.deepEqual(
    artifacts.nativeCatalog.models[0].unknown_upstream_field,
    { nested: [1, 2, 3] },
  );
  assert.equal(artifacts.nativeCatalog.captured_with, "codex-cli 0.147.0-alpha.6.5");
  assert.equal(Object.hasOwn(artifacts.nativeCatalog, "etag"), false);
  assert.equal(Object.hasOwn(artifacts.nativeCatalog, "fetched_at"), false);
  assert.deepEqual(artifacts.nativeCatalog.models[0].additional_speed_tiers, [
    { name: "fast", multiplier: 2 },
  ]);
  assert.deepEqual(artifacts.nativeCatalog.models[0].service_tiers, ["priority"]);
  const bySlug = new Map(artifacts.mergedCatalog.models.map((model) => [model.slug, model]));
  assert.ok(bySlug.has("gpt-5.6-sol"));
  assert.ok(bySlug.has("kimi-api/kimi-k3"));
  assert.equal(artifacts.aliasCatalog.version, 1);
  assert.deepEqual(artifacts.aliasCatalog.aliases, {});
  assert.equal(artifacts.captureMetadata.digest.length, 64);
  assert.equal(artifacts.captureMetadata.captured_with, "codex-cli 0.147.0-alpha.6.5");
  assert.equal(artifacts.captureMetadata.fetched_at, "2026-09-05T01:59:59.000Z");
  assert.equal(artifacts.captureMetadata.etag, "attested-cache-etag");

  const differentlySpoofed = buildCatalogArtifacts(artifactInput({
    candidate: {
      ...artifactInput().candidate,
      captured_with: "another-stdout-version",
      etag: "another-stdout-etag",
      fetched_at: "2001-01-01T00:00:00.000Z",
    },
  }));
  assert.deepEqual(differentlySpoofed.nativeCatalog, artifacts.nativeCatalog);
  assert.equal(differentlySpoofed.captureMetadata.digest, artifacts.captureMetadata.digest);
});

test("capture metadata omits an absent attested ETag instead of trusting candidate stdout", () => {
  const artifacts = buildCatalogArtifacts(artifactInput({
    attestation: { fetchedAt: "2026-09-05T01:59:58.000Z" },
  }));

  assert.equal(artifacts.captureMetadata.fetched_at, "2026-09-05T01:59:58.000Z");
  assert.equal(Object.hasOwn(artifacts.captureMetadata, "etag"), false);
});

test("ordinary stale fallback preserves trusted stored version and stays eligible for recapture", () => {
  const artifacts = buildCatalogArtifacts(artifactInput({
    candidate: {
      captured_with: "codex-cli 0.142.5",
      models: [completeNative()],
    },
    trustedStoredCapturedWith: "codex-cli 0.142.5",
    clientVersion: "codex-cli 0.147.0-alpha.6.5",
    includeCaptureMetadata: false,
  }));

  assert.equal(artifacts.nativeCatalog.captured_with, "codex-cli 0.142.5");
  assert.equal(
    nativeCatalogIsReusable(
      artifacts.nativeCatalog,
      "codex-cli 0.147.0-alpha.6.5",
    ),
    false,
  );
});

test("transaction artifacts retain Kimi routes and login-free native alias invariants", () => {
  const secondNative = completeNative("gpt-5.5", 20);
  const artifacts = buildCatalogArtifacts(artifactInput({
    candidate: { models: [completeNative(), secondNative] },
    loginFree: true,
  }));

  assert.deepEqual(artifacts.aliasCatalog.aliases, {
    "gpt-5.6-sol": "kimi-api/kimi-k3",
  });
  const bySlug = new Map(artifacts.mergedCatalog.models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("gpt-5.6-sol").display_name, "Kimi K3 (API)");
  assert.equal(bySlug.get("gpt-5.6-sol").visibility, "list");
  assert.equal(bySlug.get("kimi-api/kimi-k3").visibility, "hide");
  assert.ok(!bySlug.has("gpt-5.5"));
});

function writeJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function createTransactionHarness(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-transaction-test-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const paths = catalogArtifactPaths(stateDir);
  const previous = {
    nativeCatalog: { captured_with: "old", models: [{ slug: "old-native" }] },
    aliasCatalog: { version: 1, aliases: { "old-native": "old-route" } },
    announcementCatalog: { version: 1, models: { "old-route": 1 } },
    mergedCatalog: { models: [{ slug: "old-merged" }] },
    captureMetadata: { version: 1, digest: "old", captured_with: "old" },
  };
  writeJson(paths.nativeCatalog, previous.nativeCatalog);
  writeJson(paths.aliasCatalog, previous.aliasCatalog);
  writeJson(paths.announcementCatalog, previous.announcementCatalog);
  writeJson(paths.mergedCatalog, previous.mergedCatalog);
  writeJson(paths.captureMetadata, previous.captureMetadata);
  const bytes = Object.fromEntries(
    Object.entries(paths).map(([key, target]) => [key, readFileSync(target)]),
  );
  return { stateDir, paths, previous, bytes };
}

function refreshOptions(harness, overrides = {}) {
  return {
    stateDir: harness.stateDir,
    paths: harness.paths,
    authPath: path.join(harness.stateDir, "auth.json"),
    codexBinary: "/Applications/Codex.app/Contents/Resources/codex",
    clientVersion: "caller-version-must-not-be-used",
    withLock: async (operation) => operation(),
    assertOwnership: () => {},
    acquire: () => ({
      status: "acquired",
      candidate: {
        ...artifactInput().candidate,
        captured_with: "changed-stdout-version",
        etag: "changed-stdout-etag",
        fetched_at: "2002-01-01T00:00:00.000Z",
      },
      attestation: artifactInput().attestation,
      clientVersion: "codex-cli 0.147.0-alpha.6.5",
    }),
    resolveContext: () => artifactInput(),
    syncAgents: () => [],
    ...overrides,
  };
}

test("matching metadata returns unchanged only while active native and merged bytes are consistent", async (t) => {
  const harness = createTransactionHarness(t);
  const first = await refreshNativeCatalog(refreshOptions(harness));
  assert.deepEqual(first, { status: "updated", nativeModels: 1 });
  const mergedMtime = statSync(harness.paths.mergedCatalog).mtimeMs;
  const nativeMtime = statSync(harness.paths.nativeCatalog).mtimeMs;

  let renames = 0;
  const unchanged = await refreshNativeCatalog(refreshOptions(harness, {
    acquire: () => ({
      status: "acquired",
      candidate: artifactInput().candidate,
      attestation: {
        fetchedAt: "2026-09-05T02:00:01.000Z",
        etag: "new-attested-cache-etag",
      },
      clientVersion: "codex-cli 0.147.0-alpha.6.5",
    }),
    fileSystem: {
      renameSync(...args) {
        renames += 1;
        return renameSync(...args);
      },
    },
  }));
  assert.deepEqual(unchanged, { status: "unchanged", nativeModels: 1 });
  assert.equal(renames, 0);
  assert.equal(statSync(harness.paths.mergedCatalog).mtimeMs, mergedMtime);
  assert.equal(statSync(harness.paths.nativeCatalog).mtimeMs, nativeMtime);
  assert.equal(
    JSON.parse(readFileSync(harness.paths.captureMetadata)).fetched_at,
    "2026-09-05T01:59:59.000Z",
  );

  writeJson(harness.paths.mergedCatalog, harness.previous.mergedCatalog);
  const repaired = await refreshNativeCatalog(refreshOptions(harness));
  assert.deepEqual(repaired, { status: "updated", nativeModels: 1 });
  assert.notDeepEqual(JSON.parse(readFileSync(harness.paths.mergedCatalog)), harness.previous.mergedCatalog);
});

test("missing or mismatched capture metadata forces repair instead of masking an interrupted publish", async (t) => {
  const harness = createTransactionHarness(t);
  await refreshNativeCatalog(refreshOptions(harness));
  const expectedMerged = readFileSync(harness.paths.mergedCatalog);

  unlinkSync(harness.paths.captureMetadata);
  assert.deepEqual(await refreshNativeCatalog(refreshOptions(harness)), {
    status: "updated",
    nativeModels: 1,
  });
  assert.deepEqual(readFileSync(harness.paths.mergedCatalog), expectedMerged);

  writeJson(harness.paths.captureMetadata, {
    version: 1,
    digest: "mismatched",
    captured_with: "codex-cli 0.147.0-alpha.6.5",
  });
  assert.deepEqual(await refreshNativeCatalog(refreshOptions(harness)), {
    status: "updated",
    nativeModels: 1,
  });
});

test("safe refresh forwards the explicit acquisition contract and returns only status/count on skip", async (t) => {
  const harness = createTransactionHarness(t);
  let acquisitionOptions;
  const result = await refreshNativeCatalog(refreshOptions(harness, {
    acquire(options) {
      acquisitionOptions = options;
      return { status: "skipped", reason: "signed-out" };
    },
  }));

  assert.equal(
    acquisitionOptions.codexBinary,
    "/Applications/Codex.app/Contents/Resources/codex",
  );
  assert.equal(acquisitionOptions.authPath, path.join(harness.stateDir, "auth.json"));
  assert.equal(Object.hasOwn(acquisitionOptions, "clientVersion"), false);
  assert.deepEqual(result, { status: "skipped", nativeModels: 0 });
});

test("the default signed-out safe refresh never consults the generic Codex resolver", async (t) => {
  const harness = createTransactionHarness(t);
  const genericBinary = path.join(harness.stateDir, "generic-codex");
  const marker = path.join(harness.stateDir, "generic-version-called");
  writeFileSync(
    genericBinary,
    "#!/bin/sh\nprintf '%s\\n' called > \"$GENERIC_VERSION_MARKER\"\nprintf '%s\\n' generic-version-must-not-run\n",
    { mode: 0o755 },
  );
  const previousCodexBin = process.env.CODEX_BIN;
  const previousMarker = process.env.GENERIC_VERSION_MARKER;
  process.env.CODEX_BIN = genericBinary;
  process.env.GENERIC_VERSION_MARKER = marker;
  t.after(() => {
    if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBin;
    if (previousMarker === undefined) delete process.env.GENERIC_VERSION_MARKER;
    else process.env.GENERIC_VERSION_MARKER = previousMarker;
  });
  let explicitRunnerCalls = 0;

  const result = await refreshNativeCatalog({
    stateDir: harness.stateDir,
    paths: harness.paths,
    authPath: path.join(harness.stateDir, "missing-auth.json"),
    codexBinary: "/Applications/Codex.app/Contents/Resources/codex",
    runner() {
      explicitRunnerCalls += 1;
      throw new Error("the explicit runner must remain idle while signed out");
    },
    withLock: async (operation) => operation(),
    assertOwnership: () => {},
  });

  assert.deepEqual(result, { status: "skipped", nativeModels: 0 });
  assert.equal(explicitRunnerCalls, 0);
  assert.equal(existsSync(marker), false);
});

test("safe refresh publishes only the acquisition attestation, not candidate or context metadata", async (t) => {
  const harness = createTransactionHarness(t);
  const input = artifactInput();
  const result = await refreshNativeCatalog(refreshOptions(harness, {
    acquire: () => ({
      status: "acquired",
      candidate: input.candidate,
      attestation: {
        fetchedAt: "2026-09-05T02:00:02.000Z",
        etag: "acquisition-cache-etag",
      },
      clientVersion: "codex-cli 0.153.3",
    }),
    resolveContext: () => ({
      ...input,
      clientVersion: "context-version-must-not-win",
      trustedStoredCapturedWith: "context-stored-version-must-not-win",
      attestation: {
        fetchedAt: "2000-01-01T00:00:00.000Z",
        etag: "context-must-not-win",
      },
    }),
  }));

  assert.deepEqual(result, { status: "updated", nativeModels: 1 });
  const metadata = JSON.parse(readFileSync(harness.paths.captureMetadata, "utf8"));
  assert.equal(metadata.fetched_at, "2026-09-05T02:00:02.000Z");
  assert.equal(metadata.etag, "acquisition-cache-etag");
  assert.notEqual(metadata.fetched_at, input.candidate.fetched_at);
  assert.notEqual(metadata.etag, input.candidate.etag);
  assert.equal(metadata.captured_with, "codex-cli 0.153.3");
  const native = JSON.parse(readFileSync(harness.paths.nativeCatalog, "utf8"));
  assert.equal(native.captured_with, "codex-cli 0.153.3");
});

test("catalog publication renames merged last among catalogs and capture metadata afterward", (t) => {
  const harness = createTransactionHarness(t);
  const events = [];
  const artifacts = buildCatalogArtifacts(artifactInput());
  publishCatalogArtifacts(artifacts, {
    paths: harness.paths,
    fileSystem: {
      renameSync(source, target) {
        events.push(target);
        return renameSync(source, target);
      },
    },
  });

  assert.deepEqual(events.slice(0, 5), [
    harness.paths.nativeCatalog,
    harness.paths.aliasCatalog,
    harness.paths.announcementCatalog,
    harness.paths.mergedCatalog,
    harness.paths.captureMetadata,
  ]);
});

test("Windows staging accepts ACL protection without a POSIX 0600 mode", (t) => {
  const harness = createTransactionHarness(t);
  const artifacts = buildCatalogArtifacts(artifactInput());

  assert.doesNotThrow(() => publishCatalogArtifacts(artifacts, {
    paths: harness.paths,
    platform: "win32",
    protectFile: () => {},
    privateFileProtected: () => true,
    fileSystem: {
      lstatSync() {
        return { isFile: () => true, mode: 0o100666 };
      },
    },
  }));
  assert.deepEqual(
    JSON.parse(readFileSync(harness.paths.nativeCatalog, "utf8")),
    artifacts.nativeCatalog,
  );
});

test("staging rejects a file that the cross-platform protection check rejects", (t) => {
  const harness = createTransactionHarness(t);
  const artifacts = buildCatalogArtifacts(artifactInput());

  assert.throws(() => publishCatalogArtifacts(artifacts, {
    paths: harness.paths,
    platform: "win32",
    protectFile: () => {},
    privateFileProtected: () => false,
  }), (error) => error?.code === "CATALOG_STAGE_INVALID");
  for (const [key, target] of Object.entries(harness.paths)) {
    assert.deepEqual(readFileSync(target), harness.bytes[key]);
  }
});

test("artifact validation failure touches no target", (t) => {
  const harness = createTransactionHarness(t);
  const artifacts = buildCatalogArtifacts(artifactInput());
  artifacts.mergedCatalog.models.push({ ...artifacts.mergedCatalog.models[0] });
  let writes = 0;

  assert.throws(
    () => publishCatalogArtifacts(artifacts, {
      paths: harness.paths,
      fileSystem: {
        writeFileSync() {
          writes += 1;
        },
      },
    }),
    (error) => error?.code === "CATALOG_ARTIFACT_INVALID",
  );
  assert.equal(writes, 0);
  for (const [key, target] of Object.entries(harness.paths)) {
    assert.deepEqual(readFileSync(target), harness.bytes[key]);
  }
});

test("safe refresh validates complete artifacts before agent sync or filesystem writes", async (t) => {
  const harness = createTransactionHarness(t);
  const malformed = buildCatalogArtifacts(artifactInput());
  malformed.mergedCatalog.models.push({ ...malformed.mergedCatalog.models[0] });
  let syncCalls = 0;
  let writes = 0;

  await assert.rejects(
    refreshNativeCatalog(refreshOptions(harness, {
      buildArtifacts: () => malformed,
      syncAgents() {
        syncCalls += 1;
      },
      fileSystem: {
        writeFileSync(...args) {
          writes += 1;
          return writeFileSync(...args);
        },
      },
    })),
    (error) => error?.code === "CATALOG_ARTIFACT_INVALID",
  );
  assert.equal(syncCalls, 0);
  assert.equal(writes, 0);
});

test("staging failure leaves every last-known-good target byte-identical", (t) => {
  const harness = createTransactionHarness(t);
  const artifacts = buildCatalogArtifacts(artifactInput());
  let stageWrites = 0;
  const mergedMtime = statSync(harness.paths.mergedCatalog).mtimeMs;

  assert.throws(() => publishCatalogArtifacts(artifacts, {
    paths: harness.paths,
    fileSystem: {
      writeFileSync(target, bytes, options) {
        stageWrites += 1;
        if (stageWrites === 2) throw new Error("injected stage failure");
        return writeFileSync(target, bytes, options);
      },
    },
  }));
  for (const [key, target] of Object.entries(harness.paths)) {
    assert.deepEqual(readFileSync(target), harness.bytes[key]);
  }
  assert.equal(statSync(harness.paths.mergedCatalog).mtimeMs, mergedMtime);
});

for (const failedKey of [
  "nativeCatalog",
  "aliasCatalog",
  "announcementCatalog",
  "mergedCatalog",
]) {
  test(`failure renaming ${failedKey} restores prior auxiliary bytes and leaves merged active`, (t) => {
    const harness = createTransactionHarness(t);
    const artifacts = buildCatalogArtifacts(artifactInput());
    const mergedMtime = statSync(harness.paths.mergedCatalog).mtimeMs;

    assert.throws(() => publishCatalogArtifacts(artifacts, {
      paths: harness.paths,
      fileSystem: {
        renameSync(source, target) {
          if (target === harness.paths[failedKey] && source.includes(".stage.")) {
            throw new Error(`injected rename failure: ${failedKey}`);
          }
          return renameSync(source, target);
        },
      },
    }));

    for (const key of ["nativeCatalog", "aliasCatalog", "announcementCatalog", "mergedCatalog"] ) {
      assert.deepEqual(readFileSync(harness.paths[key]), harness.bytes[key]);
    }
    assert.equal(statSync(harness.paths.mergedCatalog).mtimeMs, mergedMtime);
  });
}

test("a capture-metadata rename failure cannot mark the new merged generation unchanged", async (t) => {
  const harness = createTransactionHarness(t);
  let failed = false;
  const first = await refreshNativeCatalog(refreshOptions(harness, {
    fileSystem: {
      renameSync(source, target) {
        if (!failed && target === harness.paths.captureMetadata && source.includes(".stage.")) {
          failed = true;
          throw new Error("injected metadata rename failure");
        }
        return renameSync(source, target);
      },
    },
  }));
  assert.deepEqual(first, { status: "updated", nativeModels: 1 });
  assert.deepEqual(JSON.parse(readFileSync(harness.paths.captureMetadata)), harness.previous.captureMetadata);

  assert.deepEqual(await refreshNativeCatalog(refreshOptions(harness)), {
    status: "updated",
    nativeModels: 1,
  });
});

test("selected subagent mode only promotes the chosen native models", () => {
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.4", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "selected",
    enabled: ["gpt-5.6-luna"],
    disabled: [],
  });
  assert.equal(promoted[0].multi_agent_version, "v2");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("proven subagent mode leaves the native catalog untouched", () => {
  const native = [{ slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" }];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "proven",
    enabled: [],
    disabled: [],
  });
  assert.deepEqual(promoted, native);
});

test("a bridged text-only model advertises image input, and only through the bridge", async () => {
  const { applyVisionBridge } = await import("../src/vision-bridge.mjs");
  const deepseek = {
    ...grok,
    slug: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    gatewayModel: "deepseek-v4-pro",
    inputModalities: ["text"],
    compHash: "deepseek-v4-pro-v1",
  };

  // Off, or with no engine to read images with, the catalog repeats the
  // registry's honest declaration and Codex refuses the paste.
  assert.deepEqual(routedModel(template, deepseek).input_modalities, ["text"]);

  const [bridged] = applyVisionBridge([deepseek], grok);
  const entry = routedModel(template, bridged);
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  // The bridge is router state, not a picker field: nothing about the engine
  // leaks into what Codex reads.
  assert.equal(entry.visionBridgeEngine, undefined);
  // Advertising image input is not a claim about detail handling.
  assert.equal(entry.supports_image_detail_original, false);
});
