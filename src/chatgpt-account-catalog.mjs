import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import {
  chatGPTSubscriptionAccountCatalogDir,
  chatGPTSubscriptionAccountHome,
  readChatGPTAccountPoolState,
  withChatGPTAccountPoolLock,
  writeChatGPTAccountPoolState,
} from "./chatgpt-account-pool.mjs";
import { findCodexBinary } from "./codex-binary.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import { withChatGPTAccountOperationLock } from "./chatgpt-account-operation-lock.mjs";
import { assertChatGPTLoginLeaseInactive } from "./chatgpt-login-lease.mjs";
import { assertNoActiveRequestUseLeases } from "./chatgpt-request-use-lease.mjs";

const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const FALLBACK_CATALOG_FILENAME = "fallback-native-models.json";

function validCatalog(value) {
  return Boolean(value)
    && Array.isArray(value.models)
    && value.models.length > 0
    && value.models.every((model) => typeof model?.slug === "string" && model.slug.trim());
}

function catalogGeneration(catalog) {
  return createHash("sha256")
    .update(JSON.stringify(catalog.models))
    .digest("base64url");
}

function recordObservation(accountId, observation, { filePath, now }) {
  return withChatGPTAccountPoolLock(() => {
    const state = readChatGPTAccountPoolState(filePath);
    const account = state.accounts[accountId];
    if (!account) return false;
    account.fallback = {
      enabled: account.fallback?.enabled !== false,
      quota: account.fallback?.quota || { state: "unknown" },
      catalog: {
        ...(account.fallback?.catalog || {}),
        ...observation,
        lastAttemptAt: new Date(now).toISOString(),
      },
    };
    writeChatGPTAccountPoolState(state, filePath);
    return true;
  }, { filePath });
}

/**
 * Capture a backup profile's exact native catalog without touching the active
 * CODEX_HOME. The child receives only its isolated account home and its
 * stdout is treated as untrusted bounded JSON; no auth material is persisted.
 */
export async function captureChatGPTAccountCatalog(accountId, {
  filePath,
  homesDir,
  binary = findCodexBinary(),
  spawn = spawnSync,
  now = Date.now(),
  timeoutMs = 30_000,
} = {}) {
  let outcome;
  let failure;
  await withChatGPTAccountOperationLock(accountId, async () => {
    const home = chatGPTSubscriptionAccountHome(accountId, { homesDir });
    const catalogDir = chatGPTSubscriptionAccountCatalogDir(accountId, { homesDir });
    try {
      assertChatGPTLoginLeaseInactive(accountId, { homesDir });
      assertNoActiveRequestUseLeases(accountId, { homesDir });
      if (!binary) throw new Error("Codex binary unavailable.");
      const target = spawnableCommand(binary, ["debug", "models"], process.platform);
      const result = spawn(target.command, target.args, {
        ...target.options,
        cwd: home,
        env: { ...process.env, CODEX_HOME: home },
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_CATALOG_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      if (result.error || result.status !== 0) throw result.error || new Error("Codex catalog probe failed.");
      const catalog = JSON.parse(String(result.stdout || ""));
      if (!validCatalog(catalog)) throw new Error("Codex returned an invalid native catalog.");
      const generation = catalogGeneration(catalog);
      writePrivateJson(path.join(catalogDir, FALLBACK_CATALOG_FILENAME), {
        version: 1,
        generation,
        capturedAt: new Date(now).toISOString(),
        models: catalog.models,
      }, { directoryMode: 0o700 });
      outcome = { generation, path: path.join(catalogDir, FALLBACK_CATALOG_FILENAME) };
    } catch (error) {
      failure = error;
    }
  }, { homesDir });
  await recordObservation(accountId, outcome
    ? { state: "ready", generation: outcome.generation, capturedAt: new Date(now).toISOString(), lastResult: "ok" }
    : { state: "missing", lastResult: failure?.code === "chatgpt_account_request_in_use" ? "request-in-use" : "probe-failed" },
  { filePath, now });
  return outcome;
}

export function accountCatalogIsReady(accountId, { homesDir } = {}) {
  const target = path.join(
    chatGPTSubscriptionAccountCatalogDir(accountId, { homesDir }),
    FALLBACK_CATALOG_FILENAME,
  );
  try {
    const stat = lstatSync(target);
    return stat.isFile() && privateFileIsProtected(target);
  } catch {
    return false;
  }
}
