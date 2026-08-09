import { MODEL_BY_SLUG, providerForModel } from "./model-registry.mjs";
import { readNativeRedirect } from "./native-redirect.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import { QUOTA_FALLBACK_MODEL, readQuotaFallbackSettings } from "./quota-fallback-state.mjs";
import { recentQuotaFallbackEvent } from "./usage-events.mjs";

const READINESS_HINTS = {
  "target-not-registered": "Update or reinstall a router build that contains kimi-api/kimi-k3.",
  "provider-not-selected": "Enable kimi-api. Regional endpoints use KIMI_API_BASE_URL.",
  "credential-missing": "No Kimi Platform API key found. Run ./bin/provider-key kimi-api set.",
};

function narrowLastOutcome() {
  const event = recentQuotaFallbackEvent();
  if (!event) return null;
  return {
    at: event.at,
    outcome: event.outcome,
    ...(Number.isInteger(event.status) ? { status: event.status } : {}),
  };
}

// Provider readiness is independent of `enabled` so a caller (the tray, the
// doctor) can explain why an off toggle cannot yet be turned on. Never read
// or return the endpoint override value itself; only name KIMI_API_BASE_URL
// in the hint.
export function quotaFallbackStatus() {
  const settings = readQuotaFallbackSettings();
  const fallbackRoute = MODEL_BY_SLUG.get(QUOTA_FALLBACK_MODEL);
  const targetRegistered = Boolean(fallbackRoute && fallbackRoute.provider === "kimi-api");
  const fallbackProvider = targetRegistered ? providerForModel(fallbackRoute) : undefined;
  const providerSelected =
    targetRegistered && readProviderSelection().includes(fallbackRoute.provider);
  const credentialReady =
    providerSelected &&
    Boolean(fallbackProvider) &&
    Boolean(resolveProviderCredential(fallbackProvider, { persistent: true }));

  const readiness = !targetRegistered
    ? "target-not-registered"
    : !providerSelected
      ? "provider-not-selected"
      : !credentialReady
        ? "credential-missing"
        : "ready";

  return {
    enabled: settings.enabled,
    model: QUOTA_FALLBACK_MODEL,
    providerReady: credentialReady,
    readiness,
    readinessHint: READINESS_HINTS[readiness] ?? null,
    nativeRedirectPrecedence: Boolean(readNativeRedirect()),
    lastOutcome: narrowLastOutcome(),
  };
}

export function quotaFallbackDoctorCheck(snapshot = quotaFallbackStatus()) {
  const precedence = snapshot.enabled && snapshot.nativeRedirectPrecedence
    ? "; native redirect takes precedence, so automatic quota fallback is paused"
    : "";
  if (!snapshot.enabled) {
    return {
      status: "ok",
      name: "Quota fallback",
      detail: "off",
      fix: "Run ./bin/control quota-fallback set kimi-api/kimi-k3 after Kimi is ready.",
    };
  }
  const fix = snapshot.readiness === "credential-missing"
    ? "Run ./bin/provider-key kimi-api set."
    : snapshot.readiness === "provider-not-selected"
      ? "Run ./bin/providers enable kimi-api."
      : snapshot.readiness === "target-not-registered"
        ? "Update or reinstall a router build that contains kimi-api/kimi-k3."
        : "Inspect ./bin/control quota-fallback status --json.";
  return {
    status: snapshot.providerReady ? "ok" : "warn",
    name: "Quota fallback",
    detail: snapshot.providerReady
      ? `enabled; Kimi K3 ready${precedence}`
      : `enabled but ${snapshot.readiness}; ${snapshot.readinessHint} ${fix}${precedence}`,
    fix,
  };
}
