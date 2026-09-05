import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import lockfile from "proper-lockfile";

import { privateFileIsProtected, protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { CHATGPT_ACCOUNT_HOMES_DIR, CHATGPT_ACCOUNT_POOL_PATH } from "./paths.mjs";
import { findCodexBinary } from "./codex-binary.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import {
  attachChatGPTLoginLease,
  assertChatGPTLoginLeaseInactive,
  chatGPTLoginAuthChanged,
  chatGPTLoginLeaseStatus,
  clearChatGPTLoginLease,
  createChatGPTLoginLease,
} from "./chatgpt-login-lease.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";
import {
  withChatGPTAccountOperationLock,
  withChatGPTAccountOperationLockSync,
} from "./chatgpt-account-operation-lock.mjs";
import {
  assertNoActiveRequestUseLeases,
  assertNoChatGPTProfileSwitchReservation,
} from "./chatgpt-request-use-lease.mjs";

export const CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION = 1;

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ACCOUNTS = 64;
const MAX_ERROR_LENGTH = 512;
const EXPIRY_SKEW_MS = 120_000;
const ACCOUNT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_REFRESH_RETRY_MS = 5 * 60 * 1000;
export const ACCOUNT_REFRESH_POLL_LIMIT = 8;
export const ACCOUNT_REFRESH_POLL_CONCURRENCY = 2;
const ACCOUNT_REFRESH_TIMEOUT_MS = 30_000;
const FALLBACK_AFFINITY_TTL_SECONDS = 7 * 24 * 60 * 60;
const FALLBACK_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_MAX_HOPS = 2;
const FALLBACK_POLICY_KEYS = new Set(["enabled", "strategy", "maxHops", "affinityTtlSeconds"]);
const POLICY_KEYS = new Set(["enabled", "mode", "selectedAccountId", "fallback"]);
const FALLBACK_OBSERVATION_KEYS = new Set(["enabled", "quota", "catalog"]);
const FALLBACK_QUOTA_KEYS = new Set(["state", "observedAt", "cooldownUntil"]);
const FALLBACK_CATALOG_KEYS = new Set(["state", "generation", "capturedAt", "lastAttemptAt", "lastResult"]);
const AFFINITY_SESSION_KEYS = new Set(["version", "epoch", "bindings", "aliases", "quarantine"]);
const AFFINITY_QUARANTINE_KEYS = new Set(["state", "detectedAt", "bindingCount", "aliasCount"]);
const AFFINITY_EPOCH = /^[A-Za-z0-9_-]{22}$/;
const AFFINITY_DIGEST = /^[A-Za-z0-9_-]{43}$/;
const AFFINITY_RECORD_LIMIT = 2_048;
const RESERVED_BINDING_KEYS = new Set([
  "state", "generation", "createdAt", "lastUsedAt", "requests", "turns", "reason",
  "accountId", "reservedUntil",
]);
const BOUND_BINDING_KEYS = new Set([
  "state", "generation", "createdAt", "lastUsedAt", "requests", "turns", "reason",
  "accountId", "boundAt", "expiresAt",
]);
const TOMBSTONE_BINDING_KEYS = new Set([
  "state", "generation", "createdAt", "lastUsedAt", "requests", "turns", "reason",
  "tombstonedAt",
]);
const LIVE_ALIAS_KEYS = new Set(["state", "rootDigest", "createdAt", "lastUsedAt", "expiresAt"]);
const TOMBSTONE_ALIAS_KEYS = new Set(["state", "rootDigest", "createdAt", "lastUsedAt", "tombstonedAt"]);
const LIVE_BINDING_REASONS = new Set(["terminal-quota", "inherited", "operator"]);
const TOMBSTONE_BINDING_REASONS = new Set([
  "account-removed", "account-revoked", "account-paused", "fallback-disabled",
  "binding-expired", "operator-cleared", "reservation-owner-lost",
]);
const FALLBACK_CATALOG_RESULTS = new Set([
  "never", "ok", "last-known-good", "missing", "invalid", "incompatible",
  "too-old", "reauth-required", "login-busy", "request-in-use",
  "refresh-pending", "skipped-user-owned-source", "skipped-discovery-disabled",
  "unsupported-platform", "unsupported-cache-schema", "probe-failed",
  "publication-failed", "identity-changed", "cancelled-relaunch",
]);

function terminateRefreshProcessTree(child, {
  viaShell,
  platform,
  execFileSyncImpl,
} = {}) {
  if (viaShell && platform === "win32") {
    if (!Number.isInteger(child?.pid) || child.pid < 1) return false;
    try {
      const systemRoot = process.env.SystemRoot;
      const systemTaskkill = systemRoot ? path.join(systemRoot, "System32", "taskkill.exe") : undefined;
      const command = systemTaskkill && existsSync(systemTaskkill) ? systemTaskkill : "taskkill.exe";
      execFileSyncImpl(command, ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      return true;
    } catch {
      // Killing only cmd.exe would orphan the Codex descendant whose auth
      // write the lease protects. Keep the wrapper and lease live instead.
      return false;
    }
  }
  try {
    return child?.kill?.() !== false;
  } catch {
    return false;
  }
}

function assertAccountDiscoveryEnabled() {
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}
function iso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function isoNow(now = Date.now()) { return new Date(Number.isFinite(now) ? now : Date.now()).toISOString(); }
function accountId(value) {
  const id = text(value);
  if (!ACCOUNT_ID.test(id)) throw new Error("accountId must be an opaque acct_ identifier.");
  return id;
}
export function isChatGPTAccountId(value) { return typeof value === "string" && ACCOUNT_ID.test(value.trim()); }

function hasOnlyKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function fallbackPolicyDefaults() {
  return {
    enabled: false,
    strategy: "strict-priority",
    maxHops: FALLBACK_MAX_HOPS,
    affinityTtlSeconds: FALLBACK_AFFINITY_TTL_SECONDS,
  };
}

export function normalizeFallbackPolicy(value) {
  if (value === undefined) return fallbackPolicyDefaults();
  if (!hasOnlyKeys(value, FALLBACK_POLICY_KEYS)) return fallbackPolicyDefaults();
  const normalized = { ...fallbackPolicyDefaults(), ...value };
  if (
    typeof normalized.enabled !== "boolean"
    || normalized.strategy !== "strict-priority"
    || !Number.isSafeInteger(normalized.maxHops)
    || normalized.maxHops < 0
    || normalized.maxHops > FALLBACK_MAX_HOPS
    || normalized.affinityTtlSeconds !== FALLBACK_AFFINITY_TTL_SECONDS
  ) return fallbackPolicyDefaults();
  return normalized;
}

function fallbackObservationDefaults(enabled) {
  return {
    enabled,
    quota: { state: "unknown" },
    catalog: { state: "missing", lastResult: "never" },
  };
}

function normalizedOptionalIso(value) {
  if (value === undefined) return { valid: true, value: undefined };
  const normalized = iso(value);
  return { valid: Boolean(normalized), value: normalized };
}

export function normalizeFallbackObservation(value) {
  if (value === undefined) return fallbackObservationDefaults(true);
  const invalid = () => fallbackObservationDefaults(false);
  if (!hasOnlyKeys(value, FALLBACK_OBSERVATION_KEYS)) return invalid();
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") return invalid();

  const quota = value.quota === undefined ? { state: "unknown" } : value.quota;
  if (!hasOnlyKeys(quota, FALLBACK_QUOTA_KEYS)) return invalid();
  const quotaState = quota.state === undefined ? "unknown" : quota.state;
  if (!["clear", "cooldown", "unknown"].includes(quotaState)) return invalid();
  const observedAt = normalizedOptionalIso(quota.observedAt);
  const cooldownUntil = quota.cooldownUntil === null
    ? { valid: true, value: null }
    : normalizedOptionalIso(quota.cooldownUntil);
  if (!observedAt.valid || !cooldownUntil.valid) return invalid();

  const catalog = value.catalog === undefined
    ? { state: "missing", lastResult: "never" }
    : value.catalog;
  if (!hasOnlyKeys(catalog, FALLBACK_CATALOG_KEYS)) return invalid();
  const catalogState = catalog.state === undefined ? "missing" : catalog.state;
  const lastResult = catalog.lastResult === undefined ? "never" : catalog.lastResult;
  if (
    !["ready", "missing", "stale", "invalid", "refresh-pending"].includes(catalogState)
    || !FALLBACK_CATALOG_RESULTS.has(lastResult)
  ) return invalid();
  const generation = text(catalog.generation);
  if (
    catalog.generation !== undefined
    && (!generation || generation.length > 256 || /[\u0000-\u001f\u007f]/.test(generation))
  ) return invalid();
  const capturedAt = normalizedOptionalIso(catalog.capturedAt);
  const lastAttemptAt = normalizedOptionalIso(catalog.lastAttemptAt);
  if (!capturedAt.valid || !lastAttemptAt.valid) return invalid();

  return {
    enabled,
    quota: {
      state: quotaState,
      ...(observedAt.value ? { observedAt: observedAt.value } : {}),
      ...(cooldownUntil.value !== undefined ? { cooldownUntil: cooldownUntil.value } : {}),
    },
    catalog: {
      state: catalogState,
      ...(generation ? { generation } : {}),
      ...(capturedAt.value ? { capturedAt: capturedAt.value } : {}),
      ...(lastAttemptAt.value ? { lastAttemptAt: lastAttemptAt.value } : {}),
      lastResult,
    },
  };
}

function canonicalIso(value) {
  return typeof value === "string" && iso(value) === value;
}

function exactKeys(value, expected) {
  return hasOnlyKeys(value, expected) && Object.keys(value).length === expected.size;
}

function validAffinityCommon(value, expectedKeys, reasons) {
  return exactKeys(value, expectedKeys)
    && AFFINITY_EPOCH.test(value.generation)
    && canonicalIso(value.createdAt)
    && canonicalIso(value.lastUsedAt)
    && Number.isSafeInteger(value.requests)
    && value.requests >= 0
    && Number.isSafeInteger(value.turns)
    && value.turns >= 0
    && reasons.has(value.reason);
}

function normalizeAffinityBinding(value) {
  if (!plainObject(value)) return undefined;
  let expectedKeys;
  let reasons;
  if (value.state === "reserved") {
    expectedKeys = RESERVED_BINDING_KEYS;
    reasons = LIVE_BINDING_REASONS;
  } else if (value.state === "bound") {
    expectedKeys = BOUND_BINDING_KEYS;
    reasons = LIVE_BINDING_REASONS;
  } else if (value.state === "tombstone") {
    expectedKeys = TOMBSTONE_BINDING_KEYS;
    reasons = TOMBSTONE_BINDING_REASONS;
  } else {
    return undefined;
  }
  if (!validAffinityCommon(value, expectedKeys, reasons)) return undefined;
  if (value.state === "reserved") {
    if (!ACCOUNT_ID.test(value.accountId) || !canonicalIso(value.reservedUntil)) return undefined;
  } else if (value.state === "bound") {
    if (
      !ACCOUNT_ID.test(value.accountId)
      || !canonicalIso(value.boundAt)
      || !canonicalIso(value.expiresAt)
    ) return undefined;
  } else if (!canonicalIso(value.tombstonedAt)) {
    return undefined;
  }
  return { ...value };
}

function normalizeAffinityBindings(value) {
  if (!plainObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > AFFINITY_RECORD_LIMIT) return undefined;
  const normalized = {};
  for (const [digest, record] of entries) {
    if (!AFFINITY_DIGEST.test(digest)) return undefined;
    const binding = normalizeAffinityBinding(record);
    if (!binding) return undefined;
    normalized[digest] = binding;
  }
  return normalized;
}

function normalizeAffinityAlias(value, bindingDigests) {
  if (!plainObject(value) || !bindingDigests.has(value.rootDigest)) return undefined;
  if (value.state === "live") {
    if (
      !exactKeys(value, LIVE_ALIAS_KEYS)
      || !AFFINITY_DIGEST.test(value.rootDigest)
      || !canonicalIso(value.createdAt)
      || !canonicalIso(value.lastUsedAt)
      || !canonicalIso(value.expiresAt)
    ) return undefined;
  } else if (value.state === "tombstone") {
    if (
      !exactKeys(value, TOMBSTONE_ALIAS_KEYS)
      || !AFFINITY_DIGEST.test(value.rootDigest)
      || !canonicalIso(value.createdAt)
      || !canonicalIso(value.lastUsedAt)
      || !canonicalIso(value.tombstonedAt)
    ) return undefined;
  } else {
    return undefined;
  }
  return { ...value };
}

function normalizeAffinityAliases(value, bindings) {
  if (!plainObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length + Object.keys(bindings).length > AFFINITY_RECORD_LIMIT) return undefined;
  const bindingDigests = new Set(Object.keys(bindings));
  const normalized = {};
  for (const [digest, record] of entries) {
    if (!AFFINITY_DIGEST.test(digest) || bindingDigests.has(digest)) return undefined;
    const alias = normalizeAffinityAlias(record, bindingDigests);
    if (!alias) return undefined;
    normalized[digest] = alias;
  }
  return normalized;
}

function normalizeAffinityQuarantine(value) {
  if (value === null) return null;
  if (!hasOnlyKeys(value, AFFINITY_QUARANTINE_KEYS)) return undefined;
  if (
    value.state !== "affinity-secret-invalid"
    || !canonicalIso(value.detectedAt)
    || !Number.isSafeInteger(value.bindingCount)
    || value.bindingCount < 0
    || !Number.isSafeInteger(value.aliasCount)
    || value.aliasCount < 0
  ) return undefined;
  return {
    state: value.state,
    detectedAt: value.detectedAt,
    bindingCount: value.bindingCount,
    aliasCount: value.aliasCount,
  };
}

export function normalizeAffinitySessions(value) {
  if (value === undefined || (plainObject(value) && Object.keys(value).length === 0)) return {};
  if (!hasOnlyKeys(value, AFFINITY_SESSION_KEYS)) return undefined;
  if (
    Object.keys(value).length !== AFFINITY_SESSION_KEYS.size
    || value.version !== 1
    || !AFFINITY_EPOCH.test(value.epoch)
  ) return undefined;
  const bindings = normalizeAffinityBindings(value.bindings);
  if (!bindings) return undefined;
  const aliases = normalizeAffinityAliases(value.aliases, bindings);
  if (!aliases) return undefined;
  const quarantine = normalizeAffinityQuarantine(value.quarantine);
  if (quarantine === undefined) return undefined;
  return {
    version: 1,
    epoch: value.epoch,
    bindings,
    aliases,
    quarantine,
  };
}

function quarantinedAffinitySessions(value) {
  const saved = plainObject(value) ? normalizeAffinityQuarantine(value.quarantine) : undefined;
  const quarantine = saved || {
    state: "affinity-secret-invalid",
    detectedAt: isoNow(),
    bindingCount: plainObject(value?.bindings)
      ? Math.min(Object.keys(value.bindings).length, Number.MAX_SAFE_INTEGER)
      : 0,
    aliasCount: plainObject(value?.aliases)
      ? Math.min(Object.keys(value.aliases).length, Number.MAX_SAFE_INTEGER)
      : 0,
  };
  return {
    version: 1,
    epoch: plainObject(value) && AFFINITY_EPOCH.test(value.epoch)
      ? value.epoch
      : randomBytes(16).toString("base64url"),
    bindings: {},
    aliases: {},
    quarantine,
  };
}

function normalizePolicy(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const selected = text(source.selectedAccountId);
  const fallback = hasOnlyKeys(source, POLICY_KEYS)
    ? normalizeFallbackPolicy(source.fallback)
    : fallbackPolicyDefaults();
  return {
    enabled: source.enabled !== false,
    mode: "switch",
    ...(ACCOUNT_ID.test(selected) ? { selectedAccountId: selected } : {}),
    fallback,
  };
}
function normalizeIdentity(raw) {
  const value = text(raw?.accountId);
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return { accountId: value, ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}) };
}
function normalizeHealth(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const state = ["healthy", "cooldown", "reauth-required", "failed"].includes(source.state) ? source.state : "healthy";
  return {
    state,
    ...(iso(source.cooldownUntil) ? { cooldownUntil: iso(source.cooldownUntil) } : {}),
    ...(iso(source.lastSuccessAt) ? { lastSuccessAt: iso(source.lastSuccessAt) } : {}),
    ...(iso(source.lastErrorAt) ? { lastErrorAt: iso(source.lastErrorAt) } : {}),
    ...(iso(source.lastUsedAt) ? { lastUsedAt: iso(source.lastUsedAt) } : {}),
    ...(iso(source.lastRefreshAttemptAt) ? { lastRefreshAttemptAt: iso(source.lastRefreshAttemptAt) } : {}),
    ...(number(source.lastStatus) !== undefined ? { lastStatus: integer(source.lastStatus, 500, { min: 100, max: 999 }) } : {}),
    ...(text(source.lastError) ? { lastError: text(source.lastError).slice(0, MAX_ERROR_LENGTH) } : {}),
  };
}
function normalizeSubscription(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const status = ["pending", "usable", "expired", "invalid"].includes(raw.status) ? raw.status : "pending";
  return {
    status,
    ...(typeof raw.authenticated === "boolean" ? { authenticated: raw.authenticated } : {}),
    ...(typeof raw.usable === "boolean" ? { usable: raw.usable } : {}),
    ...(typeof raw.expired === "boolean" ? { expired: raw.expired } : {}),
    ...(typeof raw.hasAccountId === "boolean" ? { hasAccountId: raw.hasAccountId } : {}),
    ...(number(raw.expiresInHours) !== undefined ? { expiresInHours: number(raw.expiresInHours) } : {}),
    ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}),
    ...(raw.usage && typeof raw.usage === "object" ? { usage: { ...raw.usage } } : {}),
  };
}
function normalizeAccount(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const state = ["active", "paused", "revoked"].includes(raw.state) ? raw.state : "active";
  const identity = normalizeIdentity(raw.identity);
  const subscription = normalizeSubscription(raw.subscription);
  return {
    id,
    state,
    paused: raw.paused === true,
    priority: integer(raw.priority, 50, { min: 0, max: 100_000 }),
    ...(text(raw.label) ? { label: text(raw.label).slice(0, 120) } : {}),
    ...(iso(raw.createdAt) ? { createdAt: iso(raw.createdAt) } : {}),
    ...(identity ? { identity } : {}),
    ...(subscription ? { subscription } : {}),
    ...(raw.fallback !== undefined ? { fallback: normalizeFallbackObservation(raw.fallback) } : {}),
    health: normalizeHealth(raw.health),
    turns: integer(raw.turns, 0),
    requests: integer(raw.requests, 0),
  };
}
function emptyState() {
  return {
    version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION,
    policy: normalizePolicy(),
    accounts: {},
    sessions: {},
    explicitSwitchUsable: true,
    affinityQuarantine: null,
  };
}
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function invalidPoolState(reason) {
  throw new Error(`The saved ChatGPT account list is invalid: ${reason}.`);
}

function validatePersistedState(raw) {
  if (!plainObject(raw)) invalidPoolState("the document root must be an object");
  if (raw.version !== CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION) {
    invalidPoolState(`unsupported schema version ${String(raw.version)}`);
  }
  if (!plainObject(raw.policy)) invalidPoolState("policy must be an object");
  if (typeof raw.policy.enabled !== "boolean" || raw.policy.mode !== "switch") {
    invalidPoolState("policy is malformed");
  }
  if (
    raw.policy.selectedAccountId !== undefined
    && !isChatGPTAccountId(raw.policy.selectedAccountId)
  ) invalidPoolState("the selected account id is malformed");
  if (!plainObject(raw.accounts)) invalidPoolState("accounts must be an object");
  const entries = Object.entries(raw.accounts);
  if (entries.length > MAX_ACCOUNTS) invalidPoolState(`more than ${MAX_ACCOUNTS} accounts are present`);
  for (const [id, account] of entries) {
    if (!isChatGPTAccountId(id) || !plainObject(account) || account.id !== id) {
      invalidPoolState("an account record is malformed");
    }
    if (!["active", "paused", "revoked"].includes(account.state)) {
      invalidPoolState(`account ${id} has an invalid state`);
    }
    if (typeof account.paused !== "boolean" || !Number.isFinite(account.priority)) {
      invalidPoolState(`account ${id} has invalid routing metadata`);
    }
    if (!plainObject(account.health) || !["healthy", "cooldown", "reauth-required", "failed"].includes(account.health.state)) {
      invalidPoolState(`account ${id} has invalid health metadata`);
    }
    if (!Number.isFinite(account.turns) || !Number.isFinite(account.requests)) {
      invalidPoolState(`account ${id} has invalid counters`);
    }
    if (account.identity !== undefined && !normalizeIdentity(account.identity)) {
      invalidPoolState(`account ${id} has an invalid identity`);
    }
    if (account.subscription !== undefined && !plainObject(account.subscription)) {
      invalidPoolState(`account ${id} has invalid subscription metadata`);
    }
  }
  if (
    raw.policy.selectedAccountId !== undefined
    && !Object.hasOwn(raw.accounts, raw.policy.selectedAccountId)
  ) invalidPoolState("the selected account is not registered");
  return raw;
}

export function normalizeState(raw) {
  const result = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  result.policy = normalizePolicy(raw.policy);
  for (const [id, value] of Object.entries(raw.accounts || {}).slice(0, MAX_ACCOUNTS)) {
    if (!ACCOUNT_ID.test(id)) continue;
    const account = normalizeAccount(value, id);
    if (account) result.accounts[id] = account;
  }
  const sessions = normalizeAffinitySessions(raw.sessions);
  if (sessions === undefined) {
    result.sessions = quarantinedAffinitySessions(raw.sessions);
    result.affinityQuarantine = result.sessions.quarantine;
  } else {
    result.sessions = sessions;
    result.affinityQuarantine = sessions.quarantine || null;
  }
  return result;
}
export function readChatGPTAccountPoolState(filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  assertAccountDiscoveryEnabled();
  let file;
  try {
    file = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new Error("The saved ChatGPT account list could not be inspected.", { cause: error });
  }
  if (file.isSymbolicLink() || !file.isFile()) {
    invalidPoolState("the state path is not a regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error("The saved ChatGPT account list could not be read as JSON.", { cause: error });
  }
  return normalizeState(validatePersistedState(parsed));
}
export function writeChatGPTAccountPoolState(state, filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  assertAccountDiscoveryEnabled();
  const normalized = normalizeState({ ...state, version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION });
  writePrivateJson(filePath, {
    version: normalized.version,
    policy: normalized.policy,
    accounts: normalized.accounts,
    sessions: normalized.sessions,
  }, { directoryMode: 0o700 });
  return normalized;
}

function newAccountId(state) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `acct_${randomBytes(12).toString("base64url")}`;
    if (!state.accounts[id]) return id;
  }
  throw new Error("Could not allocate a unique ChatGPT account id.");
}

function ensurePrivateAccountDirectory(target, homesDir) {
  const root = path.resolve(homesDir);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("ChatGPT account profile escaped its private home directory.");
  }
  ensureNoSymlinkParents(path.dirname(root), { label: "ChatGPT account home parent" });
  if (existsSync(root)) {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("ChatGPT account home directory is not a private directory.");
    }
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  ensureNoSymlinkParents(root, { label: "ChatGPT account home" });
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(absolute, { label: "ChatGPT account profile" });
  const accountStat = lstatSync(absolute);
  if (accountStat.isSymbolicLink() || !accountStat.isDirectory()) {
    throw new Error("ChatGPT account profile directory is not a private directory.");
  }
  chmodSync(root, 0o700);
  chmodSync(absolute, 0o700);
}

function nextAccountLabel(state) {
  const used = new Set(Object.values(state.accounts).filter((account) => account?.state !== "revoked").map((account) => {
    const match = /^ChatGPT account (\d+)$/.exec(account?.label || "");
    return match ? Number(match[1]) : undefined;
  }).filter(Number.isInteger));
  let numberValue = 1;
  while (used.has(numberValue)) numberValue += 1;
  return `ChatGPT account ${numberValue}`;
}
export function createChatGPTSubscriptionAccount({ label = "", filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const state = readChatGPTAccountPoolState(filePath);
  if (Object.values(state.accounts).filter((account) => account?.state !== "revoked").length >= MAX_ACCOUNTS) throw new Error(`The ChatGPT account list supports at most ${MAX_ACCOUNTS} accounts.`);
  const id = newAccountId(state);
  const home = chatGPTSubscriptionAccountHome(id, { homesDir });
  ensurePrivateAccountDirectory(home, homesDir);
  const account = normalizeAccount({ id, state: "active", label: text(label).slice(0, 120) || nextAccountLabel(state), createdAt: isoNow(now), subscription: { status: "pending" }, health: { state: "healthy" } }, id);
  state.accounts[id] = account;
  try { writeChatGPTAccountPoolState(state, filePath); } catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
  return sanitizeChatGPTAccount(account);
}
export function chatGPTSubscriptionAccountHome(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) { return path.join(homesDir, accountId(accountValue)); }
export function chatGPTSubscriptionAccountAuthPath(accountValue, options = {}) { return path.join(chatGPTSubscriptionAccountHome(accountValue, options), "auth.json"); }
export function chatGPTSubscriptionAccountCatalogDir(accountValue, options = {}) { return path.join(chatGPTSubscriptionAccountHome(accountValue, options), "router-catalog"); }
export function removeChatGPTSubscriptionAccountLocked(accountValue, {
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  selectedAccountId,
  loginLeaseIdentity,
  now = Date.now(),
  loginLeaseMaxAgeMs,
  requestLeaseIdentityProbe,
} = {}) {
  const id = accountId(accountValue);
  const state = readChatGPTAccountPoolState(filePath);
  const removed = state.accounts[id];
  if (!removed) throw new Error("Account id is not registered.");
  assertChatGPTLoginLeaseInactive(id, {
    homesDir,
    ...(loginLeaseIdentity ? { identity: loginLeaseIdentity } : {}),
    now,
    ...(loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: loginLeaseMaxAgeMs }),
  });
  assertNoActiveRequestUseLeases(id, {
    homesDir,
    ...(requestLeaseIdentityProbe ? { identityProbe: requestLeaseIdentityProbe } : {}),
    now,
  });
  delete state.accounts[id];
  if (selectedAccountId !== undefined) {
    const selected = accountId(selectedAccountId);
    const account = state.accounts[selected];
    if (!account || account.state !== "active" || account.paused) {
      throw new Error("The replacement ChatGPT account is not active.");
    }
    state.policy.selectedAccountId = selected;
  } else if (state.policy.selectedAccountId === id) {
    delete state.policy.selectedAccountId;
  }
  const root = path.resolve(homesDir);
  const home = path.resolve(chatGPTSubscriptionAccountHome(id, { homesDir }));
  ensureNoSymlinkParents(root, { label: "ChatGPT account removal root" });
  ensureNoSymlinkParents(home, { label: "ChatGPT account removal target" });
  const rootStat = lstatSync(root);
  const homeStat = lstatSync(home);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("ChatGPT account removal root is not a private directory.");
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("ChatGPT account removal target is not an owned directory.");
  }
  const realRoot = realpathSync(root);
  if (path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("ChatGPT account removal target escaped its private root.");
  }
  const tombstone = path.join(root, `.removed-${id}-${randomBytes(8).toString("hex")}`);
  // The account/publisher locks serialize router mutations, but an external
  // filesystem actor can still replace an ancestor. Revalidate the full chain
  // and realpath ownership at the destructive boundary immediately before the
  // atomic rename.
  ensureNoSymlinkParents(root, { label: "ChatGPT account removal root" });
  ensureNoSymlinkParents(home, { label: "ChatGPT account removal target" });
  if (realpathSync(root) !== realRoot || path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("ChatGPT account removal target changed during validation.");
  }
  renameSync(home, tombstone);
  let committed = false;
  try {
    const staged = lstatSync(tombstone);
    if (staged.isSymbolicLink() || !staged.isDirectory() || path.dirname(realpathSync(tombstone)) !== realRoot) {
      throw new Error("ChatGPT account removal staging target is not an owned directory.");
    }
    try {
      writeChatGPTAccountPoolState(state, filePath);
    } catch (error) {
      renameSync(tombstone, home);
      throw error;
    }
    committed = true;
  } catch (error) {
    if (existsSync(tombstone) && !existsSync(home)) {
      try { renameSync(tombstone, home); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "ChatGPT account removal staging rollback failed.");
      }
    }
    throw error;
  }
  // Pool state is committed before deletion, but only the directory we just
  // atomically staged is eligible. If its identity changes, leave a private
  // tombstone for manual cleanup rather than following an attacker path.
  if (committed) {
    try {
      const cleanup = lstatSync(tombstone);
      if (!cleanup.isSymbolicLink() && cleanup.isDirectory() && path.dirname(realpathSync(tombstone)) === realRoot) {
        rmSync(tombstone, { recursive: true, force: true });
      }
    } catch {}
  }
  return sanitizeChatGPTAccount({ ...removed, state: "revoked", paused: true });
}

export function removeChatGPTSubscriptionAccount(accountValue, options = {}) {
  const id = accountId(accountValue);
  const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
  try {
    return withChatGPTAccountPoolLockSync(
      () => withChatGPTAccountOperationLockSync(
        id,
        () => removeChatGPTSubscriptionAccountLocked(id, options),
        options,
      ),
      { filePath, ...options },
    );
  } catch (error) {
    if (/account operation lock (root|account home)/i.test(error?.message || "")) {
      throw new Error("ChatGPT account removal target is not an owned private directory.", { cause: error });
    }
    throw error;
  }
}

function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch { return undefined; }
}
function tokenEmail(idToken) {
  try {
    const payload = String(idToken || "").split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = typeof claims?.email === "string" ? claims.email.trim() : "";
    return email.length <= 320 && EMAIL.test(email) ? email : undefined;
  } catch { return undefined; }
}
function readSubscriptionSession(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const authPath = chatGPTSubscriptionAccountAuthPath(accountValue, { homesDir });
  if (!existsSync(authPath)) return undefined;
  try {
    const file = lstatSync(authPath);
    if (file.isSymbolicLink() || !file.isFile()) return undefined;
    if (!privateFileIsProtected(authPath)) return undefined;
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    if (!accessToken || accessToken.length > 64 * 1024 || /[\u0000-\u001f\u007f]/.test(accessToken)) return undefined;
    const accountIdValue = typeof tokens?.account_id === "string" ? tokens.account_id : "";
    const expiresAtMs = tokenExpiryMs(accessToken);
    const expired = expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= now;
    const email = tokenEmail(tokens?.id_token);
    return { accessToken, accountId: accountIdValue, expiresAtMs, expired, ...(email ? { email } : {}) };
  } catch { return undefined; }
}

export function hardenChatGPTSubscriptionAccountAuth(accountValue, {
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  protect = protectPrivateFile,
  isProtected = privateFileIsProtected,
} = {}) {
  const id = accountId(accountValue);
  const home = chatGPTSubscriptionAccountHome(id, { homesDir });
  const authPath = chatGPTSubscriptionAccountAuthPath(id, { homesDir });
  ensurePrivateAccountDirectory(home, homesDir);
  ensureNoSymlinkParents(home, { label: "ChatGPT account profile" });
  const before = lstatSync(authPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("The ChatGPT account login profile is not a regular file.");
  }
  if (!isProtected(authPath)) protect(authPath);
  ensureNoSymlinkParents(home, { label: "ChatGPT account profile" });
  const after = lstatSync(authPath);
  if (after.isSymbolicLink() || !after.isFile() || !isProtected(authPath)) {
    throw new Error("The ChatGPT account login profile is not owner-only.");
  }
  if (!readSubscriptionSession(id, { homesDir })) {
    throw new Error("The ChatGPT account login profile is invalid after hardening.");
  }
  return authPath;
}
export function chatGPTSubscriptionAccountStatus(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  assertAccountDiscoveryEnabled();
  const session = readSubscriptionSession(accountValue, { homesDir, now });
  return {
    authenticated: Boolean(session), usable: Boolean(session) && !session.expired, expired: Boolean(session?.expired), hasAccountId: Boolean(session?.accountId),
    ...(session?.email ? { email: session.email } : {}),
    expiresInHours: session?.expiresAtMs === undefined ? undefined : Math.round(((session.expiresAtMs - now) / 36e5) * 10) / 10,
  };
}
export async function claimChatGPTSubscriptionRefresh(accountValue, {
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  force = false,
  now = Date.now(),
} = {}) {
  const id = accountId(accountValue);
  return withChatGPTAccountPoolLock(
    () => claimChatGPTSubscriptionRefreshLocked(id, { filePath, force, now }),
    { filePath },
  );
}

function claimChatGPTSubscriptionRefreshLocked(id, { filePath, force, now }) {
  const state = readChatGPTAccountPoolState(filePath);
  const account = state.accounts[id];
  if (!account || account.state !== "active" || account.paused) return false;
  const attemptedAt = Date.parse(account.health?.lastRefreshAttemptAt || "");
  if (!force && Number.isFinite(attemptedAt) && now - attemptedAt < ACCOUNT_REFRESH_RETRY_MS) return false;
  account.health = { ...account.health, lastRefreshAttemptAt: isoNow(now) };
  writeChatGPTAccountPoolState(state, filePath);
  return true;
}

export async function refreshChatGPTSubscriptionAccount(accountValue, {
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  force = false,
  now = Date.now(),
  binary,
  platform = process.platform,
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  refreshTimeoutMs = ACCOUNT_REFRESH_TIMEOUT_MS,
  terminationGraceMs = 2_000,
  createLoginLease = createChatGPTLoginLease,
  attachLoginLease = attachChatGPTLoginLease,
  clearLoginLease = clearChatGPTLoginLease,
  finalizeLogin,
  requestLeaseIdentityProbe,
  switchPath,
} = {}) {
  assertAccountDiscoveryEnabled();
  const id = accountId(accountValue);
  const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
  const expiresSoon = status.expiresInHours !== undefined && status.expiresInHours * 36e5 <= ACCOUNT_REFRESH_MARGIN_MS;
  if (!force && !status.expired && !expiresSoon) return false;
  const resolvedBinary = binary || findCodexBinary();
  if (!resolvedBinary) return false;
  let reservedLease;
  try {
    reservedLease = await withChatGPTAccountPoolLock(
      () => withChatGPTAccountOperationLock(id, () => {
        assertNoChatGPTProfileSwitchReservation({ switchPath });
        assertNoActiveRequestUseLeases(id, {
          homesDir,
          ...(requestLeaseIdentityProbe ? { identityProbe: requestLeaseIdentityProbe } : {}),
          now,
        });
        if (!claimChatGPTSubscriptionRefreshLocked(id, { filePath, force, now })) return undefined;
        return createLoginLease(id, process.pid, { homesDir, phase: "reserved" });
      }, { homesDir }),
      { filePath },
    );
  } catch {
    return false;
  }
  if (!reservedLease) return false;
  const target = spawnableCommand(resolvedBinary, ["login", "status"], platform);
  return new Promise((resolve) => {
    let lease = reservedLease;
    let child;
    let childFinished = false;
    let leaseReady = false;
    let attachmentFailed = false;
    let finalizationStarted = false;
    let settled = false;
    let timeout;
    let terminationDeadline;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finish = async () => {
      if (!leaseReady || !childFinished || finalizationStarted) return;
      finalizationStarted = true;
      clearTimeout(timeout);
      clearTimeout(terminationDeadline);
      try {
        if (attachmentFailed && !chatGPTLoginAuthChanged(id, lease, { homesDir })) {
          clearLoginLease(id, lease, { homesDir });
          settle(false);
          return;
        }
        const finalize = finalizeLogin
          || (await import("./chatgpt-profile-switch.mjs")).finalizeChatGPTProfileLogin;
        await finalize(id, {
          filePath,
          homesDir,
          expectedLoginLease: lease,
          clearLoginLease,
        });
        settle(true);
      } catch {
        settle(false);
      }
    };
    try {
      child = spawnImpl(
        target.command,
        target.args,
        {
          ...target.options,
          env: { ...process.env, CODEX_HOME: chatGPTSubscriptionAccountHome(id, { homesDir }) },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const childDone = () => {
        if (childFinished) return;
        childFinished = true;
        void finish();
      };
      // Spawn errors are delivered on a later tick. Own that event before any
      // synchronous process-identity attachment can throw, or ENOENT becomes
      // an unhandled EventEmitter error after the reservation catch returns.
      child.once("error", childDone);
      child.once("close", childDone);
      lease = attachLoginLease(id, lease, child?.pid, { homesDir });
      leaseReady = true;
      void finish();
      timeout = setTimeout(() => {
        const terminated = terminateRefreshProcessTree(child, {
          viaShell: Boolean(target.options.windowsVerbatimArguments),
          platform,
          execFileSyncImpl,
        });
        if (!terminated) {
          child.unref?.();
          settle(false);
          return;
        }
        terminationDeadline = setTimeout(() => {
          if (childFinished) return;
          if (!(target.options.windowsVerbatimArguments && platform === "win32")) {
            try { child.kill?.("SIGKILL"); } catch {}
          }
          // Keep the exact lease. A late close will still finalize it, while
          // the caller is released from a child that ignored termination.
          child.unref?.();
          settle(false);
        }, terminationGraceMs);
      }, refreshTimeoutMs);
    } catch {
      if (child) {
        attachmentFailed = true;
        leaseReady = true;
        const terminated = terminateRefreshProcessTree(child, {
          viaShell: Boolean(target.options.windowsVerbatimArguments),
          platform,
          execFileSyncImpl,
        });
        if (terminated) {
          terminationDeadline = setTimeout(() => {
            if (childFinished) return;
            if (!(target.options.windowsVerbatimArguments && platform === "win32")) {
              try { child.kill?.("SIGKILL"); } catch {}
            }
            child.unref?.();
            settle(false);
          }, terminationGraceMs);
          void finish();
          return;
        }
        child.unref?.();
      }
      if (lease && !child) {
        try {
          if (!chatGPTLoginAuthChanged(id, lease, { homesDir })) {
            clearLoginLease(id, lease, { homesDir });
          }
        } catch {}
      }
      clearTimeout(timeout);
      clearTimeout(terminationDeadline);
      settle(false);
    }
  });
}
export async function refreshBoundedChatGPTSubscriptionAccounts(pool, {
  refresh = refreshChatGPTSubscriptionAccount,
  probeLimit = ACCOUNT_REFRESH_POLL_LIMIT,
  concurrency = ACCOUNT_REFRESH_POLL_CONCURRENCY,
} = {}) {
  if (!pool?.accounts || typeof refresh !== "function") return pool;
  const selectedId = pool.policy?.selectedAccountId;
  const candidates = Object.values(pool.accounts)
    .filter((account) => account?.subscription?.usable === true)
    .sort((left, right) => Number(right.id === selectedId) - Number(left.id === selectedId))
    .slice(0, Math.max(0, Math.floor(probeLimit)));
  let cursor = 0;
  const workerCount = Math.min(candidates.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const account = candidates[cursor++];
      await refresh(account.id);
    }
  }));
  return pool;
}
export function chatGPTSubscriptionAccountPoolSnapshot({
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  now = Date.now(),
  loginLeaseIdentity,
  loginLeaseMaxAgeMs,
} = {}) {
  assertAccountDiscoveryEnabled();
  const state = readChatGPTAccountPoolState(filePath);
  const sanitized = sanitizeChatGPTAccountPool(state);
  for (const [id, account] of Object.entries(sanitized.accounts)) {
    const loginLease = chatGPTLoginLeaseStatus(id, {
      homesDir,
      ...(loginLeaseIdentity ? { identity: loginLeaseIdentity } : {}),
      ...(loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: loginLeaseMaxAgeMs }),
      now,
    });
    if (loginLease.active) {
      account.subscription = {
        ...(account.subscription || {}),
        status: "pending",
        authenticated: false,
        usable: false,
        expired: false,
        hasAccountId: false,
        loginInProgress: true,
        ...(loginLease.attentionRequired === true ? { attentionRequired: true } : {}),
      };
      continue;
    }
    const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
    account.subscription = { ...(account.subscription || {}), status: status.usable ? "usable" : status.expired ? "expired" : status.authenticated ? "invalid" : "pending", ...status };
  }
  return sanitized;
}
export function sanitizeChatGPTAccount(account) {
  if (!account) return null;
  return {
    id: account.id, state: account.state, paused: account.paused === true, priority: account.priority,
    ...(account.label ? { label: account.label } : {}), ...(account.createdAt ? { createdAt: account.createdAt } : {}),
    ...(account.subscription ? { subscription: { ...account.subscription } } : {}),
    health: { ...account.health, ...(account.health?.lastError ? { lastError: "[redacted]" } : {}) }, turns: account.turns, requests: account.requests,
  };
}
export function sanitizeChatGPTAccountPool(state) {
  const normalized = normalizeState(state);
  return {
    version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION, policy: { ...normalized.policy },
    accounts: Object.fromEntries(Object.entries(normalized.accounts).map(([id, account]) => [id, sanitizeChatGPTAccount(account)])), sessions: {},
  };
}

// Read-only strict-priority candidates for the native request path. This
// intentionally accepts only accounts whose persisted observation is ready
// and no more than seven days old; the request path performs a fresh
// protected-auth attestation before sending.
export function eligibleChatGPTFallbackAccounts({
  pool,
  primaryAccountId,
  now = Date.now(),
  subscriptionStatus,
} = {}) {
  const state = normalizeState(pool);
  if (state.policy.fallback?.enabled !== true) return [];
  return Object.values(state.accounts)
    .filter((account) => account.identity?.accountId && account.identity.accountId !== primaryAccountId)
    .filter((account) => account.state === "active" && account.paused !== true)
    .filter((account) => account.health?.state === "healthy")
    .filter((account) => {
      if (account.subscription?.status === "usable") return true;
      if (typeof subscriptionStatus !== "function") return false;
      try { return subscriptionStatus(account.id)?.usable === true; } catch { return false; }
    })
    .filter((account) => account.fallback?.enabled !== false)
    .filter((account) => account.fallback?.catalog?.state === "ready")
    .filter((account) => {
      const capturedAt = Date.parse(account.fallback?.catalog?.capturedAt || "");
      return Number.isFinite(capturedAt)
        && capturedAt <= now
        && now - capturedAt <= FALLBACK_CATALOG_MAX_AGE_MS;
    })
    .filter((account) => {
      const cooldown = Date.parse(account.fallback?.quota?.cooldownUntil || "");
      return !Number.isFinite(cooldown) || cooldown <= now;
    })
    .sort((left, right) => Number(left.priority) - Number(right.priority) || left.id.localeCompare(right.id))
    .slice(0, state.policy.fallback.maxHops);
}
export async function withChatGPTAccountPoolLock(operation, { filePath = CHATGPT_ACCOUNT_POOL_PATH, waitMs = 120_000, retryMs = 25, staleMs = 10 * 60_000 } = {}) {
  assertAccountDiscoveryEnabled();
  const lockTarget = `${filePath}.pool-lock`;
  const lockPath = `${lockTarget}.lock`;
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let release;
  try {
    release = await lockfile.lock(lockTarget, { realpath: false, lockfilePath: lockPath, stale: Math.max(2_000, staleMs), retries: { retries, factor: 1, minTimeout: retryMs, maxTimeout: retryMs, randomize: false } });
    return await operation();
  } finally { if (release) await release().catch(() => {}); }
}

function withChatGPTAccountPoolLockSync(operation, { filePath = CHATGPT_ACCOUNT_POOL_PATH, staleMs = 10 * 60_000 } = {}) {
  assertAccountDiscoveryEnabled();
  const lockTarget = `${filePath}.pool-lock`;
  const lockPath = `${lockTarget}.lock`;
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let release;
  try {
    release = lockfile.lockSync(lockTarget, {
      realpath: false,
      lockfilePath: lockPath,
      stale: Math.max(2_000, staleMs),
      update: false,
      retries: 0,
    });
    return operation();
  } finally {
    if (release) {
      try { release(); } catch {}
    }
  }
}
