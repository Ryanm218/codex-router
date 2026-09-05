import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  privateFileIsProtected,
  protectPrivateFile,
} from "./file-security.mjs";
import { withCatalogOperationLock } from "./catalog-operation-lock.mjs";
import { acquireNativeCatalog } from "./native-catalog-refresh.mjs";
import {
  ANNOUNCED_MODELS_PATH,
  CODEX_HOME,
  CONFIG_PATH,
  NATIVE_CATALOG_PATH,
  STATE_DIR,
} from "./paths.mjs";
import { codexAuthStatus, codexVersion, runCodex } from "./codex-binary.mjs";
import { readUserModels } from "./user-models.mjs";
import { syncRoutedCodexAgents } from "./codex-agent-catalog.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  applyMultiAgentSettings,
  readMultiAgentSettings,
} from "./multi-agent-state.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { buildNativeAliasAssignments } from "./native-alias.mjs";
import { selectedConfiguredListedModels } from "./provider-selection.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { applyVisionBridge, resolveVisionEngine } from "./vision-bridge.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";

function captureNative({ bundledNative = false } = {}) {
  const args = ["debug", "models"];
  if (bundledNative) args.push("--bundled");
  let output;
  try {
    output = runCodex(args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (bundledNative) throw error;
    output = runCodex(["debug", "models", "--bundled"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  const parsed = JSON.parse(output);
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error("Codex returned an empty or invalid model catalog.");
  }
  if (parsed.models.some((model) => MODEL_BY_SLUG.has(String(model.slug)))) {
    throw new Error(
      "Refusing to capture an already-merged catalog. Disable the router before refreshing native models.",
    );
  }
  const capturedWith = codexVersion();
  return {
    ...parsed,
    ...(capturedWith ? { captured_with: capturedWith } : {}),
  };
}

// A native capture is only trustworthy for the Codex build that produced it:
// newer builds can require catalog fields the older build never emitted, or
// carry different capability values for the same slug. An unknown current
// version keeps the cache — with no binary to re-ask, stale is the best we
// have.
export function nativeCatalogIsReusable(parsed, currentVersion) {
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    return false;
  }
  return !currentVersion || parsed.captured_with === currentVersion;
}

function nativeCatalog({ refreshNative = false, bundledNative = false } = {}) {
  if (!existsSync(NATIVE_CATALOG_PATH) || refreshNative) {
    return { candidate: captureNative({ bundledNative }) };
  }
  const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
  if (nativeCatalogIsReusable(parsed, codexVersion())) {
    return {
      candidate: parsed,
      trustedStoredCapturedWith: parsed.captured_with,
    };
  }
  try {
    return { candidate: captureNative({ bundledNative }) };
  } catch (error) {
    // Version-mismatched is still better than empty: serve the stale capture
    // when the re-capture fails, but say so instead of hiding it.
    if (parsed && Array.isArray(parsed.models) && parsed.models.length > 0) {
      console.error(
        `Could not refresh the native model catalog (${error.message}); reusing the cached capture.`,
      );
      return {
        candidate: parsed,
        trustedStoredCapturedWith: parsed.captured_with,
      };
    }
    throw error;
  }
}

// Codex's picker deserializes reasoning efforts into a fixed enum and
// silently drops any level it does not recognize, so a curated "max" level
// simply vanishes from the effort menu on builds whose enum ends at xhigh
// (issue #57). No runtime probe can see this: config parsing accepts unknown
// effort strings, and `debug models` passes catalog levels through as plain
// strings even on builds whose picker cannot offer them. The enum history is
// the only reliable signal — max and ultra joined in 0.143.0 (verified
// against the published binaries: 0.142.5 lacks the serde variants, 0.143.0
// carries them), and the baseline predates this router. An unknown version
// clamps: a wrongly clamped Max still routes at full effort under the xhigh
// label, while a wrongly emitted max is exactly the missing-picker-entry bug.
const BASELINE_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const EFFORT_LADDER = [...BASELINE_EFFORTS, "max", "ultra"];
const MAX_EFFORT_SINCE = [0, 143, 0];

export function codexEffortVocabulary(version) {
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?/.exec(String(version || ""));
  if (!match) return new Set(BASELINE_EFFORTS);
  const installed = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    if (installed[index] > MAX_EFFORT_SINCE[index]) return new Set(EFFORT_LADDER);
    if (installed[index] < MAX_EFFORT_SINCE[index]) return new Set(BASELINE_EFFORTS);
  }
  // Exactly the boundary release: prereleases of it may predate the variants.
  return match[4] ? new Set(BASELINE_EFFORTS) : new Set(EFFORT_LADDER);
}

function clampEffort(effort, vocabulary) {
  if (vocabulary.has(effort)) return effort;
  const start = EFFORT_LADDER.indexOf(effort);
  // Off-ladder values cannot be ranked, so pass them through unchanged.
  if (start === -1) return effort;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (vocabulary.has(EFFORT_LADDER[index])) return EFFORT_LADDER[index];
  }
  return effort;
}

// Registry levels are ordered lightest-first, so when a clamped level lands on
// an effort the model already offers (xhigh + max both become xhigh), the
// genuine entry keeps its slot and the clamped duplicate is dropped.
export function clampModelEfforts(models, vocabulary) {
  return models.map((model) => {
    if (!Array.isArray(model.reasoningLevels)) return model;
    const levels = [];
    const seen = new Set();
    for (const level of model.reasoningLevels) {
      const effort = clampEffort(level.effort, vocabulary);
      if (seen.has(effort)) continue;
      seen.add(effort);
      levels.push(effort === level.effort ? level : { ...level, effort });
    }
    const defaultEffort = clampEffort(model.defaultEffort, vocabulary);
    if (
      defaultEffort === model.defaultEffort &&
      levels.length === model.reasoningLevels.length &&
      levels.every((level, index) => level === model.reasoningLevels[index])
    ) {
      return model;
    }
    return { ...model, reasoningLevels: levels, defaultEffort };
  });
}

function selectedModel() {
  if (!existsSync(CONFIG_PATH)) return undefined;
  const config = readFileSync(CONFIG_PATH, "utf8");
  const firstTable = config.search(/^\s*\[/m);
  const root = firstTable === -1 ? config : config.slice(0, firstTable);
  return root.match(/^\s*model\s*=\s*["\']([^"\']+)["\']/m)?.[1];
}

// Login-free mode routes everything through the external providers, so native
// GPT slugs are unusable there even when a ChatGPT credential file exists.
// Mode toggles pass the desired state via MODEL_ROUTER_LOGIN_FREE because they
// rebuild the catalog before rewriting the Codex config.
function loginFreeConfigured() {
  const override = process.env.MODEL_ROUTER_LOGIN_FREE;
  if (override === "1") return true;
  if (override === "0") return false;
  if (!existsSync(CONFIG_PATH)) return false;
  const config = readFileSync(CONFIG_PATH, "utf8");
  const firstTable = config.search(/^\s*\[/m);
  const root = firstTable === -1 ? config : config.slice(0, firstTable);
  return root.match(/^\s*model_provider\s*=\s*["\']([^"\']+)["\']/m)?.[1] === "codex-router";
}

function identityName(model) {
  const displayName = String(model.displayName || "").trim();
  if (displayName) {
    return displayName.replace(/\s*\((?:OAuth|API)\)\s*$/i, "").trim() || displayName;
  }
  const slug = String(model.slug || "").trim();
  const bare = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  return bare || "an external model";
}

function rewriteIdentity(text, model) {
  if (typeof text !== "string" || !text) return text;
  const name = identityName(model);
  return text
    .replace(
      /\b(?:a coding agent|an agent) based on GPT-5\b/g,
      `a coding agent based on ${name}`,
    )
    .replace(/\bbased on GPT-5\b/g, `based on ${name}`);
}

function rewriteModelMessages(messages, model) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
    return messages;
  }
  const next = { ...messages };
  if (typeof next.instructions_template === "string") {
    next.instructions_template = rewriteIdentity(next.instructions_template, model);
  }
  return next;
}

function normalizeNativeModel(model) {
  return {
    ...model,
    supports_reasoning_summaries:
      typeof model.supports_reasoning_summaries === "boolean"
        ? model.supports_reasoning_summaries
        : false,
  };
}

export function routedModel(template, model) {
  const next = {
    ...template,
    slug: model.slug,
    display_name: model.displayName,
    description: model.description,
    priority: model.priority,
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: model.defaultEffort,
    supported_reasoning_levels: model.reasoningLevels,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: model.autoCompact,
    input_modalities: model.inputModalities,
    comp_hash: model.compHash,
    additional_speed_tiers: [],
    service_tiers: [],
    // Codex surfaces this once per slug (up to its own show cap) as the
    // "Introducing {model}" announcement; absent copy must stay null so the
    // client never renders an empty card.
    availability_nux:
      typeof model.availabilityNux === "string" && model.availabilityNux.trim()
        ? { message: model.availabilityNux.trim() }
        : null,
    // Codex renders the markdown as the whole "Codex just got an upgrade"
    // modal when this entry is the operator's current model and the target
    // slug is listed; {model_from}/{model_to} are substituted by the client.
    upgrade: model.upgradeTo
      ? {
          model: model.upgradeTo.model,
          migration_markdown: model.upgradeTo.markdown.trim(),
        }
      : null,
    supports_reasoning_summaries: model.supportsReasoningSummaries === true,
    default_reasoning_summary:
      model.supportsReasoningSummaries === true
        ? model.defaultReasoningSummary || "auto"
        : "none",
    support_verbosity: false,
    default_verbosity: null,
    // Capability toggles come from the registry entry, never from the native
    // template: an absent flag keeps the conservative default so a routed
    // model only advertises what its slug's gateway path actually verified.
    // "hosted" is the only search mode the request path can serve today (the
    // provider backend runs the search server-side, as the Grok OAuth
    // forwarder does); the registry loader rejects anything else.
    supports_search_tool: model.searchTool?.mode === "hosted",
    supports_image_detail_original: model.supportsImageDetailOriginal === true,
    use_responses_lite: false,
    // Codex only knows one ApplyPatchToolType variant. The native template
    // carries "freeform", but upstreams that reject OpenAI custom tools (Meta
    // Responses, for example) must opt out explicitly; null is the only value
    // that suppresses the tool without making the catalog unparseable.
    apply_patch_tool_type: model.supportsApplyPatchTool === false ? null : "freeform",
    // Codex v2 collaboration only exposes spawn_agent model overrides whose
    // catalog entry advertises the same backend version as the parent. Models
    // opt in after their tool and encrypted-payload relay paths are verified.
    multi_agent_version: model.multiAgentVersion || "v1",
  };
  if (typeof next.base_instructions === "string") {
    next.base_instructions = rewriteIdentity(next.base_instructions, model);
  }
  if (next.model_messages) {
    next.model_messages = rewriteModelMessages(next.model_messages, model);
  }
  return next;
}

export function applyAllMultiAgent(models, enabled) {
  if (!enabled) return models;
  return models.map((model) => ({ ...model, multiAgentVersion: "v2" }));
}

export const AUTO_ANNOUNCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function formatTokenCount(tokens) {
  if (tokens >= 995_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${millions % 1 === 0 ? Math.round(millions) : millions}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

function joinNaturally(parts) {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// Announcement copy is assembled from verified registry capabilities only, so
// it can never claim more than the picker metadata already does.
function autoAnnouncementCopy(model) {
  const details = [];
  if (Number.isInteger(model.contextWindow)) {
    details.push(`a ${formatTokenCount(model.contextWindow)}-token context window`);
  }
  const efforts = Array.isArray(model.reasoningLevels)
    ? model.reasoningLevels.map((level) => level.effort)
    : [];
  if (efforts.length > 1) {
    details.push(`reasoning efforts from ${efforts[0]} to ${efforts[efforts.length - 1]}`);
  }
  if ((model.inputModalities || []).includes("image")) {
    details.push("image input");
  }
  const capabilities = details.length ? ` It comes with ${joinNaturally(details)}.` : "";
  return `${model.displayName} just landed in your model picker.${capabilities}`;
}

// A new checked-in model announces itself for a window of rebuilds rather
// than a single one, because catalogs rebuild on updates and provider toggles
// and the operator may not launch Codex in between; Codex itself stops the
// card after four showings per slug. The first capture seeds silently so an
// install never announces the entire catalog, and locally curated models are
// excluded because the operator added those deliberately. Only models whose
// provider is selected and credentialed ever reach this list, so a model the
// operator cannot use never announces.
export function annotateNewModelAnnouncements(routedModelsList, announcedAt, userSlugs, now) {
  const firstRun = announcedAt === null;
  const nextAnnouncedAt = new Map(firstRun ? [] : announcedAt);
  const models = routedModelsList.map((model) => {
    if (!nextAnnouncedAt.has(model.slug)) {
      nextAnnouncedAt.set(model.slug, firstRun ? 0 : now);
    }
    if (model.availabilityNux || userSlugs.has(model.slug)) return model;
    const since = nextAnnouncedAt.get(model.slug);
    if (since === 0 || now - since >= AUTO_ANNOUNCE_WINDOW_MS) return model;
    return { ...model, availabilityNux: autoAnnouncementCopy(model) };
  });
  return { models, announcedAt: nextAnnouncedAt };
}

function readAnnouncedAt(target = ANNOUNCED_MODELS_PATH) {
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    if (!parsed || typeof parsed.models !== "object" || Array.isArray(parsed.models)) {
      return null;
    }
    return new Map(
      Object.entries(parsed.models).filter(([, value]) => Number.isFinite(value)),
    );
  } catch {
    // Corrupt state must reseed silently, not announce the whole catalog.
    return null;
  }
}

function sortCatalogModels(models) {
  return [...models].sort((left, right) => {
    const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999);
    return priority || String(left.slug).localeCompare(String(right.slug));
  });
}

// Native entries carry upstream's static multi_agent_version, and upstream
// still ships gpt-5.6-luna as "v1" even though it runs correctly on the v2
// backend (openai/codex#35097, #36294). spawn_agent filters candidate child
// models on that static value, so a v1 entry can never be delegated to by a v2
// parent. applyMultiAgentSettings only reaches routed models, which is why
// "all" mode never promoted the native slugs; apply the same opt-in here so the
// subagent modes mean what the Settings tab says they mean.
export function promoteNativeMultiAgent(models, settings, hidden = new Set()) {
  const enabled = new Set(settings.enabled || []);
  const disabled = new Set(settings.disabled || []);
  return models.map((model) => {
    const slug = String(model.slug);
    if (model.visibility !== "list") return model;
    if (hidden.has(slug) || disabled.has(slug)) return model;
    if (settings.mode === "all" || (settings.mode === "selected" && enabled.has(slug))) {
      return { ...model, multi_agent_version: "v2" };
    }
    return model;
  });
}

export function buildMergedCatalog(native, routedModelsList, { includeNative = true } = {}) {
  const template =
    native.models.find((model) => model.slug === "gpt-5.5") ||
    native.models.find((model) => model.visibility === "list") ||
    native.models[0];
  if (!template) {
    throw new Error("Native model catalog is empty.");
  }
  const models = new Map(
    includeNative
      ? native.models.map((model) => [model.slug, normalizeNativeModel(model)])
      : [],
  );
  for (const model of routedModelsList) {
    models.set(model.slug, routedModel(template, model));
  }
  return sortCatalogModels(models.values());
}

// Login-free Codex surfaces only list allowlisted native slugs, so external
// models are republished under those slugs with their own names and reasoning
// levels. Each aliased model keeps a hidden entry under its canonical slug so
// routing, doctor checks, and existing configs keep resolving it.
export function buildLoginFreeCatalog(native, routedModelsList) {
  const assignments = buildNativeAliasAssignments(native.models, routedModelsList);
  const aliasedSlugs = new Set(assignments.map(({ model }) => model.slug));
  const aliases = Object.fromEntries(
    assignments.map(({ nativeModel, model }) => [nativeModel.slug, model.slug]),
  );
  const models = [
    ...assignments.map(({ nativeModel, model }) => ({
      ...routedModel(nativeModel, model),
      slug: nativeModel.slug,
      priority: nativeModel.priority,
    })),
    ...buildMergedCatalog(native, routedModelsList, { includeNative: false }).map(
      (model) =>
        aliasedSlugs.has(model.slug) ? { ...model, visibility: "hide" } : model,
    ),
  ];
  return { models: sortCatalogModels(models), aliases };
}

export const DEFAULT_CODEX_APP_BINARY =
  "/Applications/Codex.app/Contents/Resources/codex";

export function catalogArtifactPaths(stateDir = STATE_DIR) {
  return {
    nativeCatalog: path.join(stateDir, "native-models.json"),
    aliasCatalog: path.join(stateDir, "native-aliases.json"),
    announcementCatalog: path.join(stateDir, "announced-models.json"),
    mergedCatalog: path.join(stateDir, "merged-models.json"),
    captureMetadata: path.join(stateDir, "native-capture-metadata.json"),
  };
}

function stripControlledCatalogProvenance(candidate) {
  return Object.fromEntries(
    Object.entries(candidate).filter(
      ([key]) => !["captured_with", "etag", "fetched_at"].includes(key),
    ),
  );
}

function catalogDigest(candidate) {
  return createHash("sha256")
    .update(JSON.stringify(stripControlledCatalogProvenance(candidate)))
    .digest("hex");
}

function assertUniqueModels(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw catalogTransactionError("CATALOG_ARTIFACT_INVALID");
  }
  const slugs = models.map((model) => String(model?.slug || ""));
  if (slugs.some((slug) => !slug) || new Set(slugs).size !== slugs.length) {
    throw catalogTransactionError("CATALOG_ARTIFACT_INVALID");
  }
  return new Set(slugs);
}

function validateAliasInvariants(mergedModels, aliases) {
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw catalogTransactionError("CATALOG_ARTIFACT_INVALID");
  }
  const bySlug = new Map(mergedModels.map((model) => [String(model.slug), model]));
  for (const [nativeSlug, routedSlug] of Object.entries(aliases)) {
    if (
      typeof routedSlug !== "string" ||
      !bySlug.has(nativeSlug) ||
      !bySlug.has(routedSlug) ||
      bySlug.get(routedSlug).visibility !== "hide"
    ) {
      throw catalogTransactionError("CATALOG_ARTIFACT_INVALID");
    }
  }
}

export function buildCatalogArtifacts({
  candidate,
  attestation,
  clientVersion,
  trustedStoredCapturedWith,
  routedModels = [],
  announcedAt = null,
  userSlugs = new Set(),
  hiddenModels = new Set(),
  multiAgentSettings = { mode: "proven", enabled: [], disabled: [] },
  loginFree = false,
  openaiAuthenticated = true,
  now = Date.now(),
  visionEngine,
  includeCaptureMetadata = true,
}) {
  const configuredRoutedModels = applyMultiAgentSettings(
    routedModels,
    multiAgentSettings,
    hiddenModels,
  );
  const announced = annotateNewModelAnnouncements(
    clampModelEfforts(
      configuredRoutedModels,
      codexEffortVocabulary(clientVersion),
    ),
    announcedAt,
    userSlugs,
    now,
  );
  const catalogModels = applyVisionBridge(announced.models, visionEngine);
  const nativeCatalog = {
    ...stripControlledCatalogProvenance(candidate),
    ...(trustedStoredCapturedWith || clientVersion
      ? { captured_with: trustedStoredCapturedWith || clientVersion }
      : {}),
  };
  const native = {
    ...nativeCatalog,
    models: promoteNativeMultiAgent(
      candidate.models,
      multiAgentSettings,
      hiddenModels,
    ),
  };
  const built = loginFree
    ? buildLoginFreeCatalog(native, catalogModels)
    : {
        models: buildMergedCatalog(native, catalogModels, {
          includeNative: openaiAuthenticated,
        }),
        aliases: {},
      };
  const mergedModels = built.models.map((model) =>
    hiddenModels.has(String(model.slug))
      ? { ...model, visibility: "hide" }
      : model,
  );
  assertUniqueModels(nativeCatalog.models);
  assertUniqueModels(mergedModels);
  validateAliasInvariants(mergedModels, built.aliases);

  const captureMetadata = includeCaptureMetadata
    ? {
        version: 1,
        digest: catalogDigest(candidate),
        captured_with: clientVersion,
        ...(typeof attestation?.etag === "string" ? { etag: attestation.etag } : {}),
        ...(typeof attestation?.fetchedAt === "string"
          ? { fetched_at: attestation.fetchedAt }
          : {}),
        captured_at: new Date(now).toISOString(),
      }
    : undefined;

  return {
    nativeCatalog,
    aliasCatalog: { version: 1, aliases: built.aliases },
    announcementCatalog: {
      version: 1,
      models: Object.fromEntries([...announced.announcedAt.entries()].sort()),
    },
    mergedCatalog: { models: mergedModels },
    captureMetadata,
    routedModels: announced.models,
    catalogModels,
    summary: {
      models: mergedModels.length,
      routedModels: announced.models.length,
      aliasedModels: Object.keys(built.aliases).length,
      nativeModels: !loginFree && openaiAuthenticated
        ? mergedModels.filter((model) => !MODEL_BY_SLUG.has(String(model.slug))).length
        : 0,
      loginFree,
      openaiAuthenticated,
      visionBridgeEngine: visionEngine?.slug || null,
      visionBridgedModels: catalogModels.filter(
        (model) => model.visionBridgeEngine !== undefined,
      ).length,
    },
  };
}

function catalogTransactionError(code, cause) {
  const error = new Error(`Catalog transaction failed (${code}).`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const DEFAULT_CATALOG_FILE_SYSTEM = {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
};

export function validateCatalogArtifacts(artifacts) {
  if (
    !artifacts ||
    !artifacts.nativeCatalog ||
    !artifacts.aliasCatalog ||
    !artifacts.announcementCatalog ||
    !artifacts.mergedCatalog
  ) {
    throw catalogTransactionError("CATALOG_ARTIFACT_INVALID");
  }
  assertUniqueModels(artifacts.nativeCatalog.models);
  assertUniqueModels(artifacts.mergedCatalog.models);
  validateAliasInvariants(
    artifacts.mergedCatalog.models,
    artifacts.aliasCatalog.aliases,
  );
  if (
    artifacts.announcementCatalog.version !== 1 ||
    !artifacts.announcementCatalog.models ||
    typeof artifacts.announcementCatalog.models !== "object" ||
    Array.isArray(artifacts.announcementCatalog.models)
  ) {
    throw catalogTransactionError("CATALOG_ARTIFACT_INVALID");
  }
  if (
    artifacts.captureMetadata !== undefined &&
    (artifacts.captureMetadata?.version !== 1 ||
      !/^[0-9a-f]{64}$/.test(String(artifacts.captureMetadata.digest || "")) ||
      typeof artifacts.captureMetadata.captured_with !== "string")
  ) {
    throw catalogTransactionError("CATALOG_ARTIFACT_INVALID");
  }
}

function removeIfPresent(target, fileSystem) {
  try {
    fileSystem.unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreSnapshot(target, snapshot, fileSystem, protectFile, suffix) {
  if (!snapshot.exists) {
    removeIfPresent(target, fileSystem);
    return;
  }
  const restorePath = `${target}.restore.${suffix}`;
  fileSystem.writeFileSync(restorePath, snapshot.bytes, { mode: 0o600 });
  protectFile(restorePath);
  fileSystem.renameSync(restorePath, target);
}

export function publishCatalogArtifacts(
  artifacts,
  {
    paths = catalogArtifactPaths(),
    fileSystem: fileSystemOverrides = {},
    protectFile = protectPrivateFile,
    privateFileProtected = privateFileIsProtected,
    platform = process.platform,
    suffix = `${process.pid}.${randomUUID()}`,
  } = {},
) {
  validateCatalogArtifacts(artifacts);
  const fileSystem = { ...DEFAULT_CATALOG_FILE_SYSTEM, ...fileSystemOverrides };
  const orderedKeys = [
    "nativeCatalog",
    "aliasCatalog",
    "announcementCatalog",
    "mergedCatalog",
    ...(artifacts.captureMetadata ? ["captureMetadata"] : []),
  ];
  const snapshots = Object.fromEntries(
    orderedKeys.map((key) => {
      const target = paths[key];
      const exists = fileSystem.existsSync(target);
      return [key, {
        exists,
        bytes: exists ? fileSystem.readFileSync(target) : undefined,
      }];
    }),
  );
  const staged = new Map();

  try {
    for (const key of orderedKeys) {
      const target = paths[key];
      fileSystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const stagePath = `${target}.stage.${suffix}`;
      staged.set(key, stagePath);
      fileSystem.writeFileSync(stagePath, serializeJson(artifacts[key]), {
        encoding: "utf8",
        mode: 0o600,
      });
      protectFile(stagePath);
      const metadata = fileSystem.lstatSync(stagePath);
      const privateMode = platform === "win32" || (metadata.mode & 0o777) === 0o600;
      if (!metadata.isFile() || !privateMode || !privateFileProtected(stagePath)) {
        throw catalogTransactionError("CATALOG_STAGE_INVALID");
      }
      const parsed = JSON.parse(fileSystem.readFileSync(stagePath, "utf8"));
      if (JSON.stringify(parsed) !== JSON.stringify(artifacts[key])) {
        throw catalogTransactionError("CATALOG_STAGE_INVALID");
      }
    }
  } catch (error) {
    for (const stagePath of staged.values()) {
      try {
        removeIfPresent(stagePath, fileSystem);
      } catch {
        // A failed stage cleanup cannot make any target less last-known-good.
      }
    }
    throw error?.code ? error : catalogTransactionError("CATALOG_STAGE_FAILED", error);
  }

  const published = [];
  const catalogKeys = [
    "nativeCatalog",
    "aliasCatalog",
    "announcementCatalog",
    "mergedCatalog",
  ];
  try {
    for (const key of catalogKeys) {
      fileSystem.renameSync(staged.get(key), paths[key]);
      staged.delete(key);
      published.push(key);
    }
  } catch (error) {
    let rollbackError;
    for (const key of [...published].reverse()) {
      try {
        restoreSnapshot(paths[key], snapshots[key], fileSystem, protectFile, suffix);
      } catch (restoreError) {
        rollbackError ||= restoreError;
      }
    }
    for (const stagePath of staged.values()) {
      try {
        removeIfPresent(stagePath, fileSystem);
      } catch {
        // Preserve the primary stable publication failure.
      }
    }
    throw catalogTransactionError(
      rollbackError ? "CATALOG_ROLLBACK_FAILED" : "CATALOG_PUBLISH_FAILED",
      rollbackError || error,
    );
  }

  let captureMetadataPublished = artifacts.captureMetadata === undefined;
  if (artifacts.captureMetadata) {
    const stagePath = staged.get("captureMetadata");
    try {
      fileSystem.renameSync(stagePath, paths.captureMetadata);
      captureMetadataPublished = true;
    } catch {
      // The merged generation is already active. Leaving the old metadata is
      // deliberate: the next refresh will repair instead of returning unchanged.
      try {
        removeIfPresent(stagePath, fileSystem);
      } catch {
        // The private staged file is harmless and never marks a generation current.
      }
    }
  }
  return { captureMetadataPublished };
}

function parsedJsonOrUndefined(target, fileSystem) {
  try {
    return JSON.parse(fileSystem.readFileSync(target, "utf8"));
  } catch {
    return undefined;
  }
}

function activeCatalogMatches(artifacts, paths, fileSystem) {
  const metadata = parsedJsonOrUndefined(paths.captureMetadata, fileSystem);
  if (
    metadata?.version !== 1 ||
    metadata.digest !== artifacts.captureMetadata.digest ||
    metadata.captured_with !== artifacts.captureMetadata.captured_with
  ) {
    return false;
  }
  const native = parsedJsonOrUndefined(paths.nativeCatalog, fileSystem);
  const merged = parsedJsonOrUndefined(paths.mergedCatalog, fileSystem);
  return (
    JSON.stringify(native) === JSON.stringify(artifacts.nativeCatalog) &&
    JSON.stringify(merged) === JSON.stringify(artifacts.mergedCatalog)
  );
}

function defaultCatalogContext({ candidate, clientVersion, now, paths }) {
  const userSlugs = new Set(readUserModels().map((model) => String(model.slug)));
  const hiddenModels = readHiddenModels();
  const routedModels = selectedConfiguredListedModels();
  const multiAgentSettings = readMultiAgentSettings();
  const visionEngine = resolveVisionEngine(
    routedModels,
    readVisionBridgeSettings(),
  );
  return {
    candidate,
    clientVersion,
    routedModels,
    announcedAt: readAnnouncedAt(paths.announcementCatalog),
    userSlugs,
    hiddenModels,
    multiAgentSettings,
    loginFree: loginFreeConfigured(),
    openaiAuthenticated: true,
    now,
    visionEngine,
  };
}

export async function refreshNativeCatalog({
  stateDir = STATE_DIR,
  paths = catalogArtifactPaths(stateDir),
  authPath = path.join(CODEX_HOME, "auth.json"),
  codexBinary = DEFAULT_CODEX_APP_BINARY,
  uid,
  now = Date.now,
  env,
  runner,
  cleanup,
  acquisitionFileSystem,
  fileSystem: fileSystemOverrides = {},
  lockOptions = {},
  acquire = acquireNativeCatalog,
  withLock = withCatalogOperationLock,
  resolveContext = defaultCatalogContext,
  buildArtifacts = buildCatalogArtifacts,
  syncAgents = syncRoutedCodexAgents,
  assertOwnership = assertStateOwnership,
} = {}) {
  return withLock(async () => {
    assertOwnership("refresh the Codex model catalog");
    const acquired = await acquire({
      authPath,
      stateDir,
      codexBinary,
      routedSlugs: new Set(MODEL_BY_SLUG.keys()),
      uid,
      now,
      env,
      runner,
      fileSystem: acquisitionFileSystem,
      cleanup,
    });
    if (acquired.status === "skipped") {
      return { status: "skipped", nativeModels: 0 };
    }

    const clientVersion = acquired.clientVersion;
    const instant = now();
    const context = resolveContext({
      candidate: acquired.candidate,
      clientVersion,
      now: instant,
      paths,
    });
    const artifacts = buildArtifacts({
      ...context,
      candidate: acquired.candidate,
      attestation: acquired.attestation,
      clientVersion,
      trustedStoredCapturedWith: undefined,
      now: context.now ?? instant,
      includeCaptureMetadata: true,
    });
    validateCatalogArtifacts(artifacts);
    syncAgents(artifacts.routedModels);
    const fileSystem = { ...DEFAULT_CATALOG_FILE_SYSTEM, ...fileSystemOverrides };
    if (activeCatalogMatches(artifacts, paths, fileSystem)) {
      return { status: "unchanged", nativeModels: acquired.candidate.models.length };
    }
    publishCatalogArtifacts(artifacts, {
      paths,
      fileSystem: fileSystemOverrides,
    });
    return { status: "updated", nativeModels: acquired.candidate.models.length };
  }, { stateDir, ...lockOptions });
}

function main(flags = {}) {
  // The catalog is what Codex offers in its picker. Writing it from a checkout
  // that does not own this state directory is how the picker ends up
  // advertising models the running gateway has no route for.
  assertStateOwnership("write the Codex model catalog");
  const userSlugs = new Set(readUserModels().map((model) => String(model.slug)));
  const hiddenModels = readHiddenModels();
  const selectedModels = selectedConfiguredListedModels();
  const multiAgentSettings = readMultiAgentSettings();
  const currentVersion = codexVersion();
  const visionEngine = resolveVisionEngine(selectedModels, readVisionBridgeSettings());
  const captured = nativeCatalog(flags);
  // Dropping every native model is destructive, so only do it when Codex
  // actually answered that the session is signed out. If the probe could not
  // run at all we do not know, and guessing "signed out" is what silently
  // emptied the picker for Windows npm installs.
  const auth = codexAuthStatus();
  if (auth.reason === "probe-failed") {
    throw new Error(
      `Could not ask Codex whether it is signed in (${auth.code || "spawn failed"} running ${auth.binary}). ` +
        "Refusing to rebuild the catalog, because assuming a signed-out session would remove every native model. " +
        "Set CODEX_BIN to a runnable Codex CLI and try again.",
    );
  }
  const openaiAuthenticated = auth.authenticated;
  const loginFree = loginFreeConfigured();
  const paths = catalogArtifactPaths();
  const artifacts = buildCatalogArtifacts({
    candidate: captured.candidate,
    trustedStoredCapturedWith: captured.trustedStoredCapturedWith,
    clientVersion: currentVersion,
    routedModels: selectedModels,
    announcedAt: readAnnouncedAt(paths.announcementCatalog),
    userSlugs,
    hiddenModels,
    multiAgentSettings,
    loginFree,
    openaiAuthenticated,
    now: Date.now(),
    visionEngine,
    includeCaptureMetadata: false,
  });
  validateCatalogArtifacts(artifacts);
  // Agent synchronization and every validation/staging step finish before the
  // first live catalog target changes. The merged catalog then publishes last.
  const routedAgents = syncRoutedCodexAgents(artifacts.routedModels);
  publishCatalogArtifacts(artifacts, { paths });
  process.stdout.write(
    `${JSON.stringify({
      path: paths.mergedCatalog,
      models: artifacts.summary.models,
      routed_models: artifacts.summary.routedModels,
      routed_agents: routedAgents.length,
      vision_bridge_engine: artifacts.summary.visionBridgeEngine,
      vision_bridged_models: artifacts.summary.visionBridgedModels,
      native_models: artifacts.summary.nativeModels,
      aliased_models: artifacts.summary.aliasedModels,
      login_free: loginFree,
      openai_authenticated: openaiAuthenticated,
      openai_auth_reason: auth.reason,
      selected_model: selectedModel() || null,
    })}\n`,
  );
}

export async function runCatalogCli({
  argv = process.argv.slice(2),
  withLock = withCatalogOperationLock,
  operation = main,
  stateDir,
} = {}) {
  const flags = {
    refreshNative: argv.includes("--refresh-native"),
    bundledNative: argv.includes("--bundled-native"),
  };
  return withLock(() => operation(flags), stateDir ? { stateDir } : undefined);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCatalogCli();
  } catch (error) {
    // Ownership conflicts are an operator mistake with a specific remedy, so
    // print the guidance rather than a stack trace.
    if (error?.code === "foreign_state_owner") {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
