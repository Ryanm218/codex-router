// Single source of truth for turning a provider's registered baseUrl plus an
// optional allowlisted environment override into the URL actually used for a
// request. API forwarding, model discovery, and account-usage balance checks
// all resolved this inline and slightly differently before; a whitespace-only
// override, for example, used to slip through as a broken URL in one of the
// three. Centralizing keeps all three call sites aligned by construction.
export function resolveProviderBaseUrl(provider, environment = process.env) {
  const override = provider?.baseUrlEnv
    ? String(environment[provider.baseUrlEnv] || "").trim()
    : "";
  return String(override || provider?.baseUrl || "").replace(/\/+$/, "");
}
