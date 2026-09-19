function envNonNegativeInt(env, name, fallback) {
  const parsed = Number(env?.[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export const DEFAULT_EMPTY_COMPLETION_PRELUDE_MS = 30_000;
// Grok 4.6 routinely thinks past 30s before a client-visible token. Measured
// 2026-09-19: first-token p95 35s, max 73s, 45 unrepairable empty-completion
// 502s on the 30s default. Other providers keep the short hold.
export const DEFAULT_GROK_EMPTY_COMPLETION_PRELUDE_MS = 90_000;

export function emptyCompletionPreludeMs(provider, env = process.env) {
  if (provider === "grok-oauth") {
    return envNonNegativeInt(
      env,
      "CODEX_ROUTER_GROK_EMPTY_COMPLETION_PRELUDE_MS",
      DEFAULT_GROK_EMPTY_COMPLETION_PRELUDE_MS,
    );
  }
  return envNonNegativeInt(
    env,
    "CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS",
    DEFAULT_EMPTY_COMPLETION_PRELUDE_MS,
  );
}
