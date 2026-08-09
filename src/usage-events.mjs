import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

export const USAGE_EVENTS_PATH = path.join(STATE_DIR, "usage-events.jsonl");

function safeText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function safeTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

export function recordUsageEvent({
  model,
  provider,
  status,
  durationMs,
  inputTokens,
  outputTokens,
  totalTokens,
  at = Date.now(),
}) {
  const event = {
    meteringVersion: 1,
    at: new Date(at).toISOString(),
    model: safeText(model, "unknown"),
    provider: safeText(provider, "unknown"),
    status: Number.isInteger(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    ...(safeTokenCount(inputTokens) !== undefined
      ? { inputTokens: safeTokenCount(inputTokens) }
      : {}),
    ...(safeTokenCount(outputTokens) !== undefined
      ? { outputTokens: safeTokenCount(outputTokens) }
      : {}),
    ...(safeTokenCount(totalTokens) !== undefined
      ? { totalTokens: safeTokenCount(totalTokens) }
      : {}),
  };
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(USAGE_EVENTS_PATH, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(USAGE_EVENTS_PATH, 0o600);
  } catch {
    // Usage telemetry must never interrupt or fail a model request.
  }
}

export function recentUsageEvents({ sinceMs = 24 * 60 * 60 * 1000, limit = 1_000 } = {}) {
  if (!existsSync(USAGE_EVENTS_PATH)) return [];
  const cutoff = Date.now() - sinceMs;
  try {
    return readFileSync(USAGE_EVENTS_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      // Fallback-control rows share this file but are not model usage. They
      // must be excluded before the result limit is applied, or a burst of
      // them can evict a real model-usage row from the returned window.
      .filter((event) => event && event.eventKind !== "quota-fallback")
      .slice(-Math.max(1, limit))
      .filter(
        (event) =>
          typeof event.at === "string" &&
          Date.parse(event.at) >= cutoff &&
          typeof event.model === "string" &&
          typeof event.provider === "string",
      )
      .map((event) => {
        const inputTokens = safeTokenCount(event.inputTokens);
        const outputTokens = safeTokenCount(event.outputTokens);
        const totalTokens = safeTokenCount(event.totalTokens);
        return {
          ...(event.meteringVersion === 1 ? { meteringVersion: 1 } : {}),
          at: event.at,
          model: safeText(event.model, "unknown"),
          // Historical events may carry a protocol-variant provider id; fold
          // the whole family into its canonical provider so usage stays one
          // series per subscription.
          provider: canonicalProviderId(safeText(event.provider, "unknown")),
          status: Number.isInteger(event.status) ? event.status : 0,
          durationMs: Number.isFinite(event.durationMs)
            ? Math.max(0, Math.round(event.durationMs))
            : 0,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
        };
      });
  } catch {
    return [];
  }
}

// Quota fallback (native-fallback-policy.mjs / router.mjs) records its
// outcomes as a separate event kind in this same JSONL stream. It is
// control telemetry, not model usage: recentUsageEvents excludes it above,
// and a successful Kimi response is metered separately through the normal
// recordUsageEvent path so usage is attributed exactly once.
const FALLBACK_OUTCOMES = new Set([
  "succeeded",
  "failed",
  "stream-failed",
  "target-unavailable",
  "skipped-nonportable",
  "skipped-cooldown",
  "aborted",
]);

export function recordQuotaFallbackEvent({
  nativeProvider,
  nativeModel,
  fallbackProvider,
  fallbackModel,
  errorClass,
  outcome,
  status,
  durationMs,
  at = Date.now(),
} = {}) {
  if (!FALLBACK_OUTCOMES.has(outcome)) return;
  const event = {
    eventKind: "quota-fallback",
    at: new Date(at).toISOString(),
    nativeProvider: safeText(nativeProvider, "unknown"),
    nativeModel: safeText(nativeModel, "unknown"),
    fallbackProvider: safeText(fallbackProvider, "unknown"),
    fallbackModel: safeText(fallbackModel, "unknown"),
    errorClass: safeText(errorClass, "unknown"),
    outcome,
    ...(Number.isInteger(status) ? { status } : {}),
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
  };
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(USAGE_EVENTS_PATH, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(USAGE_EVENTS_PATH, 0o600);
  } catch {
    // Fallback telemetry must never interrupt a request either.
  }
}

export function recentQuotaFallbackEvent() {
  if (!existsSync(USAGE_EVENTS_PATH)) return null;
  try {
    const lines = readFileSync(USAGE_EVENTS_PATH, "utf8").split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (
        event?.eventKind !== "quota-fallback" ||
        typeof event.at !== "string" ||
        !FALLBACK_OUTCOMES.has(event.outcome)
      ) {
        continue;
      }
      return {
        at: event.at,
        nativeProvider: safeText(event.nativeProvider, "unknown"),
        nativeModel: safeText(event.nativeModel, "unknown"),
        fallbackProvider: safeText(event.fallbackProvider, "unknown"),
        fallbackModel: safeText(event.fallbackModel, "unknown"),
        errorClass: safeText(event.errorClass, "unknown"),
        outcome: event.outcome,
        ...(Number.isInteger(event.status) ? { status: event.status } : {}),
        durationMs: Number.isFinite(event.durationMs)
          ? Math.max(0, Math.round(event.durationMs))
          : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}
