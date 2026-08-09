# Kimi K3 Quota Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep native ChatGPT/Codex as the primary inference path and make one safe Kimi K3 attempt only after a confirmed terminal native account-quota error, with configuration and readiness exposed in the existing macOS tray.

**Architecture:** Add a protected opt-in policy state, a shared terminal-quota classifier, a bounded clone-based native-error inspector, and a fail-closed replay portability gate. Integrate them at the native non-2xx seam in `handleResponses`, reuse one factored routed-request preparation path for Kimi, preserve the untouched native response whenever fallback cannot safely start, and expose sanitized state through control, doctor, and SwiftUI.

**Tech Stack:** Node.js 22.19+ ESM, native `node:test`, WHATWG `fetch`/`Response`, LiteLLM's existing Responses-to-Chat bridge, Swift 5.10+/SwiftUI, Swift Package Manager, macOS launchd.

## Global Constraints

- The production-code merge base is Codex Router `0.4.0-beta.2` at `16800ee39dc4499e3769fd2886f8ea93eb00ac9b`; design/plan commits sit above it on branch `feat/kimi-quota-fallback`.
- The approved design is `docs/superpowers/specs/2026-08-09-kimi-quota-fallback-design.md`; its independent gate returned `FABLE_DESIGN: PASS` on 2026-08-09.
- Repository default stays off. The only supported fallback target is `kimi-api/kimi-k3`; upstream model is `kimi-k3`.
- Only a classified terminal quota error may switch. Generic 429/`Retry-After`, context/session budget, entitlement, authentication, 5xx, network, timeout, safety, and abort failures stay native.
- Fallback is allowed only for ordinary `/responses` with an explicit replayable `input` array and no opaque native state. Compact routes, `compaction_trigger`, unreadable compaction, Fernet-shaped native state, and native reasoning ciphertext fail closed.
- Never switch after any response byte or semantic event has reached Codex. Never replay after a Kimi stream begins.
- A Kimi HTTP 2xx is not yet a successful switch. Prime its body before committing headers or cancelling the saved native response; if it ends or throws before the first non-empty byte, return the untouched native status, safe headers, and body bytes. One failed Kimi attempt arms a 30-second in-memory digest guard for that exact decoded request, route, and native model.
- Do not store or log prompt text, response text, error bodies, headers, response IDs, encrypted payloads, or credentials. The Kimi key never enters chat, argv, logs, Codex config, tracked files, or plan artifacts.
- The global default endpoint is `https://api.moonshot.ai/v1`. `KIMI_API_BASE_URL` remains the explicit regional override and must survive background-service rendering without its value appearing in diagnostics.
- The existing `native-redirect` policy has precedence. When it is configured, quota fallback is paused for native turns even if that redirect target is stale.
- No Kimi/OpenAI live call, smoke test, or forced-quota request without a separate user approval. All implementation tests use temporary state and loopback mocks.
- Full Xcode is not installed on this Mac. Swift and Command Line Tools exist, but successful Swift build/test and rendered UI acceptance are gates, not assumptions.
- The AI-harness final Fable review must pass after fresh tests and before any production implementation commit or push. Therefore Tasks 1-8 end at verified red/green checkpoints; Task 9 creates the single production commit after the final review.
- Preserve the pre-existing untracked `.agents/` directory. Never stage it.

## File Map

Create:

- `src/quota-fallback-state.mjs` — protected atomic policy persistence only.
- `src/native-fallback-policy.mjs` — portability, safe clone, and failed-attempt digest guard.
- `src/quota-fallback-status.mjs` — privacy-safe readiness/last-outcome projection and doctor row.
- `src/provider-endpoint.mjs` — one base-URL resolver shared by forwarding, discovery, and account usage.
- `test/quota-fallback-state.test.mjs` — state schema, protection, and stale-state behavior.
- `test/native-fallback-policy.test.mjs` — portability, cloning, and exact 30-second guard.
- `test/quota-fallback-status.test.mjs` — readiness, precedence, sanitized outcome, and doctor projection.
- `apps/macos/ModelRouterTray/Sources/QuotaFallbackSettings.swift` — decodable snapshot and pure tray presentation state.
- `apps/macos/ModelRouterTray/Tests/QuotaFallbackSettingsTests.swift` — Swift decoding, command, rollback, busy, copy, and accessibility tests.

Modify:

- `src/error-translation.mjs` — export one entitlement-first failure classifier and reuse it for gateway translation.
- `src/http-utils.mjs` — inspect a bounded response clone without consuming the original.
- `src/usage-events.mjs` — append/read a separate sanitized control-event kind in the existing JSONL stream while excluding it from model usage.
- `src/router.mjs` — factor routed preparation and add quota-only fallback at the native non-2xx seam.
- `src/control.mjs` — `quota-fallback status|set|off` and optional `modelSettings.quotaFallback` probe field.
- `src/doctor.mjs` — scoped `Quota fallback` OK/WARN row.
- `config/kimi/kimi.json` — global `.ai` default.
- `src/api-forwarder.mjs`, `src/model-discovery.mjs`, `src/provider-account-usage.mjs` — shared endpoint resolution.
- `src/service-macos.mjs`, `src/service-linux.mjs`, `src/service-windows.mjs` — allowlisted `KIMI_API_BASE_URL` propagation.
- `apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift` — store command, optional snapshot field, and Settings row.
- `apps/macos/ModelRouterTray/Package.swift` — Swift test target.
- `test/error-translation.test.mjs`, `test/pipe-response.test.mjs`, `test/usage-events.test.mjs`, `test/routing.test.mjs`, `test/router-resilience.test.mjs`, `test/control.test.mjs`, `test/registry.test.mjs`, `test/provider-account-usage.test.mjs`, `test/service-render.test.mjs` — local regression coverage.
- `CHANGELOG.md`, `README.md`, `docs/HOW-IT-WORKS.md`, `docs/INSTALL.md`, `docs/MACOS-TRAY.md`, `docs/TROUBLESHOOTING.md` — operator contract, migration, UI, and rollback.

---

### Task 1: Protected quota-fallback policy state

**Files:**
- Create: `src/quota-fallback-state.mjs`
- Create: `test/quota-fallback-state.test.mjs`

**Interfaces:**
- Consumes: `STATE_DIR`, `protectPrivateFile`, `MODEL_BY_SLUG`.
- Produces:
  - `QUOTA_FALLBACK_MODEL = "kimi-api/kimi-k3"`
  - `QUOTA_FALLBACK_STATE_PATH`
  - `readQuotaFallbackSettings() -> {version:1, enabled:boolean, model:string}`
  - `setQuotaFallback(model:string) -> settings`
  - `disableQuotaFallback() -> settings`

- [ ] **Step 1: Write the failing state tests**

Create `test/quota-fallback-state.test.mjs` with temporary `MODEL_ROUTER_STATE_DIR` set before the dynamic module import. Pin these assertions:

```js
test("quota fallback defaults to disabled with the fixed Kimi target", () => {
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
});

test("quota fallback round-trips through protected atomic state", () => {
  assert.deepEqual(setQuotaFallback("kimi-api/kimi-k3"), {
    version: 1,
    enabled: true,
    model: "kimi-api/kimi-k3",
  });
  assert.equal(privateFileIsProtected(QUOTA_FALLBACK_STATE_PATH), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(QUOTA_FALLBACK_STATE_PATH).mode & 0o777, 0o600);
  }
  assert.deepEqual(disableQuotaFallback(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
});

test("quota fallback rejects every target except Kimi K3 API", () => {
  for (const slug of ["", "gpt-5.6-sol", "kimi-oauth/k3", "deepseek/deepseek-v4-pro"] ) {
    assert.throws(() => setQuotaFallback(slug), /kimi-api\/kimi-k3/);
  }
});

test("a state file naming any target except the fixed Kimi slug fails closed", () => {
  writeFileSync(
    QUOTA_FALLBACK_STATE_PATH,
    JSON.stringify({ version: 1, enabled: true, model: "removed/model" }),
    { mode: 0o600 },
  );
  assert.deepEqual(readQuotaFallbackSettings(), {
    version: 1,
    enabled: false,
    model: "kimi-api/kimi-k3",
  });
});
```

Also assert absent/corrupt/wrong-version/non-boolean/wrong-model state returns the disabled fixed-target default. Task 6 tests `target-not-registered` by keeping this valid fixed slug in state while injecting a registry that omits the model; configuration state itself never accepts an arbitrary target.

- [ ] **Step 2: Run the state test and verify RED**

Run:

```bash
node --test test/quota-fallback-state.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/quota-fallback-state.mjs`.

- [ ] **Step 3: Implement the protected state module**

Follow the atomic pattern in `native-redirect.mjs`, but persist `enabled` explicitly and never return a path from the public reader:

```js
export const QUOTA_FALLBACK_MODEL = "kimi-api/kimi-k3";
export const QUOTA_FALLBACK_STATE_PATH =
  process.env.MODEL_ROUTER_QUOTA_FALLBACK_STATE ||
  path.join(STATE_DIR, "quota-fallback.json");

const disabled = () => ({
  version: 1,
  enabled: false,
  model: QUOTA_FALLBACK_MODEL,
});

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

export function setQuotaFallback(model) {
  return writeSettings({ version: 1, enabled: true, model: assertFixedTarget(model) });
}

export function disableQuotaFallback() {
  return writeSettings({ version: 1, enabled: false, model: QUOTA_FALLBACK_MODEL });
}
```

`writeSettings` must create the parent directory as `0700`, write a same-directory temporary file as `0600`, call `protectPrivateFile` before and after `renameSync`, and remove the temporary file on failure.

- [ ] **Step 4: Run the state test and verify GREEN**

Run:

```bash
node --test test/quota-fallback-state.test.mjs
git diff --check
```

Expected: all state tests PASS; no whitespace errors.

- [ ] **Step 5: Record the verified checkpoint without committing production code**

Run `git status --short` and confirm only the Task 1 files plus the already tracked design/plan work are present. Do not stage or commit; the final Fable gate in Task 9 must precede the production commit.

---

### Task 2: Shared quota classifier, bounded inspection, portability, and digest guard

**Files:**
- Create: `src/native-fallback-policy.mjs`
- Create: `test/native-fallback-policy.test.mjs`
- Modify: `src/error-translation.mjs:28-170`
- Modify: `src/http-utils.mjs:30-145`
- Modify: `test/error-translation.test.mjs`
- Modify: `test/pipe-response.test.mjs`

**Interfaces:**
- Consumes: JSON-native response bodies and ordinary Responses request objects.
- Produces:
  - `classifyUpstreamFailure({status, bodyText}) -> {kind, detail, structured, errorType?}`
  - `inspectResponseText(response, {maxBytes}) -> {complete:true,text}|{complete:false}`
  - `primeResponseBody(response) -> {started:true,response}|{started:false}`
  - `nativeFallbackPortability({pathname,payload}) -> {ok:true}|{ok:false,reason}`
  - `cloneNativePayloadForFallback(payload) -> object`
  - `createFallbackFailureGuard({guardMs, now, maxEntries})`

- [ ] **Step 1: Write classifier and response-inspection tests**

Extend `test/error-translation.test.mjs`:

```js
test("classifyUpstreamFailure gives entitlement precedence over quota wording", () => {
  const result = classifyUpstreamFailure({
    status: 403,
    bodyText: JSON.stringify({
      error: {
        type: "insufficient_quota",
        message: "Your Go plan does not include API access. Upgrade to Provider or higher.",
      },
    }),
  });
  assert.equal(result.kind, "entitlement");
});

test("classifyUpstreamFailure separates quota from transient rate limiting", () => {
  assert.equal(classifyUpstreamFailure({
    status: 429,
    bodyText: JSON.stringify({ error: { type: "insufficient_quota", message: "quota exhausted" } }),
  }).kind, "quota");
  assert.equal(classifyUpstreamFailure({
    status: 429,
    bodyText: JSON.stringify({ error: { message: "Rate limit exceeded: 10 requests per minute" } }),
  }).kind, "rate-limit");
  assert.equal(classifyUpstreamFailure({
    status: 429,
    bodyText: JSON.stringify({ error: { type: "usage_limit_exceeded", message: "" } }),
  }).kind, "quota");
});

test("classifyUpstreamFailure never treats a 401 as quota", () => {
  assert.equal(classifyUpstreamFailure({
    status: 401,
    bodyText: JSON.stringify({
      error: { type: "insufficient_quota", message: "invalid API key; quota unavailable" },
    }),
  }).kind, "other");
  assert.equal(classifyUpstreamFailure({
    status: 403,
    bodyText: JSON.stringify({
      error: {
        type: "invalid_authentication_error",
        message: "Authentication failed; quota information is unavailable.",
      },
    }),
  }).kind, "other");
});

test("classifyUpstreamFailure marks only JSON objects as structured", () => {
  assert.equal(classifyUpstreamFailure({
    status: 429,
    bodyText: "quota exhausted",
  }).structured, false);
  assert.equal(classifyUpstreamFailure({
    status: 429,
    bodyText: '{"error":',
  }).structured, false);
  assert.equal(classifyUpstreamFailure({
    status: 429,
    bodyText: JSON.stringify({ error: { type: "insufficient_quota" } }),
  }).structured, true);
});
```

Extend `test/pipe-response.test.mjs` so a small custom `Response` remains byte-readable after inspection, and a response larger than 64 KiB returns `{complete:false}` while its original body remains byte-identical and readable. Add priming tests: an empty body returns `{started:false}`; a stream that throws before its first chunk rejects; and a successful prime returns a replacement response whose bytes exactly equal the original stream, including the primed first chunk.

- [ ] **Step 2: Write policy and guard tests**

Create `test/native-fallback-policy.test.mjs` with exact cases:

```js
const portablePayload = {
  model: "gpt-5.6-sol",
  previous_response_id: "resp_native",
  client_metadata: { workspace: "private" },
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
};

test("native fallback accepts a complete ordinary Responses replay", () => {
  assert.deepEqual(nativeFallbackPortability({ pathname: "/responses", payload: portablePayload }), { ok: true });
});

test("native fallback rejects compact, missing replay, and opaque native state", () => {
  const cases = [
    { pathname: "/responses/compact", payload: portablePayload, reason: "unsupported-endpoint" },
    { pathname: "/responses", payload: { model: "gpt-5.6-sol", input: "first turn" }, reason: "missing-replay" },
    { pathname: "/responses", payload: { ...portablePayload, input: [{ type: "compaction_trigger" }] }, reason: "compaction-state" },
    { pathname: "/responses", payload: { ...portablePayload, input: [{ type: "reasoning", encrypted_content: "gAAAAAopaque=" }] }, reason: "opaque-native-state" },
    { pathname: "/responses", payload: { ...portablePayload, input: [{ type: "reasoning", encrypted_content: "genuine-openai-encrypted-content" }] }, reason: "opaque-native-state" },
  ];
  for (const item of cases) {
    assert.deepEqual(nativeFallbackPortability(item), { ok: false, reason: item.reason });
  }
});

test("fallback clone strips OpenAI continuation fields without mutating native input", () => {
  const clone = cloneNativePayloadForFallback(portablePayload);
  assert.equal(clone.previous_response_id, undefined);
  assert.equal(clone.client_metadata, undefined);
  assert.deepEqual(clone.input, portablePayload.input);
  clone.input[0].role = "assistant";
  assert.equal(portablePayload.input[0].role, "user");
});
```

Use a fake clock for the guard. Assert the same SHA-256 key is blocked at 29,999 ms, opens at exactly 30,000 ms, distinct request bytes are not blocked, success clears the key, and oldest entries are pruned at the configured maximum.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
node --test test/error-translation.test.mjs
node --test test/pipe-response.test.mjs test/native-fallback-policy.test.mjs
```

Expected: missing exports/module failures.

- [ ] **Step 4: Factor the classifier without changing translation behavior**

Export this single classifier and make `translateGatewayError` consume it:

```js
export function classifyUpstreamFailure({ status, bodyText }) {
  const parsed = parseUpstreamError(bodyText);
  const detail = extractUpstreamDetail(bodyText);
  const result = (kind) => ({
    kind,
    detail,
    structured: parsed.structured,
    ...(parsed.type ? { errorType: parsed.type } : {}),
  });
  if (status < 500 && isPlanEntitlement(detail)) {
    return result("entitlement");
  }
  if (status === 401 || (status === 403 && isAuthenticationFailure(detail, parsed.type))) {
    return result("other");
  }
  if (status < 500 && isOutOfUsage(detail, parsed.type)) {
    return result("quota");
  }
  if (status === 429) return result("rate-limit");
  return result("other");
}
```

Make `parseUpstreamError` return `structured: true` only when parsing yields a non-array JSON object; raw text, scalars, arrays, and malformed JSON remain useful detail for gateway translation but get `structured: false`. Add a small `isAuthenticationFailure` predicate for authentication/API-key error types and details so 403 authentication takes precedence over quota-like wording, while the existing Kimi OAuth 403 usage-limit regression remains quota. Expand the existing quota type check just enough to recognize `usage_limit_exceeded` in addition to its existing quota/billing/resource-exhausted forms. Pass `classification.kind` into `describeFailure` or branch on it there; do not leave a second entitlement/quota pattern path.

- [ ] **Step 5: Implement clone-based bounded response inspection**

Add `MAX_INSPECTED_ERROR_BYTES = 64 * 1024` and read only `response.clone()`:

```js
export async function inspectResponseText(
  response,
  { maxBytes = MAX_INSPECTED_ERROR_BYTES } = {},
) {
  let reader;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return { complete: true, text: "" };
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { complete: false };
      }
      chunks.push(Buffer.from(value));
    }
    return { complete: true, text: Buffer.concat(chunks).toString("utf8") };
  } catch {
    if (reader) void reader.cancel().catch(() => {});
    return { complete: false };
  }
}
```

Do not await cancellation of an oversized tee branch; the untouched original branch has not started draining yet.

Add `primeResponseBody(response)`. Acquire the original body's reader and read until the first non-empty chunk. Return `{started:false}` if the body ends first. On the first byte, create a replacement `ReadableStream` that enqueues that chunk, pumps the remaining reader without buffering the full response, forwards cancellation to the reader, and preserves the original status, status text, and headers in a replacement `Response`. Let pre-first-byte read/abort errors reject so the router can distinguish an aborted client from a failed fallback. This helper never writes to the client; it only establishes that Kimi has real output ready.

- [ ] **Step 6: Implement portability, clone, and digest guard**

`nativeFallbackPortability` must accept only `/responses` and `/v1/responses`, require an `input` array, reject any `compaction_trigger`, reject a `compaction` whose `encrypted_content` is not router-owned `kcr1:`, reject every non-empty `encrypted_content` on a `type: "reasoning"` item regardless of its encoding, and recursively reject Fernet-shaped native agent state matching `^gAAAAA[A-Za-z0-9_-]+={0,2}$` elsewhere. `cloneNativePayloadForFallback` uses `structuredClone` and deletes only root `previous_response_id` and `client_metadata`.

The guard interface is:

```js
const guard = createFallbackFailureGuard({ guardMs: 30_000, now: () => Date.now(), maxEntries: 256 });
const key = guard.keyFor({ decodedBody, pathname, nativeModel });
guard.isBlocked(key);
guard.recordFailure(key);
guard.clear(key);
```

`keyFor` hashes the decoded request bytes, pathname, and native model with SHA-256. The map stores only the digest and expiry, prunes expired entries on access, and removes oldest entries beyond 256.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
node --test test/error-translation.test.mjs
node --test test/pipe-response.test.mjs test/native-fallback-policy.test.mjs
npm run check
git diff --check
```

Expected: all focused tests and static checks PASS.

- [ ] **Step 8: Record the verified checkpoint without committing production code**

Run `git status --short`; do not stage or commit.

---

### Task 3: Sanitized fallback-control events in the existing local stream

**Files:**
- Modify: `src/usage-events.mjs:1-96`
- Modify: `test/usage-events.test.mjs`

**Interfaces:**
- Consumes: terminal fallback outcomes from Task 4/5.
- Produces:
  - `recordQuotaFallbackEvent(event) -> void`
  - `recentQuotaFallbackEvent() -> safe event|null`
  - `recentUsageEvents()` continues returning model-usage events only.

- [ ] **Step 1: Write failing event-isolation tests**

Add a test that records one model event and one fallback event containing extra hostile fields:

```js
recordQuotaFallbackEvent({
  nativeProvider: "openai",
  nativeModel: "gpt-5.6-sol",
  fallbackProvider: "kimi-api",
  fallbackModel: "kimi-api/kimi-k3",
  errorClass: "terminal-quota",
  outcome: "skipped-nonportable",
  status: 429,
  durationMs: 18,
  prompt: "must-not-persist",
  bodyText: "must-not-persist",
});

assert.equal(recentUsageEvents().length, 1);
assert.deepEqual(recentQuotaFallbackEvent(), {
  at: recentQuotaFallbackEvent().at,
  nativeProvider: "openai",
  nativeModel: "gpt-5.6-sol",
  fallbackProvider: "kimi-api",
  fallbackModel: "kimi-api/kimi-k3",
  errorClass: "terminal-quota",
  outcome: "skipped-nonportable",
  status: 429,
  durationMs: 18,
});
assert.equal(readFileSync(USAGE_EVENTS_PATH, "utf8").includes("must-not-persist"), false);
```

Also assert an unknown outcome is rejected without writing a line, and the file remains `0600`. Write more fallback-control rows than the reader's result limit around a valid model-usage row, then assert that row is still returned: filtering must occur before the model-usage limit is applied.

- [ ] **Step 2: Run the event test and verify RED**

Run:

```bash
node --test test/usage-events.test.mjs
```

Expected: missing export failures.

- [ ] **Step 3: Implement the separate event kind**

Use the same `usage-events.jsonl`, but write `eventKind: "quota-fallback"`. Permit only these outcomes:

```js
const FALLBACK_OUTCOMES = new Set([
  "succeeded",
  "failed",
  "stream-failed",
  "target-unavailable",
  "skipped-nonportable",
  "skipped-cooldown",
  "aborted",
]);
```

`recentUsageEvents` must filter out `eventKind === "quota-fallback"` before applying its result limit or returning events to `provider-usage.mjs`; control events must never evict model usage from the window. `recentQuotaFallbackEvent` reads only the most recent validated fallback kind. Reject unknown outcomes, persist only allowlisted fields and bounded strings, and never accept a spread of caller-owned fields.

- [ ] **Step 4: Run the event tests and verify GREEN**

Run:

```bash
node --test test/usage-events.test.mjs test/provider-usage.test.mjs
git diff --check
```

Expected: model request counts remain unchanged and fallback outcomes are available separately.

- [ ] **Step 5: Record the verified checkpoint without committing production code**

Run `git status --short`; do not stage or commit.

---

### Task 4: Integrate the portable quota fallback at the native response seam

**Files:**
- Modify: `src/router.mjs:450-1268`
- Modify: `test/routing.test.mjs:558-600, 2745-2828`

**Interfaces:**
- Consumes: Tasks 1-3 state, classifier, inspector, portability, guard, and event APIs.
- Produces internal:
  - `prepareRoutedRequest({request,payload,route,signal}) -> {target,headers,body,collaborationFlattened}`
  - native success/non-quota behavior unchanged.
  - portable terminal quota -> one `kimi-api/kimi-k3` attempt.

- [ ] **Step 1: Add the failing native-success and portable-quota routing tests**

Use the existing `mockServer`, `run`, `waitFor`, and `routerBase` helpers. In a temporary state directory, write:

```js
writeFileSync(
  path.join(stateDir, "enabled-providers.json"),
  JSON.stringify({ version: 1, providers: ["kimi-api"] }),
  { mode: 0o600 },
);
writeFileSync(path.join(stateDir, "kimi-api-key.secret"), "TEST_KIMI_KEY\n", { mode: 0o600 });
writeFileSync(
  path.join(stateDir, "quota-fallback.json"),
  JSON.stringify({ version: 1, enabled: true, model: "kimi-api/kimi-k3" }),
  { mode: 0o600 },
);
```

Test A: native returns 200; assert body/status unchanged and `gatewayRequests.length === 0`.

Test B: native returns 429 with `error.type = "insufficient_quota"`; send an explicit input array plus `previous_response_id` and `client_metadata`; gateway returns a mock 200 Responses payload. Assert:

```js
assert.equal(response.status, 200);
assert.equal(nativeRequests.length, 1);
assert.equal(gatewayRequests.length, 1);
assert.equal(gatewayRequests[0].model, "kimi-api-k3");
assert.deepEqual(gatewayRequests[0].input, requestPayload.input);
assert.equal(gatewayRequests[0].previous_response_id, undefined);
assert.equal(gatewayRequests[0].client_metadata, undefined);
assert.equal(requestPayload.previous_response_id, "resp_native");
```

Also retain the existing direct external Responses assertion that provider-owned `previous_response_id` is not globally stripped.

- [ ] **Step 2: Run the happy-path routing tests and verify RED**

Run:

```bash
node --test --test-name-pattern='quota fallback|previous_response_id' test/routing.test.mjs
```

Expected: native quota remains 429 and the gateway receives zero requests.

- [ ] **Step 3: Extract one non-mutating routed preparation helper**

Move the current routed input/vision/tool-flatten/model rewrite into:

```js
async function prepareRoutedRequest({ request, payload, route, signal }) {
  const input = await bridgeVisionInput(
    await normalizeRoutedAgentInput(request, payload.input, signal),
    route,
    signal,
  );
  const provider = providerForModel(route);
  const flattened = provider?.protocol === "openai-responses"
    ? { flattened: false, tools: payload.tools }
    : flattenCollaborationNamespaceTools(payload.tools);
  const routed = {
    ...payload,
    model: route.gatewayModel,
    input: flattened.flattened ? flattenCollaborationHistory(input) : input,
    ...(flattened.flattened ? { tools: flattened.tools } : {}),
  };
  delete routed.client_metadata;
  if (provider?.keyless) {
    delete routed.reasoning;
    delete routed.reasoning_effort;
  }
  return {
    target: `${GATEWAY_BASE}/responses`,
    headers: routedHeaders(),
    body: Buffer.from(JSON.stringify(routed), "utf8"),
    collaborationFlattened: flattened.flattened,
  };
}
```

Do not mutate `payload.tools`. Replace the existing direct routed branch with this helper before adding fallback.

- [ ] **Step 4: Add the native non-2xx decision seam**

Read the policy only for a native non-success response. If disabled, pipe immediately exactly as before. If enabled:

1. Skip fallback if `readNativeRedirect()` returns any configured slug.
2. Inspect a bounded clone and require `classifyUpstreamFailure(...).kind === "quota"`.
3. Resolve the fixed Kimi route and require selected provider plus persistent credential readiness.
4. Require `nativeFallbackPortability({pathname: requestUrl.pathname, payload}).ok`.
5. Build the digest key from decoded request `body`, pathname, and requested native model.
6. Deep-clone/strip native continuation fields, prepare through `prepareRoutedRequest`, then fetch once with the shared abort signal.

Use mutable `effectiveRoute`, `effectiveUpstream`, and `collaborationFlattened` variables only after the native fetch returns. Call `activity.setRoute` with Kimi immediately before the Kimi fetch:

```js
activity.setRoute({
  provider: canonicalProviderId(fallbackRoute.provider),
  model: fallbackRoute.slug,
  routeCause: "quota-fallback",
  fallbackFromProvider: "openai",
  fallbackFromModel: requestedModel,
  ...activityMetadataFromHeaders(request.headers),
});
```

If Kimi returns non-success, cancel its body without logging it, arm the digest guard, record a sanitized `failed` control event, and keep the untouched native response as `effectiveUpstream`. If Kimi returns success, call `primeResponseBody` before committing anything. An empty or pre-first-byte failed stream is another pre-output failure: keep the native response and arm the guard. Only `{started:true,response}` may cancel the saved native body, clear the digest guard, and become the effective route/upstream.

- [ ] **Step 5: Attribute successful usage only to Kimi**

Keep fallback-control telemetry separate from model usage. A successful Kimi stream uses the existing `ResponseUsageTransform` and records exactly one model event under `kimi-api/kimi-k3`. A terminal native quota attempt, preflight rejection, target-unavailable result, cooldown skip, or pre-output Kimi failure records only `recordQuotaFallbackEvent`; it must not create an OpenAI/Kimi model-usage row.

- [ ] **Step 6: Run the happy-path routing tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='quota fallback|previous_response_id|native redirect' test/routing.test.mjs
node --test test/usage-events.test.mjs test/provider-usage.test.mjs
npm run check
git diff --check
```

Expected: native success remains native; portable quota reaches Kimi exactly once; usage attributes only Kimi.

- [ ] **Step 7: Record the verified checkpoint without committing production code**

Run `git status --short`; do not stage or commit.

---

### Task 5: Pin every failure boundary, cooldown, abort, and stream rule

**Files:**
- Modify: `src/router.mjs:1065-1280`
- Modify: `test/routing.test.mjs:2745-2885`
- Modify: `test/router-resilience.test.mjs`

**Interfaces:**
- Consumes: Task 4 fallback path.
- Produces: byte-faithful native preservation before commit and terminal Kimi stream errors after commit.

- [ ] **Step 1: Add the failure-class matrix tests**

Table-drive native failures and assert zero Kimi calls:

```js
const nativeOnlyFailures = [
  { name: "plain 429", status: 429, body: { error: { message: "rate limit exceeded" } } },
  { name: "entitlement 403", status: 403, body: { error: { message: "plan does not include API access; upgrade your plan" } } },
  { name: "context 400", status: 400, body: { error: { type: "context_length_exceeded", message: "context window exceeded" } } },
  { name: "auth 401", status: 401, body: { error: { message: "invalid authentication" } } },
  { name: "overload 503", status: 503, body: { error: { message: "overloaded" } } },
];
```

For each case, assert returned status/body equal native and `gatewayRequests.length === 0`.

- [ ] **Step 2: Add portability and precedence tests**

Add exact tests for:

- `/responses/compact`
- trailing `compaction_trigger`
- unreadable native `compaction`
- Fernet agent payload
- Fernet reasoning ciphertext
- missing/scalar replay input
- both `native-redirect.json` and quota fallback enabled

Every portability rejection returns the original 429 and makes zero relay/gateway calls. The precedence test proves the configured native redirect wins and quota fallback never probes Kimi.

- [ ] **Step 3: Add byte-fidelity and failed-attempt guard tests**

Have native return status 429, `Retry-After: 123`, `X-Test-Native: preserved`, and a fixed non-pretty JSON byte buffer. Have Kimi return 401. Assert exact native status, both safe headers, and `Buffer.compare(received, nativeBytes) === 0`.

Send the identical decoded request twice within 30 seconds: native is contacted twice, Kimi once. Send a different input: Kimi is contacted again. Inject a short guard duration in the child environment or exported constructor test seam, advance beyond expiry, and assert the original request may attempt Kimi again.

- [ ] **Step 4: Add abort and post-commit stream tests**

Abort the client after native quota but while the Kimi mock is pending. Assert the Kimi request signal closes, no new attempt starts, the guard is not armed, and `/health` returns idle activity.

In `test/router-resilience.test.mjs`, make Kimi return 200 SSE, emit one Kimi delta, then break the stream. Assert the client receives that Kimi delta plus `local_router_stream_failed`, never the saved native quota body, and no replay occurs.

Add the complementary pre-commit case: Kimi returns 200 SSE but closes or throws before emitting any byte. Assert Codex receives the original native status, safe headers, and byte-identical body; the failed-attempt guard is armed; and no Kimi header or stream event is exposed.

- [ ] **Step 5: Run the boundary tests and verify RED**

Run:

```bash
node --test --test-name-pattern='quota fallback|native redirect configuration' test/routing.test.mjs
node --test --test-name-pattern='Kimi fallback stream' test/router-resilience.test.mjs
```

Expected: at least cooldown, byte-fidelity, abort, or stream assertions fail before hardening.

- [ ] **Step 6: Complete the fail-closed branches**

Implement one terminal outcome path for each result:

- `target-unavailable`
- `skipped-nonportable`
- `skipped-cooldown`
- `failed`
- `stream-failed`
- `aborted`
- `succeeded`

Never include upstream text in thrown/logged errors. When inspection is incomplete, classification is not quota, policy is paused, or portability is false, call `pipeResponse` on the untouched native `Response`. After Kimi headers/body begin, only the existing `endStreamedResponse` failure path may terminate the response.

- [ ] **Step 7: Run the boundary tests and verify GREEN**

Run:

```bash
node --test test/native-fallback-policy.test.mjs test/pipe-response.test.mjs
node --test --test-name-pattern='quota fallback|native redirect configuration' test/routing.test.mjs
node --test --test-name-pattern='Kimi fallback stream' test/router-resilience.test.mjs
npm run check
git diff --check
```

Expected: all boundary tests PASS with loopback mocks only.

- [ ] **Step 8: Record the verified checkpoint without committing production code**

Run `git status --short`; do not stage or commit.

---

### Task 6: Safe status, control commands, and doctor visibility

**Files:**
- Create: `src/quota-fallback-status.mjs`
- Create: `test/quota-fallback-status.test.mjs`
- Modify: `src/control.mjs:81-180, 974-1060`
- Modify: `src/doctor.mjs:390-450`
- Modify: `test/control.test.mjs`

**Interfaces:**
- Consumes: policy state, registry, provider selection, persistent credential status, native redirect, recent fallback event.
- Produces:
  - `quotaFallbackStatus() -> {enabled,model,providerReady,readiness,readinessHint:string|null,nativeRedirectPrecedence,lastOutcome}`
  - `quotaFallbackDoctorCheck(snapshot) -> {status,name,detail,fix}`
  - `bin/control quota-fallback status [--json]|set kimi-api/kimi-k3|off`
  - optional `modelSettings.quotaFallback` in probe JSON.

- [ ] **Step 1: Write readiness and doctor projection tests**

Pin this public object and no other fields:

```js
{
  enabled: false,
  model: "kimi-api/kimi-k3",
  providerReady: false,
  readiness: "provider-not-selected",
  readinessHint: "Enable kimi-api. Regional endpoints use KIMI_API_BASE_URL.",
  nativeRedirectPrecedence: false,
  lastOutcome: null,
}
```

Test readiness values `ready`, `target-not-registered`, `provider-not-selected`, and `credential-missing`; enabled+ready is doctor `ok`, off is doctor `ok`, enabled+unready is doctor `warn`. A configured native redirect sets `nativeRedirectPrecedence: true`. The last outcome includes only `at`, `outcome`, and optional integer `status`. Assert JSON never contains `path`, `source`, `secret`, a configured override value, prompt, body, or response text.

- [ ] **Step 2: Write control integration tests**

Extend the existing temporary `probe()` harness to optionally create selected-provider, protected key, fallback-state, native-redirect, and event files. Add a shared process helper and these concrete cases:

```js
function isolatedKimiRegistry(stateDir) {
  const providerDocument = JSON.parse(
    readFileSync(path.join(root, "config", "kimi", "kimi.json"), "utf8"),
  );
  const modelDocument = JSON.parse(
    readFileSync(path.join(root, "config", "kimi", "api", "kimi-k3.json"), "utf8"),
  );
  const provider = structuredClone(
    providerDocument.providers.find((item) => item.id === "kimi-api"),
  );
  provider.credential.keychainServices = [];
  delete provider.credential.cliSession;
  const registryPath = path.join(stateDir, "isolated-kimi-registry.json");
  writeFileSync(
    registryPath,
    `${JSON.stringify({ version: 1, providers: [provider], models: modelDocument.models })}\n`,
    { mode: 0o600 },
  );
  return registryPath;
}

function quotaControl(stateDir, ...command) {
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_REGISTRY: isolatedKimiRegistry(stateDir),
  };
  for (const name of ["KIMI_API_KEY", "MOONSHOT_API_KEY", "MODEL_ROUTER_SHOW_ALL_MODELS", "CODEX_ROUTER_SHOW_ALL_MODELS"]) {
    delete environment[name];
  }
  return spawnSync(process.execPath, [path.join(root, "src", "control.mjs"), ...command], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
}

function readyKimiState(t, { configuredModel } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-quota-ready-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["kimi-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "kimi-api-key.secret"), "TEST_KIMI_KEY\n", {
    mode: 0o600,
  });
  if (configuredModel) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(configuredModel)}\n`,
      { mode: 0o600 },
    );
  }
  return stateDir;
}

test("quota fallback set fails closed until Kimi is selected and credential-ready", (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-quota-not-ready-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const result = quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Enable kimi-api|API key/);
  assert.equal(existsSync(path.join(stateDir, "quota-fallback.json")), false);
});

test("quota fallback status and probe expose only the safe optional snapshot", (t) => {
  const stateDir = readyKimiState(t);
  assert.equal(quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3").status, 0);
  const status = JSON.parse(quotaControl(stateDir, "quota-fallback", "status", "--json").stdout);
  const probe = JSON.parse(quotaControl(stateDir, "--probe").stdout);
  assert.equal(status.readiness, "ready");
  assert.deepEqual(probe.modelSettings.quotaFallback, status);
  assert.doesNotMatch(JSON.stringify(status), /path|source|secret|TEST_KIMI_KEY/i);
});

test("quota fallback off leaves Kimi selected and the configured Codex model unchanged", (t) => {
  const stateDir = readyKimiState(t, { configuredModel: "gpt-5.6-sol" });
  const selectionBefore = readFileSync(path.join(stateDir, "enabled-providers.json"), "utf8");
  const configBefore = readFileSync(path.join(stateDir, "config.toml"), "utf8");
  assert.equal(quotaControl(stateDir, "quota-fallback", "set", "kimi-api/kimi-k3").status, 0);
  assert.equal(quotaControl(stateDir, "quota-fallback", "off").status, 0);
  assert.equal(readFileSync(path.join(stateDir, "enabled-providers.json"), "utf8"), selectionBefore);
  assert.equal(readFileSync(path.join(stateDir, "config.toml"), "utf8"), configBefore);
});
```

Use `spawnSync` for expected failures. The synthetic registry deliberately removes Kimi's keychain services and the child environment deletes credential/show-all variables, so no test can consult the real account. Assert the usage string is `control quota-fallback status [--json]|set kimi-api/kimi-k3|off`, and assert extra/misplaced arguments are rejected.

- [ ] **Step 3: Run status/control tests and verify RED**

Run:

```bash
node --test test/quota-fallback-status.test.mjs test/control.test.mjs
```

Expected: missing module/command/probe field failures.

- [ ] **Step 4: Implement the safe status projection**

`quotaFallbackStatus()` combines state without mutating it. Provider readiness is independent of `enabled` so the tray can explain why an off toggle cannot yet be enabled. Do not read or return the endpoint override value; only name `KIMI_API_BASE_URL` in the hint.

`quotaFallbackDoctorCheck()` returns a concrete bounded row:

```js
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
```

Put WARN remediation in `detail` because the current text doctor prints `fix` only for failures.

- [ ] **Step 5: Implement control and probe integration**

Add `modelSettings.quotaFallback = quotaFallbackStatus()` as an optional sibling to vision bridge. Implement:

```js
async function handleQuotaFallback(command) {
  const jsonStatus = command.length === 2 && command[0] === "status" && command[1] === "--json";
  const humanStatus = command.length === 0 || (command.length === 1 && command[0] === "status");
  if (humanStatus || jsonStatus) {
    const snapshot = quotaFallbackStatus();
    const last = snapshot.lastOutcome
      ? `${snapshot.lastOutcome.outcome} at ${snapshot.lastOutcome.at}`
      : "none";
    process.stdout.write(jsonStatus
      ? `${JSON.stringify(snapshot, null, 2)}\n`
      : `Quota fallback: ${snapshot.enabled ? "on" : "off"}; target ${snapshot.model}; readiness ${snapshot.readiness}; native redirect ${snapshot.nativeRedirectPrecedence ? "takes precedence" : "off"}; last outcome ${last}\n`);
    return;
  }
  if (command.length === 1 && command[0] === "off") {
    disableQuotaFallback();
    process.stdout.write(`${JSON.stringify(quotaFallbackStatus())}\n`);
    return;
  }
  if (command.length !== 2 || command[0] !== "set" || command[1] !== QUOTA_FALLBACK_MODEL) {
    throw new Error("Usage: control quota-fallback status [--json]|set kimi-api/kimi-k3|off");
  }
  const readiness = quotaFallbackStatus();
  if (!readiness.providerReady) throw new Error(readiness.readinessHint);
  setQuotaFallback(command[1]);
  process.stdout.write(`${JSON.stringify(quotaFallbackStatus())}\n`);
}
```

Dispatch with `handleQuotaFallback(args.slice(1))`. Do not call catalog refresh, apply, restart, or provider mutation.

- [ ] **Step 6: Add the doctor row and integration assertion**

Call `quotaFallbackDoctorCheck()` after provider credential checks. Add one assertion following the JSON doctor harness in `test/cli-session-credential.test.mjs`: parse stdout even if unrelated checks make the isolated doctor nonzero, then locate `checks.find(check => check.name === "Quota fallback")`. Reuse the scrubbed child environment and synthetic no-keychain registry above so the doctor cannot discover a real credential.

- [ ] **Step 7: Run status/control/doctor tests and verify GREEN**

Run:

```bash
node --test test/quota-fallback-state.test.mjs test/quota-fallback-status.test.mjs test/control.test.mjs test/cli-session-credential.test.mjs
npm run check
git diff --check
```

Expected: safe snapshots, exact control behavior, and scoped doctor row PASS.

- [ ] **Step 8: Record the verified checkpoint without committing production code**

Run `git status --short`; do not stage or commit.

---

### Task 7: Global Kimi endpoint, regional service propagation, and operator docs

**Files:**
- Create: `src/provider-endpoint.mjs`
- Modify: `config/kimi/kimi.json:16`
- Modify: `src/api-forwarder.mjs:45-60`
- Modify: `src/model-discovery.mjs:15-25`
- Modify: `src/provider-account-usage.mjs:208-220`
- Modify: `src/service-macos.mjs:40-70`
- Modify: `src/service-linux.mjs:40-70`
- Modify: `src/service-windows.mjs:30-70`
- Modify: `src/tray-service-macos.mjs:20-55`
- Modify: `test/registry.test.mjs`
- Modify: `test/provider-account-usage.test.mjs`
- Modify: `test/service-render.test.mjs`
- Modify: `CHANGELOG.md`, `README.md`, `docs/HOW-IT-WORKS.md`, `docs/INSTALL.md`, `docs/MACOS-TRAY.md`, `docs/TROUBLESHOOTING.md`

**Interfaces:**
- Consumes: provider registry `baseUrl` and allowlisted `baseUrlEnv`.
- Produces: `resolveProviderBaseUrl(provider, environment = process.env) -> normalized URL`.

- [ ] **Step 1: Write endpoint and background-service regressions**

In `test/registry.test.mjs` assert:

```js
const kimi = PROVIDERS.get("kimi-api");
assert.equal(kimi.baseUrl, "https://api.moonshot.ai/v1");
assert.equal(resolveProviderBaseUrl(kimi, {}), "https://api.moonshot.ai/v1");
assert.equal(
  resolveProviderBaseUrl(kimi, { KIMI_API_BASE_URL: "https://api.moonshot.cn/v1/" }),
  "https://api.moonshot.cn/v1",
);
const kimiBlock = renderLiteLlmConfig()
  .split(/\n(?=  - model_name: )/)
  .find((block) => block.startsWith('  - model_name: "kimi-api-k3"'));
assert.ok(kimiBlock);
assert.match(kimiBlock, /model: "openai\/kimi-api-k3"/);
assert.match(kimiBlock, /api_base: "os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL"/);
assert.match(kimiBlock, /use_chat_completions_api: true/);
```

In `test/service-render.test.mjs`, extend `render(..., extraEnv = {})` and construct its child environment with `KIMI_API_BASE_URL: ""` before spreading `extraEnv`. Pass a fixed `KIMI_API_BASE_URL=https://regional.invalid/v1` and assert the macOS router, Linux router, Windows router, and macOS tray output contains that exact allowlisted value. Render again with the empty default and assert the variable is absent. Never inherit a machine value implicitly in the test.

In `test/provider-account-usage.test.mjs`, assert the global default selects `https://api.moonshot.ai/v1/users/me/balance` and the router's host-based display convention labels the result in USD. A `.cn` override must select `https://api.moonshot.cn/v1/users/me/balance` and the existing display convention must label it CNY. The balance response itself has no currency field; test URL selection and display mapping separately through an injected `fetchImpl`.

- [ ] **Step 2: Run endpoint tests and verify RED**

Run:

```bash
node --test test/registry.test.mjs test/provider-account-usage.test.mjs test/service-render.test.mjs
```

Expected: `.cn` default and missing shared resolver/service propagation fail.

- [ ] **Step 3: Implement one endpoint resolver and use it everywhere**

Create:

```js
export function resolveProviderBaseUrl(provider, environment = process.env) {
  const override = provider?.baseUrlEnv
    ? String(environment[provider.baseUrlEnv] || "").trim()
    : "";
  return String(override || provider?.baseUrl || "").replace(/\/+$/, "");
}
```

Replace the three local base-URL expressions in API forwarding, discovery, and provider account usage. Change only Kimi's checked-in default to `https://api.moonshot.ai/v1`; retain `KIMI_API_BASE_URL`, external slug, gateway model, upstream model, and credential names.

- [ ] **Step 4: Propagate only the allowlisted regional override**

In each router-service renderer add:

```js
...(process.env.KIMI_API_BASE_URL
  ? { KIMI_API_BASE_URL: process.env.KIMI_API_BASE_URL }
  : {}),
```

Add the equivalent escaped `EnvironmentVariables` entry to the macOS tray LaunchAgent so its child `bin/control` account/readiness calls resolve the same regional endpoint as the router. Do not propagate arbitrary environment variables or any API key. Service tests must inspect only their fixed synthetic URL.

- [ ] **Step 5: Update operator documentation**

Add exact documentation for:

- native-first, quota-only behavior and `quota-fallback status|set|off`
- `native-redirect` precedence
- fresh/portable task coverage and opaque-history limitation
- global `.ai` default plus `.cn` migration via `KIMI_API_BASE_URL`
- reinstall/re-render requirement for a service-level override
- menu-bar toggle states and secure key entry
- `providerReady` means only target registered, provider selected, and persistent credential present; without a live inference, K3 entitlement is unverified
- the global platform requires at least one successful $1 top-up before K3 access, while no billed validation is performed by default
- no live smoke test by default
- rollback with `bin/control quota-fallback off`

The CHANGELOG migration bullet must say existing keys are untouched. Use the canonical global K3 guide `https://platform.kimi.ai/docs/guide/kimi-k3-quickstart` where Kimi's API documentation is cited.

- [ ] **Step 6: Run endpoint/docs checks and verify GREEN**

Run:

```bash
node --test test/registry.test.mjs test/provider-account-usage.test.mjs test/service-render.test.mjs test/routing.test.mjs
npm run check
git diff --check
```

Expected: global default, regional override, service propagation, and existing Kimi normalization PASS.

- [ ] **Step 7: Record the verified checkpoint without committing production code**

Run `git status --short`; do not stage or commit.

---

### Task 8: Native macOS tray toggle, readiness, rollback, and accessibility

**Files:**
- Create: `apps/macos/ModelRouterTray/Sources/QuotaFallbackSettings.swift`
- Create: `apps/macos/ModelRouterTray/Tests/QuotaFallbackSettingsTests.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift:93-120, 1020-1170, 1667-1673, 2104-2194`
- Modify: `apps/macos/ModelRouterTray/Package.swift`

**Interfaces:**
- Consumes: optional `modelSettings.quotaFallback` JSON from Task 6.
- Produces:
  - `QuotaFallbackSnapshot`
  - `QuotaFallbackOutcomeSnapshot`
  - pure `QuotaFallbackViewState`
  - `RouterStore.setQuotaFallbackEnabled(_:)`
  - one Settings row before Providers.

- [ ] **Step 1: Add the Swift test target and failing snapshot/view-state tests**

Add:

```swift
.testTarget(
  name: "ModelRouterTrayTests",
  dependencies: ["ModelRouterTray"],
  path: "Tests"
)
```

Tests must cover:

```swift
private func view(
  enabled: Bool,
  readiness: String,
  precedence: Bool = false
) -> QuotaFallbackViewState {
  QuotaFallbackViewState(snapshot: QuotaFallbackSnapshot(
    enabled: enabled,
    model: "kimi-api/kimi-k3",
    providerReady: readiness == "ready",
    readiness: readiness,
    readinessHint: nil,
    nativeRedirectPrecedence: precedence,
    lastOutcome: nil
  ))
}

XCTAssertEqual(QuotaFallbackViewState(snapshot: nil).summary, "Unavailable · update router")
XCTAssertEqual(view(enabled: false, readiness: "ready").summary, "Off")
XCTAssertEqual(view(enabled: true, readiness: "ready").summary, "Kimi K3 · ready")
XCTAssertEqual(view(enabled: true, readiness: "credential-missing").summary, "Kimi K3 · needs API key")
XCTAssertEqual(view(enabled: true, readiness: "provider-not-selected").summary, "Kimi K3 · provider disabled")
XCTAssertEqual(view(enabled: true, readiness: "future-value").summary, "Kimi K3 · not ready")
XCTAssertEqual(view(enabled: true, readiness: "ready", precedence: true).summary, "Paused · native redirect takes precedence")
```

Also decode an older probe with no `quotaFallback` field and assert success.

- [ ] **Step 2: Add the injected-runner store tests**

Define an internal test seam:

```swift
typealias RouterControlRunner = @Sendable ([String], Data?) async throws -> Data
```

`RouterStore.shared` keeps `RouterStore()`; an internal initializer may accept a runner for tests. Script a runner that records argv and returns probe JSON. Assert exact enable args `quota-fallback set kimi-api/kimi-k3`, exact disable args `quota-fallback off`, a rapid second toggle issues no command while busy, success refreshes before setting the success message, and failure restores the prior on/off state then refreshes. Inject an error containing `SECRET_RAW_BODY`; assert `store.message` never contains that string.

- [ ] **Step 3: Run Swift tests and verify RED**

Run:

```bash
swift test --package-path apps/macos/ModelRouterTray
```

Expected: missing types/test target/store API failures.

- [ ] **Step 4: Implement the decodable and pure view state**

Create:

```swift
struct QuotaFallbackOutcomeSnapshot: Decodable, Equatable {
  let at: String
  let outcome: String
  let status: Int?
}

struct QuotaFallbackSnapshot: Decodable, Equatable {
  let enabled: Bool
  let model: String
  let providerReady: Bool
  let readiness: String
  let readinessHint: String?
  let nativeRedirectPrecedence: Bool
  let lastOutcome: QuotaFallbackOutcomeSnapshot?
}
```

Keep readiness/outcome as strings with a safe default branch so a newer router cannot break the whole tray decoder. Add optional `let quotaFallback: QuotaFallbackSnapshot?` to `ModelSettingsSnapshot`.

Expose the Codex policy safely from the store:

```swift
var quotaFallback: QuotaFallbackSnapshot? {
  snapshot.targets["codex"]?.modelSettings?.quotaFallback
}
```

`QuotaFallbackViewState` owns the exact help text:

```text
Only confirmed account-quota exhaustion can switch providers. Rate limits, context limits, partial streams, and tasks with opaque native history stay on ChatGPT.
```

It also exposes `canToggleOn`, `canToggleOff`, `summary`, `accessibilityValue`, and a sanitized failure message derived only from readiness.

Pin the failure-message mapping in the pure-state tests: absent snapshot or `target-not-registered` says `Update Codex Router before changing quota fallback.`; `credential-missing` says `Add the Kimi API key, then try again.`; `provider-not-selected` says `Enable the Kimi API provider, then try again.`; all other values say `Could not update quota fallback. No credentials were changed.` Raw process errors are never interpolated.

- [ ] **Step 5: Implement store mutation with compensation**

Add `setQuotaFallbackEnabled(_:)` beside model settings, but do not use `applyModelSettings` because fallback needs no restart/catalog refresh:

```swift
func setQuotaFallbackEnabled(_ enabled: Bool) async {
  guard providerOperation == nil else { return }
  let previous = quotaFallback
  providerOperation = "quota-fallback"
  defer { providerOperation = nil }
  do {
    _ = try await runControl(arguments: enabled
      ? ["quota-fallback", "set", "kimi-api/kimi-k3"]
      : ["quota-fallback", "off"])
    await refresh()
    message = enabled
      ? "Quota fallback enabled. ChatGPT remains primary."
      : "Quota fallback disabled. Kimi remains connected."
  } catch {
    if previous?.enabled == true {
      _ = try? await runControl(arguments: ["quota-fallback", "set", previous?.model ?? "kimi-api/kimi-k3"])
    } else {
      _ = try? await runControl(arguments: ["quota-fallback", "off"])
    }
    await refresh()
    message = QuotaFallbackViewState(snapshot: quotaFallback).sanitizedFailureMessage
  }
}
```

The compensation is normally a no-op because backend writes are atomic, but it pins rollback if a later command bridge fails after mutation.

- [ ] **Step 6: Render the dedicated Settings row**

Insert after `maintenanceRow` and before Providers. Fixed action label:

```text
Use Kimi K3 when ChatGPT quota is exhausted
```

Disable activation if the snapshot is absent or not provider-ready; always allow an already-enabled policy to be turned off. Disable all interaction while any provider operation runs and show a small progress indicator for `quota-fallback`. Add accessibility label equal to the action, value equal to the summary, hint equal to the help text, status label `Quota fallback status: <summary>`, and spinner label `Updating quota fallback`.

Do not modify island code: existing health activity already follows the provider/model that Task 4 sets during a Kimi attempt.

- [ ] **Step 7: Run Swift and Node checks and verify GREEN**

Run:

```bash
swift test --package-path apps/macos/ModelRouterTray
swift build -c debug --package-path apps/macos/ModelRouterTray
npm run check
git diff --check
```

Expected: Swift test/build and repository static checks PASS. If Command Line Tools cannot build the package, stop and report the full-Xcode requirement; do not claim tray completion.

- [ ] **Step 8: Build and inspect an isolated temporary bundle**

Use a task-specific temporary directory and:

```bash
router_ui_tmp=$(mktemp -d /private/tmp/codex-router-ui.XXXXXX)
MODEL_ROUTER_TRAY_CONFIGURATION=debug ./scripts/build-macos-tray-app.sh "$router_ui_tmp/Model Router.app"
```

Launch the temporary binary directly with temporary `CODEX_HOME`, `MODEL_ROUTER_STATE_DIR`, `MODEL_ROUTER_LAUNCH_AGENTS_DIR`, `MODEL_ROUTER_SOURCE_ROOT`, a synthetic mode-0600 Kimi key, and `KIMI_API_BASE_URL=http://127.0.0.1:9/v1`. Use loopback mock health that transitions from OpenAI idle to Kimi generating. Verify rendered missing/needs-key/ready/paused states, enable/relaunch/off persistence, failure rollback, busy state, reduced motion, accessibility labels, and activity focus. Do not use `bin/model-router-tray` for this isolated check because it installs launchd supervision.

- [ ] **Step 9: Record the verified checkpoint without committing production code**

Save screenshots/log-free observations in the task's temporary evidence directory, run `git status --short`, and do not stage or commit.

---

### Task 9: Full verification, final Fable review, single production commit, and push

**Files:**
- Review every changed path from Tasks 1-8.
- Create a task-specific final-review prompt in `/private/tmp`; do not track it.

**Interfaces:**
- Consumes: complete implementation and fresh evidence.
- Produces: one accepted `FABLE_REVIEW: PASS`, one implementation commit, and pushed feature branch.

- [ ] **Step 1: Run the complete local verification suite**

Run:

```bash
npm run check
node --test test/quota-fallback-state.test.mjs test/quota-fallback-status.test.mjs test/native-fallback-policy.test.mjs test/error-translation.test.mjs test/pipe-response.test.mjs test/usage-events.test.mjs test/control.test.mjs test/registry.test.mjs test/provider-account-usage.test.mjs test/service-render.test.mjs
node --test test/routing.test.mjs test/router-resilience.test.mjs
npm test
sh -n install.sh bin/control bin/model-router-tray scripts/build-macos-tray-app.sh
swift test --package-path apps/macos/ModelRouterTray
swift build -c release --package-path apps/macos/ModelRouterTray
git diff --check
```

Expected: every command exits zero. Do not run a live provider test.

- [ ] **Step 2: Audit scope and secret safety**

Run:

```bash
git status --short
git diff --stat
git diff -- . ':(exclude).agents/**'
```

Confirm no credential value, error body fixture copied from a real account, home path secret, generated state, build output, `.agents/`, or temporary UI artifact is tracked. Confirm the new repository default remains disabled.

- [ ] **Step 3: Run the mandatory independent Fable final review**

Create a bounded prompt containing requirements, changed paths, diff summary, fresh test results, UI evidence, and explicit read-only constraints. Run from the repository with at least a 600-second timeout:

```bash
set -o pipefail
umask 077
AUTOPUSH_REENTRANT=1 /opt/homebrew/bin/claude -p \
  --model fable \
  --permission-mode auto \
  --disallowedTools "Edit,Write,NotebookEdit" \
  < /private/tmp/kimi-quota-fallback-fable-final-prompt.md | \
  tee -a /Users/ryan/.claude/logs/fable-final-review.log
```

Accept only exit zero and exactly one standalone `FABLE_REVIEW: PASS`. A block, error, missing/contradictory sentinel, or second failed cycle stops the task without commit/push/completion claims.

- [ ] **Step 4: Stage only reviewed paths and commit once**

After PASS, stage explicit paths—not `git add .`—then verify:

```bash
git diff --cached --check
git diff --cached --name-only
git status --short
```

Confirm `.agents/` is not staged. Commit:

```bash
git commit -m "feat: add Kimi quota fallback"
```

- [ ] **Step 5: Push the reviewed feature branch**

Run:

```bash
git push -u origin feat/kimi-quota-fallback
```

If the upstream repository rejects permission, preserve the local commit and report the exact push blocker; do not force-push or change remotes without user direction.

A push-permission failure does not make the reviewed local commit unsafe. Continue the already-authorized local installation from that exact commit, but report that repository publication remains incomplete; never install from an uncommitted tree.

---

### Task 10: Secret-safe installation, persistent tray, and handoff

**Files/State:**
- Install from the reviewed checkout only.
- Mutate only router-owned fields under `~/.codex`, the protected Kimi credential path, the router/tray launch agents, and `~/Applications/Model Router.app`.
- Save the dated infra record to the Obsidian vault through its connector after acceptance.

**Interfaces:**
- Consumes: reviewed commit, user-entered Kimi key, installed Codex Desktop.
- Produces: native-primary router, Kimi provider ready, tray supervised, policy enabled, doctor evidence, rollback record.

- [ ] **Step 1: Keep vision bridge off before installation**

Run the safe control status first, then explicitly keep the bridge off:

```bash
./bin/control vision-bridge status
./bin/control vision-bridge off
```

This is independent of quota fallback and prevents an unrelated automatic image-routing change.

- [ ] **Step 2: Collect the Kimi key outside chat and argv**

Open an interactive terminal at this stable checkout and run only:

```bash
./bin/provider-key kimi-api set
```

Ryan types the key into that command's hidden prompt. Do not relay, echo, inspect, or log the value. Verify only metadata with `./bin/provider-key kimi-api status`.

- [ ] **Step 3: Install the router without the tray shortcut**

With the protected key already present and `kimi-api` selected, run:

```bash
./install.sh --auto --providers kimi-api --no-tray
./bin/model-router codex doctor
```

Do not use `--smoke-test`. Verify the install preserves ChatGPT authentication and unrelated Codex settings, service health is ready, and the `Quota fallback` doctor row is present. The policy remains off at this point.

- [ ] **Step 4: Install and supervise the native tray correctly**

Run:

```bash
./bin/model-router-tray
./bin/control tray status
```

This release build installs `~/Applications/Model Router.app`, replaces an older running tray, installs/loads `io.github.codex-router.tray`, and records its fingerprint. Do not rely on `install.sh --with-tray`; at this pinned baseline it builds/opens but does not establish the new launchd supervision.

- [ ] **Step 5: Enable fallback through the real Settings UI**

In the tray, verify `Kimi K3 · ready`, switch on **Use Kimi K3 when ChatGPT quota is exhausted**, close/reopen the tray, and confirm state persists. Read back only the safe object:

```bash
./bin/control quota-fallback status --json
```

Expected: enabled true, providerReady true, readiness `ready`, and no path/key source/value.

- [ ] **Step 6: Verify installed state without a billed request**

Run:

```bash
./bin/model-router codex doctor
./bin/control tray status
git status --short --branch
```

Confirm router/tray service identities, fallback readiness, provider activity UI, and no generated installation state entered the repository. Do not force an OpenAI quota response or call Kimi live.

- [ ] **Step 7: Record rollback and ask for the Codex restart**

Tell Ryan to fully quit/reopen Codex and start a new task; this installation task must not quit Codex itself. Document first rollback as:

```bash
./bin/control quota-fallback off
```

Disabling fallback must leave Kimi connected. Full router rollback uses the existing uninstall/config snapshot path and preserves ChatGPT authentication.

- [ ] **Step 8: Save the durable infra record and final handoff**

Through the Obsidian vault connector, save one dated note covering what changed, why, exact installed commit, safe acceptance evidence, the portable-history limitation, regional override behavior, how to disable fallback, how to uninstall, and that no live billed test was run. Update the shared handoff without overwriting unrelated active work.
