import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { STATE_DIR } from "./paths.mjs";

// Kimi K3's Chat Completions API is the only supported quota-fallback target
// for this router. The slug is fixed rather than user-suppliable so a stale
// or hand-edited state file can never point a live quota event at a model
// this build no longer registers.
export const QUOTA_FALLBACK_MODEL = "kimi-api/kimi-k3";
export const QUOTA_FALLBACK_STATE_PATH =
  process.env.MODEL_ROUTER_QUOTA_FALLBACK_STATE ||
  path.join(STATE_DIR, "quota-fallback.json");

function disabled() {
  return { version: 1, enabled: false, model: QUOTA_FALLBACK_MODEL };
}

export function readQuotaFallbackSettings() {
  if (!existsSync(QUOTA_FALLBACK_STATE_PATH)) return disabled();
  try {
    const value = JSON.parse(readFileSync(QUOTA_FALLBACK_STATE_PATH, "utf8"));
    const model = typeof value?.model === "string" ? value.model.trim() : "";
    if (
      value?.version !== 1 ||
      typeof value.enabled !== "boolean" ||
      model !== QUOTA_FALLBACK_MODEL
    ) {
      return disabled();
    }
    return { version: 1, enabled: value.enabled, model };
  } catch {
    return disabled();
  }
}

function assertFixedTarget(model) {
  const slug = String(model || "").trim();
  const route = MODEL_BY_SLUG.get(slug);
  if (slug !== QUOTA_FALLBACK_MODEL || route?.provider !== "kimi-api") {
    throw new Error(`Quota fallback target must be ${QUOTA_FALLBACK_MODEL}.`);
  }
  return slug;
}

function writeSettings(settings) {
  const stateDir = path.dirname(QUOTA_FALLBACK_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${QUOTA_FALLBACK_STATE_PATH}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    protectPrivateFile(temporary);
    renameSync(temporary, QUOTA_FALLBACK_STATE_PATH);
    protectPrivateFile(QUOTA_FALLBACK_STATE_PATH);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw error;
  }
  return settings;
}

export function setQuotaFallback(model) {
  return writeSettings({ version: 1, enabled: true, model: assertFixedTarget(model) });
}

export function disableQuotaFallback() {
  return writeSettings({ version: 1, enabled: false, model: QUOTA_FALLBACK_MODEL });
}
