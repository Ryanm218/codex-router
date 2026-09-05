# OpenAI Account Quota Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-off, strict-priority OpenAI Codex account quota fallback, task-family affinity, per-account catalog refresh on the final Codex quit, and a final native-to-Kimi hop without exposing credentials or replaying committed responses.

**Architecture:** Extend upstream's isolated ChatGPT account profiles instead of introducing another credential owner. A closed-world policy and affinity layer selects eligible backup accounts; a shared bounded attempt context and commit-point primer allow only portable, uncommitted Responses turns to fail over; transactional catalog capture publishes each account's exact native model set and the tray triggers reconciliation only on a proven final Codex-process exit. All mutable security state is journaled, owner-bound, default-off, and recoverable before the router listens.

**Tech Stack:** Node.js ESM, `node:test`, filesystem journals and locks, HTTP/SSE/WebSocket Responses transport, Electron/React/TypeScript Control Center, Swift/AppKit macOS tray, shell and PowerShell installers.

**Spec:** `docs/superpowers/specs/2026-09-05-openai-account-quota-fallback-design.md`

## Global Constraints

- Implement from exact upstream base `5db9b314d313067a17851f6bcb20ce12fcc05e29`; do not merge or cherry-pick the obsolete branch wholesale.
- Preserve installed stable commit `9b05fff0bfe2dc4ea7b9d110bb056ae4477886cf` until tests, final Fable review, push, install, and attended non-inference acceptance all pass.
- Repository default is off. Enabling widens the local caller-key trust boundary to permit same-user task continuity across enrolled accounts and must say so in UI and docs.
- Strict priority is primary account, at most two enabled backup OpenAI accounts, then at most one existing external-model failover destination; it is never round-robin load balancing.
- Retry only authoritative terminal quota exhaustion on portable, uncommitted `/responses` turns. Do not retry ordinary 429, 5xx, network, auth, entitlement, malformed, or free-text failures.
- Never move a request after response commitment: any SSE event, WebSocket event, non-SSE body byte, or failed bounded priming commits the attempt.
- All attempts share one 30,000 ms monotonic deadline and one abort tree. Reserve every namespace before network I/O; a reservation collision sends zero upstream requests.
- Do not read, log, emit, bundle, pass in argv, or persist raw credentials. Request header snapshots exist only in memory and only after exact profile identity proof under the account lock.
- The request-use lease recovers immediately when owner death is proven. Its deadline changes only an unknown-identity diagnosis and never clears a live or unknown owner.
- Cycle-3 Fable correction 1 controls over the stale deadline-plus-death sentence in the pre-approval spec body: proven-dead request owners recover immediately. The spec header and recorded cycle-3 PASS likewise control over its stale closing pre-review sentence.
- Use one per-account operation lock at `chatgpt-accounts/<id>/router-account.lock`; lock ordering is pool lock, sorted account locks, catalog publication lock.
- Stamp the deny-only internal-transport marker on every router-originated `/responses` loopback from Cursor, Claude, Gemini, and WebSocket, and strip it from every upstream egress path.
- `fallback on` repairs a missing `selectedAccountId` only under exact active/canonical identity proof; otherwise it refuses with no mutation.
- Affinity tombstones and resolving aliases are permanent until explicit destructive reset. At the 2,048-record cap, refuse new reservations or aliases and never evict safety records.
- An invalid or unreadable sessions subtree quarantines affinity. Stateless fallback skips backup OpenAI accounts but may preserve the core-portable primary-to-Kimi path.
- Catalog capture uses the exact trusted desktop Codex binary, a managed temporary `CODEX_HOME`, writable-stdin child gating, transactional before-images, and marker-last publication of all five catalog artifacts.
- Final-Codex-quit detection is exact `{pid,startIdentity}` set tracking. Seeded zero is not an exit; only a previously armed nonempty-to-zero transition triggers reconciliation.
- Startup recovers profile-switch journals, sorted capture journals, and lifecycle state before listening; a live or unknown owner blocks startup.
- Do not quit Codex, run live inference, inspect credential contents, or automate unattended account login during verification.
- The implementation must receive a fresh independent Fable final `PASS` after fresh tests and before the single final commit, push, or install.
- One user task produces one final commit and push. Intermediate task checkpoints leave work uncommitted for controller review.
- At every task checkpoint, the controller must build a task-path-scoped review package from the working tree. `git diff` alone is insufficient: include the complete contents of every newly created task file and run `git diff --no-index --check /dev/null <new-file>` for each untracked task file before review.
- The SDD workspace and its approved-path manifest stay ignored and uncommitted. The final staged diff, rather than a broad working-tree pathspec, is the sole review and secret-scan input.

---

## File Structure and Ownership Map

### New focused modules

- `src/chatgpt-account-auth.mjs` — bounded descriptor-based ChatGPT identity attestation and in-memory request header snapshots.
- `src/chatgpt-account-operation-lock.mjs` — exact per-account lock path, acquisition, relocation-safe release, and global lock-order helper.
- `src/chatgpt-request-use-lease.mjs` — owner-bound per-request lease creation, recovery, and release.
- `src/chatgpt-account-affinity.mjs` — keyed family digests, bindings, aliases, reservations, tombstones, quarantine, cap enforcement, and epoch-aware reset transaction.
- `src/chatgpt-account-fallback.mjs` — strict-priority account eligibility, catalog gating, quota classification, and account-attempt state transitions.
- `src/failover-attempt-context.mjs` — one deadline, abort tree, and collision-free attempt namespaces shared by account and model failover.
- `src/uncommitted-response.mjs` — bounded clone-based response priming and exact response commit classification.
- `src/internal-transport.mjs` — deny-only loopback marker constants and stripping helper.
- `src/private-file-transaction.mjs` — owner-only before-image transaction used by capture and destructive reset.
- `src/chatgpt-catalog-probe-launcher.mjs` — committed stdin-gated owner process that runs all three exact Codex catalog commands inside one tracked process tree.
- `src/chatgpt-account-catalog.mjs` — exact desktop Codex probe, validation, enrichment, and per-account publication.
- `src/chatgpt-catalog-capture-journal.mjs` — crash-safe capture journal and startup recovery.
- `src/catalog-artifacts.mjs` — the five published catalog artifacts plus marker-last generation contract.
- `src/native-catalog-refresh.mjs` — lifecycle trigger/status/reconcile orchestration.
- `src/quota-fallback-migration.mjs` — idempotent legacy `quota-fallback.json` to generalized `failover.json` migration.
- `apps/macos/ModelRouterTray/Sources/CodexCatalogRefreshCoordinator.swift` — exact process transition coordinator and owned refresh-child cancellation.

### Existing modules changed at integration seams

- Account state and security: `src/chatgpt-account-pool.mjs`, `src/chatgpt-profile-switch.mjs`, `src/codex-native-session.mjs`, `src/codex-session-names.mjs`, `src/file-security.mjs`, `src/path-security.mjs`, `src/paths.mjs`.
- Routing: `src/router.mjs`, `src/model-failover.mjs`, `src/catalog.mjs`, `src/direct-responses-provider.mjs`, `src/cursor-surface.mjs`, `src/claude-surface.mjs`, `src/gemini-surface.mjs`, `src/responses-websocket.mjs`.
- Capture and lifecycle: `src/codex-binary.mjs`, `src/process-tree.mjs`, `src/windows-process-tree.ps1`, `src/start.mjs`, `src/control.mjs`, `src/control-args.mjs`.
- Operations: `src/update.mjs`, `src/doctor.mjs`, `src/support-bundle.mjs`, `bin/install`, `install.ps1`, `install.sh`.
- Control Center: `apps/control-center/electron/api.d.ts`, `apps/control-center/electron/preload.cjs`, `apps/control-center/electron/ipc.mjs`, `apps/control-center/src/types.ts`, `apps/control-center/src/App.tsx`, `apps/control-center/src/pages/SettingsPage.tsx`, `apps/control-center/test/renderer.test.mjs`.
- Tray: `apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift`, `apps/macos/ModelRouterTray/Tests/CodexCatalogRefreshCoordinatorTests.swift`, `apps/macos/ModelRouterTray/Tests/ControlContractTests.swift`.
- Documentation: `README.md`, `AGENTS.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/CHATGPT-ACCOUNT-MODES.md`, `docs/MACOS-TRAY.md`, `docs/DESKTOP-TRAY.md`, `docs/TROUBLESHOOTING.md`, `docs/INSTALL.md`.

### Test fixtures and focused suites

- Create `test/fixtures/codex/account-catalog/` with sanitized exact-operation raw-cache, enriched-catalog, incompatible-schema, and partial-publication fixtures.
- Create focused suites named for each new module; extend existing pool, switch, session, routing, failover, surface, installer, update, doctor, support-bundle, Electron, renderer, and Swift suites only at their owned seam.

---

## Pre-Implementation Evidence Baseline

- [ ] Verify this checkout is a linked worktree, not a submodule, on `feat/openai-account-quota-fallback`, with HEAD exactly `5db9b314d313067a17851f6bcb20ce12fcc05e29`.
- [ ] Run `python3 .agents/skills/repo-maintainer/scripts/repo_maintainer.py analyze --repo . --format markdown --manifest .superpowers/sdd/2026-09-05-openai-account-quota-fallback/preflight-manifest.json` before production edits. Record that its docs-only mechanical risk label is overridden to full/release by the planned credential, protocol, schema, lifecycle, installer, and cross-platform semantics.
- [ ] Run `npm ci && npm run check && npm test`. If upstream is not green, record exact failing test names and isolate each file before production edits; keep inherited failures in the ledger and require the feature not to add a new failure.
- [ ] Create the SDD ledger at `.superpowers/sdd/2026-09-05-openai-account-quota-fallback/progress.md`, including every cross-task file/interface pair and the rulings that Fable-final-before-commit means no implementer may create an intermediate commit and cycle-3 corrections control over the two stale sentences in the pre-approval spec.

| ID | Observable outcome | Initial status | Required evidence |
| --- | --- | --- | --- |
| A1 | Fallback-off native behavior is byte-equivalent and uses no account-pool I/O on ordinary primary success. | pending | Focused router tests plus full Node suite. |
| A2 | One portable primary quota result follows strict primary, two-backup, one-Kimi bounds without replay after commitment. | pending | Deterministic multi-attempt integration tests and fault injection. |
| A3 | Credentials, account IDs, family IDs, and secrets never leave protected in-memory/file boundaries. | pending | Protected-file tests, known-positive secret detector, support-bundle sentinel test, final hunk review. |
| A4 | Affinity, leases, locks, tombstones, reset, and crash recovery preserve authority under races and restart. | pending | State-machine, process-identity, lock-order, and every-boundary crash tests. |
| A5 | Each backup is eligible only under a fresh generation-verified exact account catalog; Astra survives ordinary publication. | pending | Exact-operation fixture, catalog tests, safe installed catalog inspection. |
| A6 | One armed final Codex desktop exit triggers refresh, with exact suppression, ChatGPT deferral, relaunch rollback, and persistent reconciliation. | pending | Node lifecycle tests, Swift tests, then the next ordinary user-driven quit observation. |
| A7 | Control Center exposes explicit consent, strict order, safe operations, Windows switch-only behavior, and non-optimistic destructive reset. | pending | IPC/type checks and real Playwright rendered UI tests. |
| A8 | Legacy Kimi state migrates without enabling account fallback, and unsafe downgrade is refused. | pending | Migration/update/installer tests plus installed sanitized status. |
| A9 | Linux, Windows, macOS, packaging, install, doctor, tray, and support surfaces retain their contracts. | pending | Local full/release gate plus pushed macOS/Windows/Linux CI; blocked platforms remain explicitly unverified until CI. |
| A10 | Branch, remote, stable checkout, and installed source all identify the same Fable-reviewed commit. | pending | Fable sentinel, commit/push/fetch parity, manifest/source-root checks, codesign and service/tray health. |

---

### Task 1: Closed Account Policy and Protected Identity Proof

**Files:**
- Create: `src/chatgpt-account-auth.mjs`
- Modify: `src/chatgpt-account-pool.mjs`
- Modify: `src/codex-native-session.mjs`
- Test: `test/chatgpt-account-pool.test.mjs`
- Test: `test/codex-native-session.test.mjs`
- Create: `test/chatgpt-account-auth.test.mjs`

**Interfaces:**
- Consumes: existing account-pool version-1 document and existing native session descriptor readers.
- Produces: `normalizeFallbackPolicy(value)`, `normalizeFallbackObservation(value)`, `normalizeAffinitySessions(value)`, `readProtectedChatGPTSessionDescriptor(codexHome)`, `attestChatGPTAccount({codexHome, expectedAccountId})`, and `snapshotChatGPTRequestAuth({codexHome, expectedAccountId})` returning only `{headers, accountId, sourceIdentity}` in memory.

- [ ] **Step 1: Write failing closed-world state and identity tests**

```js
test("legacy v1 pool remains switchable with fallback disabled", () => {
  const state = normalizeState({ version: 1, accounts: {}, sessions: {} });
  assert.equal(state.policy.fallback.enabled, false);
});

test("invalid sessions quarantine affinity without invalidating switching", () => {
  const state = normalizeState(fixture({ sessions: { version: 1, rogue: true } }));
  assert.equal(state.affinityQuarantine.state, "affinity-secret-invalid");
  assert.equal(state.explicitSwitchUsable, true);
});

test("API-key native descriptors cannot attest a ChatGPT account", async () => {
  await assert.rejects(
    attestChatGPTAccount({ codexHome, expectedAccountId: "acct_a" }),
    /chatgpt identity attestation required/i,
  );
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/chatgpt-account-pool.test.mjs test/codex-native-session.test.mjs test/chatgpt-account-auth.test.mjs`

Expected: FAIL because additive policy/session validation and strict ChatGPT attestation exports do not exist.

- [ ] **Step 3: Implement the closed schemas and strict attestation boundary**

```js
export function normalizeFallbackPolicy(value) {
  return closedObject(value, ["enabled", "strategy", "maxHops", "affinityTtlSeconds"], {
    enabled: false,
    strategy: "strict-priority",
    maxHops: 2,
    affinityTtlSeconds: 604800,
  });
}

export async function attestChatGPTAccount({ codexHome, expectedAccountId }) {
  const descriptor = await readProtectedChatGPTSessionDescriptor(codexHome);
  if (descriptor.authKind !== "chatgpt" || descriptor.accountId !== expectedAccountId) {
    throw new Error("ChatGPT identity attestation required");
  }
  return { accountId: descriptor.accountId, sourceIdentity: descriptor.sourceIdentity };
}
```

Keep auth parsing bounded and descriptor-based. Preserve declared additive keys on pool writes, reject unknown policy/session/fallback keys for automatic use, and never return credential material from the attestation function.

- [ ] **Step 4: Re-run the focused tests and verify GREEN**

Run: `node --test test/chatgpt-account-pool.test.mjs test/codex-native-session.test.mjs test/chatgpt-account-auth.test.mjs`

Expected: PASS, including legacy v1 compatibility, unknown-key fail-closed behavior, bounded files, symlink rejection, API-key rejection, and exact account mismatch rejection.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && git status --short`

Expected: only Task 1 paths plus approved plan/review artifacts are changed; do not commit.

### Task 2: Per-Account Operation Locks and Request-Use Leases

**Files:**
- Create: `src/chatgpt-account-operation-lock.mjs`
- Create: `src/chatgpt-request-use-lease.mjs`
- Modify: `src/chatgpt-account-pool.mjs`
- Modify: `apps/control-center/electron/ipc.mjs`
- Modify: `src/chatgpt-profile-switch.mjs`
- Create: `test/chatgpt-account-operation-lock.test.mjs`
- Create: `test/chatgpt-request-use-lease.test.mjs`
- Modify: `test/chatgpt-login-lease.test.mjs`
- Modify: `test/chatgpt-profile-switch.test.mjs`

**Interfaces:**
- Consumes: exact account-home validation and process-identity helpers.
- Produces: `withChatGPTAccountOperationLock(accountId, fn)`, `withOrderedChatGPTLocks(accountIds, fn)`, `createRequestUseLease({accountId,affinityGeneration,requestStartedWallMs})`, `recoverRequestUseLeases(accountId)`, and lease handle method `release()`.

- [ ] **Step 1: Write failing lock-order and lease-recovery tests**

```js
test("both account refresh and interactive login serialize on router-account.lock", async () => {
  assert.equal(await observedLockPath(refreshAccount), accountLockPath("acct_a"));
  assert.equal(await observedLockPath(interactiveLogin), accountLockPath("acct_a"));
});

test("proven-dead lease is recovered immediately before its deadline", async () => {
  await writeLease({ pid: deadPid, deadlineAt: futureIso });
  assert.deepEqual(await recoverRequestUseLeases("acct_a"), { cleared: 1, blocked: 0 });
});

test("unknown owner identity never clears after the deadline", async () => {
  await writeLease({ pid: livePid, startIdentity: "unknown", deadlineAt: pastIso });
  assert.equal((await recoverRequestUseLeases("acct_a")).blocked, 1);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/chatgpt-account-operation-lock.test.mjs test/chatgpt-request-use-lease.test.mjs test/chatgpt-login-lease.test.mjs test/chatgpt-profile-switch.test.mjs`

Expected: FAIL because the exact lock and request-use lease primitives do not exist.

- [ ] **Step 3: Implement exact paths, owner identity, and relocation-safe release**

```js
export const requestLeasePath = (accountHome, nonce) =>
  path.join(accountHome, "router-request-leases", `${nonce}.json`);

export async function createRequestUseLease({ accountId, affinityGeneration, requestStartedWallMs }) {
  return withChatGPTAccountPoolLock(() =>
    withChatGPTAccountOperationLock(accountId, async () => {
      await recoverRequestUseLeases(accountId);
      await assertNoActiveLoginLease(accountId);
      const deadlineAt = new Date(requestStartedWallMs + REQUEST_EXECUTION_TIMEOUT_MS + 60_000).toISOString();
      return writeOwnerOnlyLease({ accountId, affinityGeneration, deadlineAt });
    }),
  );
}
```

Lease JSON is a closed object with version, account ID, PID, process start identity, nonce, affinity generation, `createdAt`, and `deadlineAt`. Multiple ordinary requests may hold distinct live leases for the same account; lease creation recovers stale records and proves login/profile-writer exclusion but never asserts that the request-lease directory is empty. Release reopens and validates the nonce, owner PID, start identity, and account before unlinking. Profile switch, refresh, removal, and interactive login all hold the same account lock and require zero live request leases before mutation.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/chatgpt-account-operation-lock.test.mjs test/chatgpt-request-use-lease.test.mjs test/chatgpt-login-lease.test.mjs test/chatgpt-profile-switch.test.mjs`

Expected: PASS for exact lock path, sorted acquisition, concurrent same-account request leases, mutation blocked until the final live lease releases, no ABA unlink, proven-dead immediate recovery, live/unknown blocking, and login/request mutual exclusion.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/chatgpt-account-pool.test.mjs test/chatgpt-account-operation-lock.test.mjs test/chatgpt-request-use-lease.test.mjs`

Expected: PASS; do not commit.

### Task 3: Affinity, Reservations, Tombstones, and Destructive Reset

**Files:**
- Create: `src/private-file-transaction.mjs`
- Create: `src/chatgpt-account-affinity.mjs`
- Create: `src/chatgpt-affinity-enforcement-state.mjs`
- Modify: `src/chatgpt-account-pool.mjs`
- Modify: `src/file-security.mjs`
- Modify: `src/paths.mjs`
- Create: `test/private-file-transaction.test.mjs`
- Create: `test/chatgpt-account-affinity.test.mjs`
- Modify: `test/file-security.test.mjs`

**Interfaces:**
- Consumes: normalized `sessions`, pool/account locks, safe private-file primitives, process identity.
- Produces: `resolveFamilyState({rootFamily,childFamily})`, `waitForFamilyResolution({rootFamily,childFamily,timeoutMs=250,signal})`, `reserveFamily({rootFamily,accountId,context})`, `revalidateFamilyCapability(capability)`, `advanceFamilyReservation(capability,{accountId})`, `clearFamilyReservation(capability)`, `commitFamilyReservation(capability)`, `recordFamilyUse(capability,{turnId,requestSent})`, `tombstoneFamily(capability,reason)`, `bindFamilyAlias({childFamily,rootFamily,capability})`, `resetAffinity({confirmation})`, `recoverAffinityResetTransactions()`, and the process-local enforcement APIs `initializeAffinityEnforcementState(sessions)`, `refreshAffinityEnforcementStateAfterLockedPoolWrite(sessions)`, `markAffinityEnforcementUncertain()`, and `readAffinityEnforcementState()`.
- Reservation capability is exactly `{epoch,rootDigest,generation,accountId}` and only the owning attempt may commit or tombstone it.
- `resolveFamilyState` returns one closed result: unmatched, reserved, bound, tombstone, quarantine, or uncertain, resolving at most one child alias to a root and never returning secret bytes. Wait/re-read occurs outside locks exactly once. Clear, advance, commit, alias, counter touch, and tombstone are owner-only compare-and-swap operations on the exact capability; advance preserves the original `reservedUntil` and returns a fresh capability, revalidation occurs immediately before a stored-credential read/send, and counters saturate without wrap.
- The enforcement snapshot is exactly frozen `{required,uncertain}`. It is initialized before listening; invalid/unreadable session state is `{required:true,uncertain:true}`. A successful locked pool write refreshes it to `required:true` whenever any binding, alias, tombstone, or quarantine exists and to false only for proven-valid empty state.

- [ ] **Step 1: Write failing state-machine and crash-recovery tests**

```js
test("reservation capability prevents a non-owner from finalizing", async () => {
  const owner = await reserveFamily({ rootFamily: "root-a", accountId: "acct_b" });
  await assert.rejects(commitFamilyReservation({ ...owner, generation: owner.generation + 1 }), /owner/i);
});

test("cap refusal preserves all aliases and tombstones", async () => {
  const before = await seedSafetyRecords(2048);
  await assert.rejects(reserveFamily({ rootFamily: "new", accountId: "acct_b" }), /capacity/i);
  assert.deepEqual(await readSafetyRecords(), before);
});

test("disable pause revoke remove expiry and clear tombstone roots and aliases", async () => {
  for (const transition of safetyTransitions) {
    const state = await applyTransitionToBoundFamily(transition);
    assert.equal(state.root.state, "tombstone");
    assert.equal(state.child.state, "tombstone");
  }
});

test("reset rollback restores secret and pool before-images together", async () => {
  await injectResetCrash("after-secret-replace");
  await recoverAffinityResetTransactions();
  assert.deepEqual(await digestSecurityState(), originalDigest);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/private-file-transaction.test.mjs test/chatgpt-account-affinity.test.mjs test/file-security.test.mjs`

Expected: FAIL because affinity, capability, and multi-file private transactions do not exist.

- [ ] **Step 3: Implement closed states and journal-before-mutation reset**

```js
export async function reserveFamily({ rootFamily, accountId }) {
  return withPoolLock(async (state) => {
    assertAffinityUsable(state.sessions);
    const rootDigest = digestFamily(state.sessions.epoch, rootFamily);
    assertCapacityOrExisting(state.sessions, rootDigest, 2048);
    return createOwnerReservation(state, { rootDigest, accountId });
  });
}

export async function resetAffinity({ confirmation }) {
  if (confirmation !== "START NEW TASKS") throw new Error("typed confirmation required");
  return withPoolAndSortedAccountLocks(() =>
    runPrivateFileTransaction([AFFINITY_SECRET_PATH, ACCOUNT_POOL_PATH], rotateEpochAndClearState),
  );
}
```

Model B1 reserved, B2 committed, permanent tombstone, permanent resolving alias, and quarantine as explicit discriminated states. Restart converts outstanding reservations to `reservation-owner-lost` tombstones. Global unresolved 409 applies only to quarantine or uncertain identity; a valid unmatched primary continuation remains allowed. Session epoch comparison closes the reset/attempt race.

The standalone enforcement-state module has no filesystem I/O. Pool initialization explicitly loads it from validated sessions, failed validation marks it uncertain, and `writeChatGPTAccountPoolState` refreshes it only after the locked atomic write succeeds. Failed writes leave the prior in-memory snapshot unchanged. This gate remains true after fallback is disabled while safety records survive.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/private-file-transaction.test.mjs test/chatgpt-account-affinity.test.mjs test/file-security.test.mjs`

Expected: PASS for secrecy, owner-only mode, HMAC namespace separation, parent/child aliasing, reservation collision, restart tombstones, no eviction, reset exclusion, injected crash recovery, and exact confirmation.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/chatgpt-account-affinity.test.mjs test/chatgpt-account-operation-lock.test.mjs`

Expected: PASS; do not commit.

### Task 4: Provenance Marker, Task-Family Resolver, and Native Descriptor

**Files:**
- Create: `src/internal-transport.mjs`
- Modify: `src/codex-session-names.mjs`
- Modify: `src/catalog.mjs`
- Modify: `src/cursor-surface.mjs`
- Modify: `src/claude-surface.mjs`
- Modify: `src/gemini-surface.mjs`
- Modify: `src/responses-websocket.mjs`
- Modify: `src/direct-responses-provider.mjs`
- Modify: `src/router.mjs`
- Create: `test/internal-transport.test.mjs`
- Modify: `test/codex-session-names.test.mjs`
- Modify: `test/catalog.test.mjs`
- Modify: `test/cursor-surface.test.mjs`
- Modify: `test/claude-surface.test.mjs`
- Modify: `test/gemini-surface.test.mjs`
- Modify: `test/responses-websocket.test.mjs`
- Modify: `test/chatgpt-web-provider.test.mjs`
- Modify: `test/routing.test.mjs`

**Interfaces:**
- Consumes: raw inbound headers/body/session descriptor and catalog's private `nativeCatalog()`/variant logic.
- Produces: `INTERNAL_TRANSPORT_HEADER`, closed `INTERNAL_TRANSPORT` values, `stripInternalTransportHeaders(headers)`, `resolveRoutingTaskFamily(input)`, and `nativeModelDescriptor(slug)`.

- [ ] **Step 1: Write failing provenance, stripping, and descriptor tests**

```js
test("every internal responses surface stamps a closed provenance value", async () => {
  assert.deepEqual(await observedLoopbackMarkers(), new Set([
    "responses-websocket", "cursor-surface", "claude-surface", "gemini-surface",
  ]));
});

test("deny-only marker is absent on every external request", async () => {
  assert.equal(await externalUpstreamHeader("x-codex-router-internal-transport"), undefined);
});

test("native descriptor contains no route or credential material", () => {
  assert.deepEqual(Object.keys(nativeModelDescriptor("gpt-5.6-sol")).sort(), SAFE_NATIVE_KEYS);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/internal-transport.test.mjs test/codex-session-names.test.mjs test/catalog.test.mjs test/cursor-surface.test.mjs test/claude-surface.test.mjs test/gemini-surface.test.mjs test/responses-websocket.test.mjs test/chatgpt-web-provider.test.mjs test/routing.test.mjs`

Expected: FAIL because the marker, fresh resolver, and public native-only descriptor are absent.

- [ ] **Step 3: Implement closed marker, fresh resolver, and safe export**

```js
export const INTERNAL_TRANSPORT_HEADER = "x-codex-router-internal-transport";
export const INTERNAL_TRANSPORT = Object.freeze({
  websocket: "responses-websocket",
  cursor: "cursor-surface",
  claude: "claude-surface",
  gemini: "gemini-surface",
});

export function stripInternalTransportHeaders(headers) {
  const clean = new Headers(headers);
  clean.delete(INTERNAL_TRANSPORT_HEADER);
  return clean;
}
```

Stamp all four loopback creators. Strip in native/routed builders and `directResponsesHeaders()` before its broad `x-codex-*` copy. The family resolver performs a fresh routing-only root lookup with no negative cache and never treats a caller header alone as authority.

The catalog export uses the validated active global native entry plus variants, never routed entries. It returns exactly the deeply frozen keys `slug`, `provider`, `contextWindow`, `inputModalities`, `reasoningLevels`, and `searchTool`. Normalize a variant to its upstream slug; set `provider` to `openai`; clone `context_window`, `input_modalities`, and `supported_reasoning_levels`; and map advertised `web_search` to frozen `{mode:"hosted"}` (otherwise `null`). No route, account, credential, or mutable catalog object may escape.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/internal-transport.test.mjs test/codex-session-names.test.mjs test/catalog.test.mjs test/cursor-surface.test.mjs test/claude-surface.test.mjs test/gemini-surface.test.mjs test/responses-websocket.test.mjs test/chatgpt-web-provider.test.mjs test/routing.test.mjs`

Expected: PASS, including invalid-marker denial, child-to-root resolution, no negative cache, no egress leakage, and route-free native descriptors.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/loopback-proxy-bypass.test.mjs test/openai-endpoint-policy.test.mjs`

Expected: PASS; do not commit.

### Task 5: Shared Attempt Budget, Terminal-Quota Classifier, and Commit Primer

**Files:**
- Create: `src/failover-attempt-context.mjs`
- Create: `src/uncommitted-response.mjs`
- Create: `src/chatgpt-account-fallback.mjs`
- Modify: `src/http-utils.mjs`
- Create: `test/failover-attempt-context.test.mjs`
- Create: `test/uncommitted-response.test.mjs`
- Create: `test/chatgpt-account-fallback.test.mjs`
- Modify: `test/http-utils-resilience.test.mjs`

**Interfaces:**
- Consumes: client abort signal, monotonic clock, raw upstream `Response`, normalized account state.
- Produces: `parseFailoverAttemptNamespace(namespace)`, `createFailoverAttemptContext({sourceKey,clientSignal,accountHops,externalHops,budgetMs=30000,clock=performance,wallClock=Date})`, read-only remaining-hop getters, `reserve(namespace)`, `commitResponse()`, idempotent `dispose()`, `classifyTerminalOpenAIQuota(response,bodyText,options)`, and `primeUncommittedResponse(upstream,{transport="http",context,clock=performance,maxBytes})`.
- Attempt namespaces are exactly `native-model:openai:<native-slug>`, `openai-account:<validated-account-id>:<native-slug>`, and `routed-model:<provider>:<provider-qualified-slug>`. The source is native or routed, never account-backed. A routed slug must begin with its exact provider prefix.
- One context owns the client-linked abort signal and deadline timer. A successful reservation inserts the exact namespace and decrements its typed counter before I/O; duplicate, malformed, source, native, exhausted, aborted, disposed, or deadline-expired reservations return false with no refund. Native origins permit at most two account hops and one external hop; routed origins permit zero account hops and at most two external hops.
- `commitResponse()` is an idempotent one-way transition used after a candidate is primed but before its first visible byte. It returns false if already aborted/expired; otherwise it clears only the retry deadline timer, permanently refuses further reservations, and keeps caller abort propagation live for the accepted body. The relay owner retains the context and calls `dispose()` only after body finish/cancel/failure and upstream settlement.

- [ ] **Step 1: Write failing budget, classification, and commit-point tests**

```js
test("namespace collision is refused before I/O", () => {
  const ctx = createFailoverAttemptContext({ sourceKey: "native-model:openai:gpt-5.6-sol", accountHops: 2, externalHops: 1 });
  assert.equal(ctx.reserve("openai-account:acct_backup01:gpt-5.6-sol"), true);
  assert.equal(ctx.accountHopsRemaining, 1);
  assert.equal(ctx.reserve("openai-account:acct_backup01:gpt-5.6-sol"), false);
  assert.equal(ctx.accountHopsRemaining, 1);
  ctx.dispose();
});

test("free-text and ordinary 429 never classify as terminal quota", async () => {
  const upstream = response(429, { error: { message: "quota" } });
  assert.equal(classifyTerminalOpenAIQuota(upstream, await upstream.clone().text()), null);
});

test("first SSE event commits and cannot be replayed", async () => {
  const primed = await primeUncommittedResponse(sseResponse("event: response.created\n\ndata: {}\n\n"), options);
  assert.equal(primed.committedKind, "sse-event");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/failover-attempt-context.test.mjs test/uncommitted-response.test.mjs test/chatgpt-account-fallback.test.mjs test/http-utils-resilience.test.mjs`

Expected: FAIL because the shared budget, authoritative classifier, and exact primer do not exist.

- [ ] **Step 3: Implement one deadline and discriminated commit states**

```js
export function createFailoverAttemptContext({ sourceKey, clientSignal, accountHops, externalHops, budgetMs = 30_000, clock = performance, wallClock = Date }) {
  const controller = new AbortController();
  const startedAt = clock.now();
  const startedWallMs = wallClock.now();
  const deadlineAt = startedAt + budgetMs;
  const attempted = new Set([sourceKey]);
  let accountRemaining = accountHops;
  let externalRemaining = externalHops;
  const cleanup = linkAbortSignalsAndDeadline(clientSignal, controller, deadlineAt, clock);
  return {
    sourceKey,
    startedAt,
    startedWallMs,
    deadlineAt,
    signal: controller.signal,
    get accountHopsRemaining() { return accountRemaining; },
    get externalHopsRemaining() { return externalRemaining; },
    reserve(namespace) {
      const parsed = parseFailoverAttemptNamespace(namespace);
      if (!parsed || parsed.kind === "native" || attempted.has(namespace) || controller.signal.aborted || clock.now() >= deadlineAt) return false;
      if (parsed.kind === "account" ? accountRemaining < 1 : externalRemaining < 1) return false;
      attempted.add(namespace);
      if (parsed.kind === "account") accountRemaining -= 1;
      else externalRemaining -= 1;
      return true;
    },
    commitResponse() { return commitAndDisarmRetryDeadline(); },
    dispose() { cleanup(); },
  };
}
```

The quota classifier accepts only complete bounded HTTP 429 JSON whose root and `error` are non-array objects and whose exact `error.type` is `usage_limit` or `usage_limit_reached`; an optional own `error.code` must be one of those exact strings. An optional `x-codex-rate-limit-reached-type` must be one of the four captured workspace owner/member credits-depleted or usage-limit-reached values. Cooldown precedence is the first valid future value from strict `Retry-After`, safe-integer `error.resets_at`, the validated active-limit-family primary reset header, then exact `x-codex-primary-reset-at`; clamp to 24 hours and never wildcard arbitrary headers. Invalid reset metadata yields a terminal classification with no cooldown. `insufficient_quota`, future types, message-only bodies, SSE error text, and prose never qualify.

Failed-response classification reads only a bounded `response.clone()`, preserving the original primary response. Candidate priming consumes and reconstructs the candidate stream with exact status, status text, headers, retained prefix/tail, and unread remainder. Its closed result vocabulary is `uncommitted-terminal`, `sse-event`, `sse-preamble-eof`, `bodyless`, `websocket-event`, `body-byte`, or `prime-failed`; prime-failure reason is exactly `aborted`, `deadline`, `too-large`, `malformed`, or `read-failed`. A failed or ambiguous prime is committed and permits no later hop. Export only the existing `readWithAbort` helper from `http-utils.mjs`.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/failover-attempt-context.test.mjs test/uncommitted-response.test.mjs test/chatgpt-account-fallback.test.mjs test/http-utils-resilience.test.mjs`

Expected: PASS for shared timeout, disposal, client abort, typed hop decrement/exhaustion, collision zero-send, authoritative quota/reset precedence, SSE/WebSocket/body/preamble-EOF commit points, byte-exact stream reconstruction, clone preservation, max-byte refusal, and deadline refusal.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/model-failover.test.mjs test/pipe-response.test.mjs test/transport-failure.test.mjs`

Expected: PASS; do not commit.

### Task 6: Trusted Catalog-Capture Foundations

**Files:**
- Modify: `src/codex-binary.mjs`
- Modify: `src/process-tree.mjs`
- Create: `src/catalog-artifacts.mjs`
- Modify: `src/private-file-transaction.mjs`
- Create: `test/process-tree-stdin-gate.test.mjs`
- Modify: `test/process-tree.test.mjs`
- Modify: `test/codex-binary.test.mjs`
- Create: `test/catalog-artifacts.test.mjs`
- Create: `test/fixtures/process-tree-stdin-gate-child.mjs`
- Create: `scripts/sanitize-codex-model-cache-fixture.mjs`
- Create: `test/sanitize-codex-model-cache-fixture.test.mjs`

**Interfaces:**
- Consumes: existing `codexCandidatePaths()`, process-tree owner tracking, private transaction primitive.
- Produces on the exact supported POSIX allowlist: `resolveTrustedDesktopCodexBinary()`, opt-in `runProcessTree(...,{writableStdin,onChildAttached})`, `CATALOG_ARTIFACT_NAMES`, `snapshotCatalogArtifacts(root)`, and `publishCatalogArtifacts({root,artifacts,generation,capturedAt,capturedWith})`. Windows automatic catalog capture/fallback is explicitly unsupported and returns the fixed refusal before protected reads or spawn; existing explicit account switching remains unchanged.

- [ ] **Step 1: Write failing binary, stdin-gate, and marker-last tests**

```js
test("desktop resolver rejects env, ChatGPT, standalone, and router shim candidates", async () => {
  assert.equal(await resolveTrustedDesktopCodexBinary({ candidates: hostileCandidates }), trustedDesktopPath);
});

test("child does not read managed home before parent sends GO", async () => {
  const events = await runGatedFixture();
  assert.deepEqual(events.slice(0, 2), ["child-attached", "journal-persisted"]);
  assert.equal(events.at(-1), "cache-read-after-GO");
});

test("publication writes generation marker last", async () => {
  assert.deepEqual(await injectedPublicationOrder(), [...CATALOG_ARTIFACT_NAMES, "account-catalog-generation.json"]);
});

test("fixture sanitizer rejects auth token and account-shaped keys", async () => {
  await assert.rejects(sanitizeFixture({ access_token: "sentinel" }), /forbidden source field/i);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/codex-binary.test.mjs test/process-tree.test.mjs test/process-tree-stdin-gate.test.mjs test/catalog-artifacts.test.mjs test/sanitize-codex-model-cache-fixture.test.mjs`

Expected: FAIL because trusted desktop resolution, writable-stdin attachment, a rejecting sanitizer, and six-file publication foundations are absent. No authenticated cache operation runs in this task.

- [ ] **Step 3: Implement desktop-only resolution, attached-child gate, and atomic publication**

```js
export async function runProcessTree(command, args, {
  writableStdin = false,
  onChildAttached,
  ...options
} = {}) {
  const child = spawnOwnedTree(command, args, { ...options, stdio: writableStdin ? ["pipe", "pipe", "pipe"] : options.stdio });
  const owner = await attestSpawnedOwner(child.pid);
  if (onChildAttached) await onChildAttached({ ...owner, stdin: child.stdin });
  return retainTreeUntilExit(child, owner, options);
}
```

Any attachment callback failure terminates and waits for the full tree. Abort and parent death close stdin and terminate the owned tree. The artifact publisher takes before-images, validates fixed filenames beneath the validated root, writes all five artifacts, fsyncs, and publishes `account-catalog-generation.json` last. Do not add a Windows capture/ACL path; Windows automatic fallback remains a pre-read, pre-spawn `unsupported-platform` refusal.

Implement the sanitizer as a rejecting, pure foundation only. It refuses credential/account/token-shaped keys and values, replaces identifying model data with fixed literals while preserving field types/envelope structure, and cannot write outside an explicitly supplied destination beneath the test-fixture root. Do not run it on an authenticated cache yet and do not enable the raw envelope parser in this task. Task 7 must first provide the login/request-lease exclusion, pre-GO capture journal, exact cache before-image, recovery, and auth-finalization machinery; only then may the exact desktop operation create the fixture. Until that proof exists the runtime result is fixed `unsupported-cache-schema`.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/codex-binary.test.mjs test/process-tree.test.mjs test/process-tree-stdin-gate.test.mjs test/catalog-artifacts.test.mjs test/private-file-transaction.test.mjs test/sanitize-codex-model-cache-fixture.test.mjs`

Expected: PASS for candidate rejection, no pre-GO reads, hook failure termination, abort cleanup, unsupported-Windows refusal before protected work, traversal/symlink refusal, absence snapshots, injected partial writes, rollback, marker-last order, and sanitizer rejection of unsafe synthetic envelopes. No test accepts a raw cache schema yet.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/windows-operations.test.mjs test/process-tree.test.mjs test/file-security.test.mjs`

Expected: PASS, including the unchanged existing Windows process-tree/source guards and new fail-closed automatic-fallback refusal; do not commit.

### Task 7: Per-Account Catalog Capture, Journals, and Profile-Switch v3

**Files:**
- Create: `src/chatgpt-catalog-capture-journal.mjs`
- Create: `src/chatgpt-catalog-probe-launcher.mjs`
- Create: `src/chatgpt-account-catalog.mjs`
- Modify: `src/catalog.mjs`
- Modify: `src/paths.mjs`
- Modify: `src/chatgpt-profile-switch.mjs`
- Modify: `src/start.mjs`
- Create: `test/chatgpt-catalog-capture-journal.test.mjs`
- Create: `test/chatgpt-account-catalog.test.mjs`
- Modify: `test/catalog.test.mjs`
- Modify: `test/chatgpt-profile-switch.test.mjs`
- Modify: `test/service-readiness.test.mjs`
- Modify: `test/startup-cleanup.test.mjs`
- Create: `test/fixtures/codex/account-catalog/PROVENANCE.md`
- Create: `test/fixtures/codex/account-catalog/models_cache.json`
- Create: `test/fixtures/codex/account-catalog/native-models.json`
- Create: `test/fixtures/codex/account-catalog/merged-models.json`
- Create: `test/fixtures/codex/account-catalog/native-aliases.json`
- Create: `test/fixtures/codex/account-catalog/announced-models.json`
- Create: `test/fixtures/codex/account-catalog/incompatible-models_cache.json`

**Interfaces:**
- Consumes: account auth/locks/leases, trusted desktop binary, gated process tree, catalog artifact transaction, existing catalog merge functions.
- Produces: `captureChatGPTAccountCatalog(accountId,{reason,signal,preSpawnGuard})`, `recoverCatalogCaptureJournals()`, `recoverProfileSwitchTransactions()`, profile-switch transaction schema version 3, `snapshotChatGPTAccountCatalog(accountId,{modelSlug,now})`, and `revalidateChatGPTAccountCatalog(capability)`.
- The catalog snapshot API alone owns marker-A, bounded protected raw/enriched reads, pre/post identity restats, digest/schema/age/capability checks, and marker-B equality. It returns null or an opaque frozen in-memory capability exposing only `{accountId,generation,modelSlug,descriptor}`; hidden exact file identities/digests are retained privately. Revalidation repeats generation and identity/digest proof immediately before credential access/send. Consumers never reopen or partially reimplement catalog files.

- [ ] **Step 1: Write failing capture and recovery tests**

```js
test("capture journals child identity before GO and restores moved cache after crash", async () => {
  const trace = await runCaptureWithCrash("after-child-attached");
  assert.deepEqual(trace, [
    "prepared", "child-attached", "cache-moved", "cache-absence-reverified",
    "go", "crash", "restored", "auth-finalized", "journal-removed",
  ]);
});

test("raw and enriched slug sets must match exactly", async () => {
  await assert.rejects(captureFixture("slug-mismatch"), /catalog slug set mismatch/i);
});

test("startup blocks on a live or unknown journal owner", async () => {
  await assert.rejects(runStartupRecovery(liveOwnerJournal), /capture owner still active/i);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/chatgpt-catalog-capture-journal.test.mjs test/chatgpt-account-catalog.test.mjs test/catalog.test.mjs test/chatgpt-profile-switch.test.mjs test/service-readiness.test.mjs test/startup-cleanup.test.mjs`

Expected: FAIL because capture/recovery and transaction v3 do not exist.

- [ ] **Step 3: Implement exact-operation capture and journal recovery**

```js
export async function captureChatGPTAccountCatalog(accountId, { reason, signal }) {
  const operation = await withPoolThenAccountLock(accountId, async () => {
    await assertNoLoginOrRequestUseLease(accountId);
    const binary = await resolveTrustedDesktopCodexBinary();
    const tx = await prepareCaptureJournal(accountId);
    const loginLease = await claimCatalogLoginLease(accountId);
    return { binary, tx, loginLease };
  });
  try {
    const probe = await runProcessTree(process.execPath, [CATALOG_PROBE_LAUNCHER_PATH, operation.binary], {
      writableStdin: true,
      signal,
      onChildAttached: async (owner) => {
        await withPoolThenAccountLock(accountId, async () => {
          await revalidateCaptureLeaseAndGeneration(operation);
          await operation.tx.markChildAttached(owner);
          await operation.tx.moveProbeCacheAside();
          await operation.tx.assertProbeCacheAbsent();
        });
        owner.stdin.write(Buffer.from([0x47]));
      },
    });
    const published = await publishCapturedCatalogUnderOrderedLocks(accountId, operation, probe);
    await finalizeCatalogLoginLease(operation.loginLease);
    await operation.tx.commitAfterAuthFinalized();
    return published;
  } catch (error) {
    await operation.tx.restoreBeforeImagesAndWaitForTree();
    await finalizeCatalogLoginLease(operation.loginLease);
    await operation.tx.removeAfterAuthFinalizedRollback();
    throw error;
  }
}
```

Before spawn, skip discovery-disabled, user-owned catalog source, managed-home `config.toml`, unsupported platform, login busy, or request in use. Claim the existing reserved-then-running login/auth-writer lease and bind the journal to its exact `leaseId`; verify again that request-use leases are absent. Hold pool/account locks only for validation, lease/journal transitions, protected snapshots, and final generation-checked state updates; release them before all three CLI subprocesses and output reads so distinct backup probes can overlap. The prepared journal contains the exact probe-cache before-image before a child exists. Its closed manifest contains fixed logical snapshot slots only; bounded owner-only sidecar files hold content bytes and hashes, destinations are always re-derived from the validated account ID plus fixed tables, and no arbitrary path is accepted. After durable child attachment, reacquire the ordered locks only long enough to revalidate the exact lease/capture generation, move the old cache, fsync the move, and re-stat that the live path is absent; `GO` is impossible before all of those complete. The committed launcher then runs `codex --version`, `codex debug models`, and `codex debug models --bundled` using the exact binary and managed account home in one owned tree. Keep its control pipe open; EOF/cancellation makes it terminate and wait for descendants. Restore before-images on failure and use a capture-safe login-finalization seam that cannot recursively start profile/catalog publication if the protected auth digest changed. On both success and rollback, the journal remains durable until the owned tree is reaped, cache/account/global state is settled, and auth finalization has completed; only an explicit final commit/removal operation unlinks it.

Once that machinery is green, perform the exact non-inference desktop operation through this journaled path against the already-managed current Codex home and pass only its newly generated cache to `scripts/sanitize-codex-model-cache-fixture.mjs`. The sanitizer writes only the fixed fixture destination and no raw bytes are retained. `PROVENANCE.md` records all operation names, exact desktop binary/version, capture timestamp, source byte SHA-256, sanitizer command, transaction/recovery test reference, and reviewer confirmation that no auth/header/account field survived. Only after this artifact and review exist may the raw envelope parser move from `unsupported-cache-schema` to supported. If safe capture cannot complete, leave the parser unsupported and stop this task rather than inventing a schema.

Validate schema, five-minute clock skew, fresh file identity, Codex version/etag, no routes, raw/enriched exact slug equality, and the six-field enrichment allowlist; reuse `deriveBaseInstructions`, `mergeNativeCatalogs`, `mergeNativeModel`, and `readModelsCache`. Preserve unknown native model fields verbatim and strip unresolved instruction placeholders. A selected-account capture publishes the complete five-file set and marker globally, then the byte-identical private account set; a backup capture publishes only its private set. The selected primary remains the only global picker source and backup-only/bundled-only slugs are never advertised as eligible. Recovery order in `start.mjs` is profile switch, capture journals sorted by validated account ID, then lifecycle current.

Profile switch v3 journals before any mutation and uses the same bounded owner-only content-or-absence sidecar discipline to snapshot global/current/target copies of all five artifacts plus marker. V2 recovery removes an unjournaled marker. Capture recovery acquires pool -> affected account -> publication locks, in validated account-ID order across journals. Any surviving proven-dead capture restores; live/unknown blocks listening.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/chatgpt-catalog-capture-journal.test.mjs test/chatgpt-account-catalog.test.mjs test/catalog.test.mjs test/chatgpt-profile-switch.test.mjs test/service-readiness.test.mjs test/startup-cleanup.test.mjs`

Expected: PASS for every skip reason, identity recheck, exact binary/home, durable attachment/cache-move/absence/GO ordering, fixture provenance and schemas, tree reaping, cache restore, auth-finalize-before-journal-removal, five-file rollback, marker-last publish, v2/v3 recovery, sorted startup recovery, and live/unknown startup block.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/catalog-publication-lock.test.mjs test/model-overlay-publication.test.mjs test/native-session-publication.test.mjs`

Expected: PASS; do not commit.

### Task 8: Native OpenAI Account Routing and Affinity Enforcement

**Files:**
- Modify: `src/chatgpt-account-fallback.mjs`
- Modify: `src/router.mjs`
- Modify: `src/responses-websocket.mjs`
- Modify: `src/codex-native-session.mjs`
- Modify: `src/chatgpt-account-pool.mjs`
- Modify: `src/start.mjs`
- Modify: `src/usage-events.mjs`
- Modify: `test/chatgpt-account-fallback.test.mjs`
- Create: `test/chatgpt-account-fallback-router.test.mjs`
- Modify: `test/routing.test.mjs`
- Modify: `test/native-retry.test.mjs`
- Modify: `test/usage-events.test.mjs`
- Modify: `test/startup-cleanup.test.mjs`
- Modify: `test/responses-websocket.test.mjs`
- Modify: `test/codex-native-session.test.mjs`

**Interfaces:**
- Consumes: strict ChatGPT auth snapshot, Task 3 closed affinity resolver/CAS APIs, request lease, native descriptor, attempt context, terminal quota classifier, primer, and Task 7 opaque catalog snapshot/revalidation capability.
- Produces: `authenticatedCallerRoute()` returning immutable `{pathname,routeAuthClass}`, synchronous `nativeHeaders()` returning `{headers,credentialSource}`, `eligibleFallbackAccounts({primaryAccountId,modelSlug,pool,now})`, `attemptBackupOpenAIAccount({accountId,request,descriptor,context,affinityCapability,catalogCapability})`, and router integration that also returns an opaque `accounts-exhausted` capability only after every sent backup returned exact terminal quota and the final reservation was durably owner-cleared.
- Startup must initialize the Task 3 in-memory affinity-enforcement snapshot after transaction recovery and strict pool validation but before any request listener becomes reachable. The fallback-off byte-identical fast path is legal only when the snapshot is exactly `{required:false,uncertain:false}`.
- Because `start.mjs` supervises a separate `router.mjs` process, parent recovery completes before spawn and the serving router independently performs strict pool/session initialization before `server.listen`, including direct router launches. Invalid/unreadable state initializes `{required:true,uncertain:true}` and serves only under quarantine restrictions; it is never mistaken for the empty fast path.
- `routeAuthClass` is exactly `capability-path`, `capability-bearer`, or `native-token`; `credentialSource` is exactly `caller-chatgpt`, `caller-api-key`, `substituted-chatgpt`, `router-capability`, `none`, or `other`.
- Add a ChatGPT-only constant-time native-session matcher beside the existing API-key-capable matcher. Every primary-only auxiliary `nativeHeaders()` call site destructures only `.headers`; none gains fallback eligibility.
- Bound selected routing reuses primary bytes under a lease. Bound backup
  routing replaces only two credential headers, skips primary, and consumes no
  reservation or hop. Both capabilities revalidate before credential access.
- Portability inspects pristine input before normalization or field deletion.
- A primed/promoted candidate calls `context.commitResponse()` before
  visibility. The relay owns context and lease through full settlement.
- Structured route-auth crosses Responses WebSocket without path coercion.
  Committed native-to-Kimi responses disable empty-completion replay.
- `fetchAndPrimeBackup()` maps Task 5 states to the closed Task 8 union: `not-attempted` means zero I/O; `candidate` owns the rebuilt primed response plus request lease and attempt context; `terminal-failure` owns the untouched primary, exact failed backup classification, and no transferable lease. Prime failure or ambiguity stops with the primary and never masquerades as zero-I/O.

- [ ] **Step 1: Write failing eligibility, affinity, and zero-send tests**

```js
test("backup order is priority then opaque account id and capped by maxHops", () => {
  assert.deepEqual(eligibleFallbackAccounts({
    primaryAccountId: "acct_a",
    modelSlug: "gpt-5.6-sol",
    pool: fixturePool,
    now: fixedNow,
  }), ["acct_b", "acct_c"]);
});

test("root and subagent share the first successful account", async () => {
  await routePortableTurn({ family: "root", backupSucceeds: "acct_b" });
  assert.equal(await selectedAccountFor({ family: "child", root: "root" }), "acct_b");
});

test("non-owner reservation waits 250ms then returns 409 with zero sends", async () => {
  const result = await concurrentReservationAttempt();
  assert.equal(result.status, 409);
  assert.equal(result.upstreamSendCount, 0);
});

test("route authorization and credential provenance remain independent", async () => {
  assert.deepEqual(await classifyRequest(capabilityPathWithCanonicalChatGPT), {
    routeAuthClass: "capability-path",
    credentialSource: "caller-chatgpt",
  });
  assert.equal((await classifyRequest(capabilityPathWithApiKey)).credentialSource, "caller-api-key");
});

test("bound selected account uses canonical passthrough once without profile auth read", async () => {
  const result = await routeBoundSelectedAccount();
  assert.deepEqual(result, { primarySends: 1, savedProfileReads: 0, headerMutation: false });
});

test("fallback-off primary success uses only the cheap in-memory gate", async () => {
  const result = await routePrimarySuccess({ fallbackEnabled: false, enforcementEmpty: true });
  assert.deepEqual(result, { poolReads: 0, upstreamSends: 1 });
});

test("backup 401 stops the chain and schedules only that account catalog refresh", async () => {
  const primary = primaryQuotaResponseFixture();
  const result = await routePortableTurn({ primaryResponse: primary, backupStatus: 401 });
  assert.strictEqual(result.response, primary);
  assert.deepEqual(result.sideEffects, {
    reservation: "cleared",
    refreshPending: true,
    scheduledBackgroundRefreshes: 1,
    externalSends: 0,
  });
});

test("successful backup holds its request lease until the relayed body settles", async () => {
  const candidate = await beginStreamingBackup();
  await assert.rejects(removeCandidateAccount(), /request in use/i);
  await candidate.finishRelay();
  await assert.doesNotReject(removeCandidateAccount());
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/chatgpt-account-fallback.test.mjs test/chatgpt-account-fallback-router.test.mjs test/routing.test.mjs test/native-retry.test.mjs test/usage-events.test.mjs test/startup-cleanup.test.mjs test/responses-websocket.test.mjs test/codex-native-session.test.mjs`

Expected: FAIL because the native path does not enter account fallback or affinity enforcement.

- [ ] **Step 3: Implement strict-priority backup attempts at the native request seam**

```js
export async function attemptBackupOpenAIAccount({ accountId, request, descriptor, context, affinityCapability, catalogCapability }) {
  const namespace = `openai-account:${accountId}:${descriptor.slug}`;
  if (!context.reserve(namespace)) return { kind: "not-attempted" };
  const lease = await createRequestUseLease({ accountId, affinityGeneration: affinityCapability.generation, requestStartedWallMs: context.startedWallMs, waitMs: Math.min(250, remainingBudgetMs(context)) });
  let leaseTransferred = false;
  try {
    await revalidateFamilyCapability(affinityCapability);
    await revalidateChatGPTAccountCatalog(catalogCapability);
    const auth = await snapshotChatGPTRequestAuth({ codexHome: accountHome(accountId), expectedAccountId: accountId });
    const result = await fetchAndPrimeBackup({ request, descriptor, auth, context });
    if (result.kind === "candidate") {
      leaseTransferred = true;
      return { ...result, requestLease: lease };
    }
    return result;
  } finally {
    if (!leaseTransferred) await lease.release();
  }
}
```

Enter automatic account fallback only for caller-authenticated native HTTP `/responses` with no deny-only internal marker, no unbound attestation, portable request state, stable proven root, exact selected/canonical primary proof, and an uncommitted authoritative terminal-quota result. Initialize the affinity-enforcement snapshot after startup recovery and before listening. Even with fallback off, any required/uncertain snapshot performs the bounded family/tombstone check before the first send; only the exact proven-empty snapshot takes the zero-read fast path. Core portability rejects `previous_response_id`, uploaded files/references, conversation or opaque continuation state, reasoning/compaction/ciphertext, `x-codex-turn-state`, `x-oai-attestation`, the WebSocket marker, and unknown native continuation fields. Cursor/Claude/Gemini translations, compact/image/relay/vision/search auxiliary calls, every other native endpoint, and billed/non-native calls remain primary-only. Never let `adoptRoute()` set `failoverFrom` from a native undefined route. Exclude primary, disabled/paused/revoked/reauth/cooldown/busy/stale/missing/model-ineligible accounts. Catalog eligibility performs marker A, protected bounded raw/enriched reads with pre/post identity restats and one-megabyte bounds, digest checks, raw-slug presence, capability comparison, marker B equality, and immediate pre-send generation recheck. Compatible last-known-good is valid for at most seven days; binary version inequality alone is diagnostic, not exclusion. A backup 401 is not quota: it clears the matching reservation, marks only that account's catalog refresh pending, queues one bounded background refresh outside the response path, returns the byte-identical original primary quota response, and never reaches another account or Kimi. Rootless subagents stay account-primary-only but retain independent native-to-Kimi eligibility. A valid unmatched primary continuation passes; quarantine/uncertain identity returns fixed sanitized 409. A reservation collision waits at most 250 ms for a committed binding, then returns fixed 409 with zero sends. A successful candidate transfers its in-memory request-lease handle to the adoption/relay owner; release occurs only after the response body finishes, is cancelled, or fails and the owned upstream tree/body has settled. Record only account index/hop/reason enums in telemetry, never account IDs or family digests.

Attestation has the exact three-state rule: unbound stays byte-for-byte on primary with no fallback; a family bound to canonical active primary passes through exactly; a family bound to a non-active account returns fixed local 409 before backup credential access. Attested input never reaches Kimi. An unbound WebSocket request also stays primary-only. A valid bound WebSocket continuation may go only to its already-bound account under fresh canonical proof, including same-account `x-codex-turn-state`; otherwise fixed 403/409 is returned before credential access and no marker grants authority.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/chatgpt-account-fallback.test.mjs test/chatgpt-account-fallback-router.test.mjs test/routing.test.mjs test/native-retry.test.mjs test/usage-events.test.mjs test/startup-cleanup.test.mjs test/responses-websocket.test.mjs test/codex-native-session.test.mjs`

Expected: PASS for default-off byte equivalence and cheap gate, independent auth/provenance axes, strict order, max hops, model gating, portable/opaque split, parent/subagent affinity, rootless rule, selected passthrough, quota cooldown, auth mismatch, request lease, short request-lock timeout, abort/deadline, collision zero-send, committed-response stop, fixed errors, and sanitized usage.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/empty-completion-router.test.mjs test/empty-completion-guard.test.mjs test/native-context-variants.test.mjs test/codex-native-session.test.mjs`

Expected: PASS; do not commit.

### Task 9: Native-to-External Adapter and Terminal Kimi Semantics

**Files:**
- Modify: `src/model-failover.mjs`
- Modify: `src/router.mjs`
- Modify: `test/model-failover.test.mjs`
- Modify: `test/model-failover-router.test.mjs`
- Modify: `test/routing.test.mjs`
- Modify: `test/error-translation.test.mjs`
- Modify: `test/provider-cooldown.test.mjs`
- Modify: `test/empty-completion-router.test.mjs`
- Modify: `test/native-retry.test.mjs`

**Interfaces:**
- Consumes: immutable native descriptor captured before account checks, shared attempt context, existing `normalizeRoutedAgentInput()`, `ageToolResults()`, namespace flattening, `prepareRoutedRequest()`, `adoptRoute()`, and routed error translation.
- Produces: a native-origin-only discriminated result without changing existing routed callers: `{kind:"not-attempted"}`, `{kind:"candidate",route,built,response}`, `{kind:"terminal-failure",route,built,upstream,failedBodyText}`, or `{kind:"preserve-primary",phase:"transport"|"prime"|"adopt"}`.

- [ ] **Step 1: Write failing native-origin external-hop tests**

```js
test("disabled or invalid account policy still permits one portable Kimi hop", async () => {
  const result = await routeNativeQuota({ accountPolicy: "invalid", external: "kimi-api/kimi-k3" });
  assert.equal(result.provider, "kimi-api");
  assert.equal(result.sendCounts.external, 1);
});

test("sent Kimi non-2xx is adopted and translated, never collapsed to primary", async () => {
  const result = await routeNativeQuota({ kimiStatus: 503, kimiBody: routedFailure });
  assert.equal(result.body.error.provider, "kimi-api");
  assert.notEqual(result.body.error.type, "usage_limit");
});

test("backup non-quota application failure stops before Kimi", async () => {
  const result = await routeNativeQuota({ backupStatus: 403, external: "kimi-api/kimi-k3" });
  assert.equal(result.status, 403);
  assert.equal(result.sendCounts.external, 0);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/model-failover.test.mjs test/model-failover-router.test.mjs test/routing.test.mjs test/error-translation.test.mjs test/provider-cooldown.test.mjs test/empty-completion-router.test.mjs`

Expected: FAIL because native origin has no complete source descriptor or discriminated sent-candidate result.

- [ ] **Step 3: Implement one native-to-routed handoff with complete adoption**

```js
export async function attemptModelFailover(input) {
  const candidate = await rankAndReserveCandidate(input);
  if (!candidate) return { kind: "not-attempted" };
  const built = await prepareRoutedRequest({
    request: input.request,
    payload: input.payload,
    route: candidate,
    normalizedInput: input.normalizedInput,
    agingEnabled: input.agingEnabled,
  });
  const upstream = await fetch(built.target, {
    method: "POST",
    headers: built.headers,
    body: built.body,
    signal: input.context.signal,
  });
  if (upstream.ok) return { kind: "candidate", route: candidate, built, upstream };
  return {
    kind: "terminal-failure",
    route: candidate,
    built,
    upstream,
    failedBodyText: await boundedResponseText(upstream.clone(), undefined, input.context.signal),
  };
}
```

For native origin, build normalized/aged input, namespace map, reasoning and hosted-search contract only after core portability passes. Reserve exactly one external namespace before I/O. `prepareRoutedRequest()` is the sole payload builder; never send native bytes to Kimi. A 2xx candidate is primed then atomically adopted before visibility. A sent non-2xx is adopted first and translated from its safe status/headers/bounded body. Only `not-attempted` returns the untouched primary quota response. Pre-visible transport error returns primary and stops. Backup 401/403/nonterminal 429/5xx/application failure stops the entire sequence and deliberately suppresses Kimi; only a chain of exact terminal-quota backup results advances.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/model-failover.test.mjs test/model-failover-router.test.mjs test/routing.test.mjs test/error-translation.test.mjs test/provider-cooldown.test.mjs test/empty-completion-router.test.mjs`

Expected: PASS for source metadata, normalization, tool aging, search contract, one external send, complete adoption, terminal non-2xx translation, no eligible candidate, transport failure, commit failure, and primary safe-header preservation.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/openai-adapters.test.mjs test/openai-endpoint-policy.test.mjs test/namespace-relay-routing.test.mjs test/tool-result-aging.test.mjs`

Expected: PASS; do not commit.

### Task 10: Catalog Lifecycle Controller and Final-Codex-Quit Tray Coordinator

**Files:**
- Create: `src/native-catalog-refresh.mjs`
- Create: `src/macos-shared-auth-processes.mjs`
- Modify: `src/paths.mjs`
- Modify: `src/start.mjs`
- Modify: `src/control.mjs`
- Modify: `src/control-args.mjs`
- Create: `test/native-catalog-refresh.test.mjs`
- Modify: `test/control.test.mjs`
- Modify: `test/startup-cleanup.test.mjs`
- Create: `apps/macos/ModelRouterTray/Sources/CodexCatalogRefreshCoordinator.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift`
- Create: `apps/macos/ModelRouterTray/Tests/CodexCatalogRefreshCoordinatorTests.swift`
- Modify: `apps/macos/ModelRouterTray/Tests/ControlContractTests.swift`

**Interfaces:**
- Consumes: profile/capture recovery, per-account capture with an immediate `preSpawnGuard`, exact process identities, existing tray process observer and a new owned/cancellable control runner.
- Produces: `readNativeCatalogRefreshState()`, `triggerNativeCatalogRefresh(reason)`, `reconcileNativeCatalogRefresh()`, CLI commands `catalog-refresh status`, `catalog-refresh trigger codex-final-exit`, `catalog-refresh reconcile`, and zero-argument `catalog-refresh` compatibility alias.
- Swift produces `CodexCatalogRefreshCoordinator.observe(codex:Set<ProcessIdentity>,chatGPT:Set<ProcessIdentity>)` where identity is exact PID plus start identity.
- `catalog-refresh status` is the only read command. Trigger/reconcile and the zero-argument reconcile alias are mutations with a 1,300-second control deadline and 1,320-second tray watchdog. Unknown or extra argv is rejected. Each command returns one closed JSON result; Swift rejects unknown keys/enums and never displays raw stderr.
- The existing aggregate `hostAppRunningNow()` signal remains unchanged for service follow mode. Lifecycle refresh uses separate exact known/unknown identity sets for only `com.openai.codex` and `com.openai.chat`; unknown is never interpreted as absence.

- [ ] **Step 1: Write failing lifecycle state and transition tests**

```js
test("initial zero does not invent a final-exit trigger", async () => {
  const state = await observeSequence([{ codex: [], chatgpt: [] }]);
  assert.equal(state.triggerCount, 0);
});

test("armed positive to zero triggers once and defers while ChatGPT is open", async () => {
  const state = await observeSequence([
    { codex: [pid(1)], chatgpt: [pid(2)] },
    { codex: [], chatgpt: [pid(2)] },
  ]);
  assert.deepEqual(state, { triggerCount: 1, pendingCode: "pending-shared-auth-consumer" });
});

test("relaunch cancels only owned probe and restores before-images", async () => {
  const result = await relaunchDuringCapture();
  assert.deepEqual(result, { code: "app-relaunched", restored: true, pending: true });
});
```

Mirror the first two cases in Swift with exact identity sets, plus partial exit, duplicate zero, terminal CLI exclusion, managed-restart exact-set suppression, and suppression expiry.

- [ ] **Step 2: Run Node and Swift focused tests and verify RED**

Run: `node --test test/native-catalog-refresh.test.mjs test/control.test.mjs test/startup-cleanup.test.mjs`

Run: `(cd apps/macos/ModelRouterTray && swift test --filter CodexCatalogRefreshCoordinatorTests)`

Expected: FAIL because the lifecycle schema, commands, and coordinator are absent.

- [ ] **Step 3: Implement the closed lifecycle machine and exact transition coordinator**

```js
export async function triggerNativeCatalogRefresh(reason) {
  assertTriggerReason(reason);
  return mutateRefreshState((state) => {
    const generation = randomOpaqueGeneration();
    if (state.current) return queueSingleRerun(state, generation, reason);
    return beginOrDefer(state, generation, reason);
  });
}
```

State is exactly the spec's version-1 `pending`, `trigger`, `current`, and `last` schema with closed status/code enums and no identities, stored at the fixed private path exported from `src/paths.mjs`. A dedicated short-held lifecycle lock serializes every read-modify-write; define its order relative to pool/account/publication locks and never hold it across capture. Complete or clear `current` by generation compare-and-swap so a newer pending generation survives. Recover current before pending; a live/unknown owned capture blocks duplication, while proven-dead rolls back and records `interrupted-recovered`. Startup performs only profile-switch, capture-journal, and lifecycle-`current` recovery before listeners/children; it does not consume pending intent or launch a probe. Ordinary reconcile captures primary first, then enabled backups with concurrency two; sanitize outcomes and keep last-known-good warnings. A fixed `/usr/bin/osascript -l JavaScript` helper enumerates exact macOS bundle identities without a shell for Node's under-lock and immediate pre-spawn guard. Recheck both apps absent before capture and inside capture immediately before spawn. Unknown fails closed; non-darwin automatic trigger/reconcile returns `unsupported-platform` before protected reads or spawn. On relaunch abort/wait only the owned tree, roll back, and persist the same trigger as deferred. Every state transition rewrites the private liveness file.

Swift coordinator seeds without firing, arms only after a known positive Codex desktop identity set, triggers only known nonempty-to-known-zero, tracks aggregate shared-auth consumers separately, coalesces active plus one pending, and gives managed restart one suppression generation bound to the exact pre-restart PID/start-identity set. Partial removal, mismatch, new identity, pre-zero failure, or expiry clears suppression, and real observer/poll snapshots produce the zero transition. Workspace notifications plus the existing five-second poll both feed the exact set; terminal CLI presence remains only in the unchanged aggregate host signal. A dedicated owned control `Process` exposes cancellation and `cancelAndWait()`; relaunch terminates only that owned `bin/control` process and waits while Node owns descendant rollback. Coordinator work, including pre-spawn time, participates in `NativeMutationDrain`, and tray termination drains it.

- [ ] **Step 4: Re-run Node and Swift focused tests and verify GREEN**

Run: `node --test test/native-catalog-refresh.test.mjs test/control.test.mjs test/startup-cleanup.test.mjs`

Run: `(cd apps/macos/ModelRouterTray && swift test --filter CodexCatalogRefreshCoordinatorTests)`

Expected: PASS for known/unknown seed/arm/transition, multiple instances, polling recovery, ChatGPT deferral, persisted restart recovery without consuming pending, serialized generation coalescing, current reconciliation, exact suppression, relaunch cancellation/wait/rollback, capture ordering/concurrency, state sanitization, closed command JSON/argv, read-versus-mutation timeout policy, and command compatibility.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && node --test test/service-lifecycle.test.mjs test/graceful-shutdown.test.mjs test/tray-rebuild.test.mjs`

Expected: PASS; do not commit.

### Task 11: Control Plane, Activation, Migration, Downgrade Guard, and Control Center

**Files:**
- Create: `src/quota-fallback-migration.mjs`
- Modify: `src/control.mjs`
- Modify: `src/control-args.mjs`
- Modify: `src/start.mjs`
- Modify: `src/update.mjs`
- Modify: `bin/install`
- Modify: `install.ps1`
- Modify: `apps/control-center/electron/api.d.ts`
- Modify: `apps/control-center/electron/preload.cjs`
- Modify: `apps/control-center/electron/ipc.mjs`
- Modify: `apps/control-center/src/types.ts`
- Modify: `apps/control-center/src/App.tsx`
- Modify: `apps/control-center/src/pages/SettingsPage.tsx`
- Modify: `apps/control-center/test/renderer.test.mjs`
- Create: `test/quota-fallback-migration.test.mjs`
- Modify: `test/chatgpt-account-control.test.mjs`
- Modify: `test/control-center-electron.test.mjs`
- Modify: `test/update-target.test.mjs`
- Modify: `test/installer-scripts.test.mjs`

**Interfaces:**
- Consumes: policy/affinity/catalog APIs, exact-generation service restart pattern from `antigravity-probe-activation.mjs`, legacy metadata-only fallback file.
- Produces: deterministic account-fallback status/on/off/clear/retry/priority/pause/resume commands, `migrateLegacyQuotaFallback()`, generation-observed activation, downgrade refusal, typed Electron bridge, and Settings UI.

- [ ] **Step 1: Write failing mutation, migration, downgrade, and rendered UI tests**

```js
test("fallback on repairs missing selection only under exact canonical identity", async () => {
  assert.deepEqual(await fallbackOn(exactIdentityFixture), { enabled: true, selectedRepaired: true });
  await assert.rejects(fallbackOn(mismatchedIdentityFixture), /selected account proof/i);
  assert.deepEqual(await readPool(), mismatchedIdentityFixture.originalPool);
});

test("legacy Kimi state migrates only when generalized state has no choice", async () => {
  await writeLegacy({ enabled: true, target: "kimi-api/kimi-k3" });
  assert.deepEqual(await migrateLegacyQuotaFallback(), { enabled: true, chain: ["kimi-api/kimi-k3"] });
  assert.equal(await legacyBytes(), originalLegacyBytes);
});

test("downgrade refuses while bindings or journals exist", async () => {
  await assert.rejects(checkDowngradeSafety({ target: "plain-upstream" }), /reset affinity and recover journals/i);
});

test("a pre-activation install failure restores the prior checkout runtime", async () => {
  const result = await injectInstallFailureAfterServiceReplacement();
  assert.deepEqual(result, {
    currentCodeRecovery: "complete",
    checkoutCommit: priorCommit,
    installedCommit: priorCommit,
    serviceHealthy: true,
  });
});
```

Renderer tests must assert the explicit default-off toggle, immutable primary, ordered backup controls, switch-only Windows notice, caller-key/session-sharing consent copy, catalog state, quarantine/capacity copy, and exact typed phrase `START NEW TASKS` before reset becomes callable.

- [ ] **Step 2: Run focused Node and Control Center tests and verify RED**

Run: `node --test test/quota-fallback-migration.test.mjs test/chatgpt-account-control.test.mjs test/control-center-electron.test.mjs test/update-target.test.mjs test/installer-scripts.test.mjs`

Run: `(cd apps/control-center && npm test)`

Expected: FAIL because the commands, activation proof, migration, guard, IPC, and UI do not exist.

- [ ] **Step 3: Implement deterministic controls and generation-observed activation**

```js
export async function setChatGPTAccountFallbackEnabled(enabled) {
  const requestedGeneration = await persistFallbackPolicyUnderProof(enabled);
  await restartRouterService();
  const observed = await pollAuthenticatedHealth({ expectedGeneration: requestedGeneration });
  if (!observed) throw new Error("fallback activation generation was not observed");
  return sanitizedFallbackStatus();
}
```

Use exact account identifiers only in local command input and sanitized versioned output. `on` proves/repairs selection or makes no mutation, then restarts and waits for exact generation through the existing authenticated control surface; public health shape remains unchanged. `off` preserves credentials and affinity. Clear per-account affinity obeys leases; secret reset requires the exact typed phrase and journal. Retry catalog supports optional account. Priority and pause/resume preserve strict order. Windows exposes switching but disables automatic fallback.

Run migration before service startup/listening and during install/update repair: known Kimi target maps to exact one-entry generalized chain, disabled maps disabled, explicit new choice wins, invalid/conflict emits fixed warning, legacy is never edited, account fallback is never enabled. Update refuses checkout to code unable to preserve nonempty bindings, aliases, tombstones, quarantine, capture journals, or profile-switch v3 until current code recovers and the operator explicitly resets/abandons bound tasks. Before explicit `fallback on`, every account-fallback field remains default-off and rollback-compatible. Extend the installer/update failure transaction so a failure after service/app replacement first completes current-code journal recovery, then reinstalls and health-checks the recorded prior commit; an incomplete recovery or prior reinstall is a hard failure, never a successful rollback message.

Wire Electron APIs with closed input/output types. Use existing optimistic rollback only for reversible toggles/reorder/pause; login, removal, retry catalog, clear affinity, and secret reset show confirmed server result only.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `node --test test/quota-fallback-migration.test.mjs test/chatgpt-account-control.test.mjs test/control-center-electron.test.mjs test/update-target.test.mjs test/installer-scripts.test.mjs test/antigravity-probe-activation.test.mjs`

Run: `(cd apps/control-center && npm run check && npm test && npm run build)`

Expected: every new Task 11 assertion passes for exact selection repair/refusal, restart generation, every control mutation, reset confirmation, Windows disablement, migration idempotence/conflict, downgrade refusal/recovery clearance, pre-activation install-failure restoration of the prior checkout/runtime, IPC validation, rendered copy, rollback behavior, and production build. On this installed Mac, the whole `control-center-electron` file may still exhibit only the ledger's inherited `browser opener settlement` cancellation/cascade or `trusted router source root` assertion; isolate every new test and reject any other failure.

- [ ] **Step 5: Controller checkpoint**

Run: `git diff --check && CODEX_ROUTER_SOURCE_ROOT="$PWD" node --test test/setup.test.mjs test/packaged-install.test.mjs test/control-center-harness.test.mjs`

Expected: PASS; do not commit.

### Task 12: Diagnostics, Support-Bundle Secrecy, Operator Documentation, and Install Regression

**Files:**
- Modify: `src/doctor.mjs`
- Modify: `src/support-bundle.mjs`
- Modify: `test/generic-doctor.test.mjs`
- Modify: `test/support-bundle.test.mjs`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/CHATGPT-ACCOUNT-MODES.md`
- Modify: `docs/MACOS-TRAY.md`
- Modify: `docs/DESKTOP-TRAY.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/INSTALL.md`

**Interfaces:**
- Consumes: sanitized account-fallback and lifecycle status APIs only.
- Produces: one doctor row, bounded support-bundle summary, secret exclusion coverage, exact operator runbook and upstream-update explanation.

- [ ] **Step 1: Write failing doctor and exfiltration tests**

```js
test("doctor reports closed account-fallback states", async () => {
  assert.deepEqual(await doctorStates(), [
    "disabled", "ready", "no-backup", "stale-catalog", "reauth-required",
    "affinity-capacity-exhausted", "invalid-state",
  ]);
});

test("support archive contains no seeded forbidden sentinel", async () => {
  const sentinels = await seedEveryForbiddenField();
  const archive = await buildAndReadSupportBundle();
  for (const secret of sentinels) assert.equal(archive.includes(secret), false);
});

test("active refresh remains visible when no rerun is pending", async () => {
  const summary = accountFallbackSupportSummary(activeRefreshFixture);
  assert.equal(summary.lifecycle.active, true);
  assert.equal(summary.lifecycle.pending, false);
  assert.equal(typeof summary.lifecycle.currentAgeSeconds, "number");
});

test("support summary exposes every required consistency boolean without identities", () => {
  const summary = accountFallbackSupportSummary(completeSanitizedFixture);
  assert.equal(typeof summary.selectedAccountConsistent, "boolean");
  assert.equal(typeof summary.catalog.generationAgeSeconds, "number");
  assert.equal(typeof summary.catalog.rawDigestMatches, "boolean");
  assert.equal(typeof summary.catalog.enrichedDigestMatches, "boolean");
  assert.deepEqual(Object.keys(summary.affinitySecret).sort(), ["present", "protected", "valid"]);
  assert.equal(containsOpaqueIdentityOrDigest(summary), false);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/generic-doctor.test.mjs test/support-bundle.test.mjs`

Expected: FAIL because the new diagnostic row and exclusion inventory are absent.

- [ ] **Step 3: Implement sanitized diagnostics and exact documentation**

```js
export function accountFallbackSupportSummary(status) {
  return {
    enabled: status.policy.enabled,
    strategy: status.policy.strategy,
    maxHops: status.policy.maxHops,
    platformSupported: status.platformSupported,
    selectedAccountConsistent: status.selectedAccountConsistent,
    counts: status.sanitizedCounts,
    affinity: status.sanitizedAffinityCounts,
    leases: status.sanitizedLeaseCounts,
    catalog: {
      generationAgeSeconds: status.catalog.generationAgeSeconds,
      rawDigestMatches: status.catalog.rawDigestMatches,
      enrichedDigestMatches: status.catalog.enrichedDigestMatches,
    },
    affinitySecret: {
      present: status.affinitySecret.present,
      protected: status.affinitySecret.protected,
      valid: status.affinitySecret.valid,
    },
    lifecycle: status.sanitizedLifecycleAges,
  };
}
```

Never include raw lifecycle JSON, opaque generations, timestamps, account IDs, digests, family/thread IDs, auth paths, CLI text, exception text, bodies, or prompts. Add the affinity secret, reset transaction root, every account auth path, request leases, and capture journals to blanket secret discovery; tests seed unique sentinels in contents and filenames.

Docs state that updating from upstream alone does not add this feature: the feature lives on this branch until merged upstream, and generic updater refuses feature-branch replacement. Explain strict order, no load balancing, default off, caller-key/session continuity consent, portable new-task boundary, attestation/WebSocket restrictions, manual Windows/Linux catalog refresh, final-Codex-quit macOS refresh, exact commands, recovery/rollback, and removal/secret-reset consequences. `AGENTS.md` records the catalog/fallback maintenance invariants; `SECURITY.md` accurately describes isolated official-CLI auth-writing probes.

- [ ] **Step 4: Re-run diagnostics and documentation guards and verify GREEN**

Run: `node --test test/generic-doctor.test.mjs test/support-bundle.test.mjs test/installer-scripts.test.mjs test/update-target.test.mjs`

Run: `node scripts-check.mjs && git diff --check`

Expected: PASS, with no credential/account/family sentinel in any support artifact and no broken documentation references.

- [ ] **Step 5: Controller checkpoint**

Run: `python3 .agents/skills/repo-maintainer/scripts/repo_maintainer.py analyze --repo . --format markdown`

Expected: analyzer inventories the actual cross-surface diff. Treat credential, routing, protocol, lifecycle, and installer changes as full-release risk regardless of a lower mechanical label; do not commit.

### Task 13: Full Verification, Independent Final Review, Push, Install, and Attended Acceptance

**Files:**
- Create: `docs/reviews/2026-09-05-openai-account-quota-fallback-fable-final-prompt.md`
- Create after the review: `docs/reviews/2026-09-05-openai-account-quota-fallback-fable-final-review.md`
- Modify after successful installation in the configuration repository: `/Users/ryan/claude-config/HANDOFF.md`
- Update durable vault note: `/Users/ryan/Ryan-Brain/2-Areas/Agency/AI-Stack/Codex-Router-Multi-OpenAI-Account-Failover-Research-2026-09-05.md`

**Interfaces:**
- Consumes: the complete implementation diff and all fresh verification evidence.
- Produces: one accepted Fable sentinel, one pushed branch commit, verified remote parity, installed replacement, and a reversible operational handoff.

- [ ] **Step 1: Run the full repository gate without touching live auth or inference**

```bash
set -euo pipefail
npm ci
npm run check
npm audit --omit=dev --audit-level=high
full_test_log=$(mktemp)
trap 'rm -f -- "$full_test_log"' EXIT
set +e
npm test 2>&1 | tee "$full_test_log"
full_test_status=("${PIPESTATUS[@]}")
full_test_rc=${full_test_status[0]}
set -e
test "${full_test_status[1]}" -eq 0
test "$full_test_rc" -eq 0 || test "$full_test_rc" -eq 1
awk '/^not ok/{last=$0} /failureType:/{print last; print}' "$full_test_log"
sh -n install.sh
for file in install.sh bin/* scripts/build-electron-companion.sh scripts/build-macos-tray-app.sh scripts/build-macos-widget.sh packaging/homebrew/check-core-readiness.sh; do
  test "$(head -n 1 "$file")" != '#!/bin/sh' || sh -n "$file"
done
./install.sh --help
rm -f -- "$full_test_log"
trap - EXIT
```

Expected: all deterministic gates exit 0, with no live inference or account login. `npm test` may retain only the exact named machine-state failures and two cancellation roots recorded in the SDD ledger: the Control Center source/protocol bleed-through set, three provider-diagnostics desktop-probe timeouts, one subagent-routing local-state assertion, the browser-opener settlement cancellation/cascade, and the search-sidecar cancellation. Manually compare every printed `not ok`/`failureType` pair with that frozen ledger; any new name, a changed failure type, or a feature-focused failure blocks review. The pushed three-platform CI matrix in Step 6 must still be fully green; local baseline adjudication is not a CI waiver.

- [ ] **Step 2: Run Control Center, Swift, widget, packaging, and rendered-browser verification**

```bash
set -euo pipefail
(cd apps/control-center && npm ci && npm run check && npm test && npm run build)
(cd apps/macos/ModelRouterTray && swift test)
(cd apps/macos/RouterUsageWidget && xcodebuild -project RouterUsageWidget.xcodeproj -scheme RouterUsageWidget -destination 'platform=macOS' test CODE_SIGNING_ALLOWED=NO)
build_root=$(mktemp -d)
trap 'rm -rf -- "$build_root"' EXIT
scripts/build-macos-tray-app.sh "$build_root/Codex Router.app"
codesign --verify --deep --strict "$build_root/Codex Router.app"
git diff --check
rm -rf -- "$build_root"
trap - EXIT
```

Expected: Electron's real Playwright renderer verifies the Settings workflow, Swift unit tests cover lifecycle transitions, widget tests pass, and the built app validates. The validated task-specific temporary directory is removed even on failure.

- [ ] **Step 3: Run focused fault-injection and security acceptance again**

Run: `node --test test/chatgpt-account-affinity.test.mjs test/chatgpt-request-use-lease.test.mjs test/chatgpt-account-catalog.test.mjs test/chatgpt-catalog-capture-journal.test.mjs test/chatgpt-account-fallback-router.test.mjs test/uncommitted-response.test.mjs test/native-catalog-refresh.test.mjs test/support-bundle.test.mjs`

Expected: PASS for every injected crash point, lock race, owner death/unknown identity, catalog partial publish, relaunch cancellation, response commit boundary, and forbidden sentinel.

- [ ] **Step 4: Freeze an exact approved path set, stage it, and review every hunk**

```bash
set -euo pipefail
python3 .agents/skills/repo-maintainer/scripts/repo_maintainer.py analyze --repo . --format markdown
git ls-files -m -o --exclude-standard
git status --short
```

Reconcile the analyzer manifest, the file map in this plan, and `git ls-files -m -o --exclude-standard`. Create the ignored SDD file `.superpowers/sdd/2026-09-05-openai-account-quota-fallback/approved-paths.txt` with `apply_patch`, one exact repository-relative path per line. Do not include `.agents/`, runtime state, logs, caches, builds, `node_modules`, or unrelated user files. Then stage only that closed list:

```bash
set -euo pipefail
git add --pathspec-from-file=.superpowers/sdd/2026-09-05-openai-account-quota-fallback/approved-paths.txt
git diff --cached --name-status
git diff --cached --stat
git diff --cached --check
git diff --cached --no-ext-diff
git diff --name-only
git ls-files -o --exclude-standard
```

Expected: every planned source, new-file hunk, test, installer, generated manifest, lockfile, and documentation change is staged and manually reviewed; there is no unexpected unstaged or untracked path. The only ignored additions are the SDD control artifacts.

Run a fail-closed known-positive scan over the complete staged patch. Build the positive control at runtime so no fake credential-shaped literal is committed:

```bash
set -euo pipefail
scan_input=$(mktemp)
trap 'rm -f -- "$scan_input"' EXIT
secret_pattern='(sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|Bearer[[:space:]]+[A-Za-z0-9._-]{32,})'
positive_prefix='sk-proj-'
positive_body='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
printf '%s%s\n' "$positive_prefix" "$positive_body" | rg -q "$secret_pattern"
git diff --cached --binary --no-ext-diff >"$scan_input"
set +e
rg -q "$secret_pattern" "$scan_input"
scan_rc=$?
set -e
test "$scan_rc" -eq 1
rm -f -- "$scan_input"
trap - EXIT
```

Expected: the detector proves it detects the synthetic control, Git produces the complete staged patch successfully, and the staged patch contains no high-confidence credential. Any deliberate test sentinel must be assembled at runtime rather than embedded as a secret-shaped literal.

- [ ] **Step 5: Obtain the mandatory fresh Fable final review**

Write the bounded final prompt with goal, constraints, exact changed paths/diff, design approval reference, and fresh test evidence. Require actual-file inspection, read-only behavior, no credentials/process environments, no `launchctl print`, no edits/commit/push/memory/vault writes, and exactly one standalone sentinel.

```bash
set -o pipefail
umask 077
FABLE_REVIEW_PROMPT="$(cat docs/reviews/2026-09-05-openai-account-quota-fallback-fable-final-prompt.md)"
AUTOPUSH_REENTRANT=1 /Users/ryan/.local/bin/claude -p \
  --model fable \
  --permission-mode auto \
  --disallowedTools "Edit,Write,NotebookEdit" \
  -- "$FABLE_REVIEW_PROMPT" |
  tee -a /Users/ryan/.claude/logs/fable-final-review.log
```

Expected: exit 0 and exactly one standalone `FABLE_REVIEW: PASS`, with no block sentinel or contradiction. Copy the bounded output and evidence into the final-review artifact with `apply_patch`, stage that one exact artifact, then rerun `git diff --cached --check`, complete staged-hunk review, and the known-positive staged secret scan. If Fable is unavailable or blocks twice, stop without commit, push, install, or a completion claim.

- [ ] **Step 6: Commit the already reviewed index, push it, and run the real three-platform CI matrix**

```bash
set -euo pipefail
git diff --cached --check
git commit -m 'feat: add ChatGPT account quota fallback'
git push -u ryan feat/openai-account-quota-fallback
git fetch ryan feat/openai-account-quota-fallback
test "$(git rev-parse HEAD)" = "$(git rev-parse ryan/feat/openai-account-quota-fallback)"
gh workflow run ci.yml --repo Ryanm218/codex-router --ref feat/openai-account-quota-fallback
ci_run=''
for attempt in {1..12}; do
  ci_run=$(gh run list --repo Ryanm218/codex-router --workflow ci.yml --branch feat/openai-account-quota-fallback --event workflow_dispatch --limit 10 --json databaseId,headSha --jq '.[] | select(.headSha == "'"$(git rev-parse HEAD)"'") | .databaseId' | head -n 1)
  test -n "$ci_run" && break
  sleep 5
done
test -n "$ci_run"
gh run watch "$ci_run" --repo Ryanm218/codex-router --exit-status
```

Expected: one commit for the user task, push succeeds, local/remote SHAs are identical, and the repository's macOS, Linux, and real Windows jobs all pass for that exact SHA. This is the Windows parser/install evidence unavailable on the Mac. If pushed CI fails, do not install or claim completion; stop before rewriting public history unless the user explicitly approves the exact force-push repair.

- [ ] **Step 7: Switch the stable checkout only to the reviewed pushed SHA and install**

```bash
set -euo pipefail
dev=/Users/ryan/code/Codex/codex-router-openai-account-fallback
stable=/Users/ryan/.local/share/codex-router
feature=feat/openai-account-quota-fallback
reviewed_sha=$(git -C "$dev" rev-parse HEAD)
old_branch=$(git -C "$stable" symbolic-ref --short HEAD)
old_sha=$(git -C "$stable" rev-parse HEAD)
test "$old_sha" = 9b05fff0bfe2dc4ea7b9d110bb056ae4477886cf
test "$(git -C "$stable" status --porcelain)" = '?? .agents/'
git -C "$stable" fetch ryan "$feature"
test "$(git -C "$stable" rev-parse "ryan/$feature")" = "$reviewed_sha"
git -C "$dev" diff --quiet
git -C "$dev" diff --cached --quiet
test -z "$(git -C "$dev" ls-files -o --exclude-standard)"
test -n "$(git -C "$dev" ls-tree -r --name-only "$reviewed_sha" -- .agents)"
diff -qr "$stable/.agents" "$dev/.agents"
agents_backup=$(mktemp -d /Users/ryan/.local/share/codex-router-agents-backup.XXXXXX)
install_started=false
rollback_cutover() {
  original_rc=$?
  trap - EXIT
  set +e
  recovery_failed=false
  if [ "$install_started" = true ]; then
    (cd "$stable" && ./bin/control catalog-refresh reconcile) || recovery_failed=true
  fi
  if [ "$recovery_failed" = true ]; then
    printf 'Cutover failed and current-code journal recovery did not complete; leaving the reviewed checkout in place for diagnosis.\n' >&2
    exit 97
  fi
  git -C "$stable" switch "$old_branch" >/dev/null 2>&1 || git -C "$stable" switch --detach "$old_sha" >/dev/null 2>&1 || recovery_failed=true
  if [ ! -e "$stable/.agents" ] && [ -d "$agents_backup/.agents" ]; then mv "$agents_backup/.agents" "$stable/.agents"; fi
  if [ "$install_started" = true ] && [ "$recovery_failed" = false ]; then
    (cd "$stable" && ./bin/install) || recovery_failed=true
  fi
  git -C "$dev" switch "$feature" >/dev/null 2>&1 || recovery_failed=true
  if [ "$recovery_failed" = true ]; then
    printf 'Cutover rollback did not fully restore the old checkout and installed runtime; manual recovery is required.\n' >&2
    exit 98
  fi
  exit "$original_rc"
}
trap rollback_cutover EXIT
mv "$stable/.agents" "$agents_backup/.agents"
git -C "$dev" switch --detach "$reviewed_sha"
git -C "$stable" switch "$feature"
git -C "$stable" branch --set-upstream-to="ryan/$feature" "$feature"
test "$(git -C "$stable" rev-parse HEAD)" = "$reviewed_sha"
diff -qr "$agents_backup/.agents" "$stable/.agents"
install_started=true
(cd "$stable" && ./bin/install)
install_started=false
trap - EXIT
printf 'Retained rollback copy: %s\n' "$agents_backup"
```

Proceed only through the preconditions shown: exact old SHA, exactly one known untracked path, byte-identical reviewed `.agents`, clean reviewed branch, and remote parity. The trap first asks the reviewed current code to reconcile any capture/lifecycle journal, then restores the old checkout, original untracked directory, and old installed runtime. If current-code recovery fails, it deliberately leaves the reviewed checkout in place instead of running old code over unresolved state. If the old reinstall fails, it exits with a distinct hard failure and no completion claim. Task 11's failure-injection tests must prove that install/update repair remains rollback-compatible while account fallback is still default-off. On success the stable checkout owns the feature branch, the development worktree is detached, and the private backup remains until installed acceptance completes.

- [ ] **Step 8: Enable the approved installed policy through control and verify without inference**

```bash
set -euo pipefail
(
  cd /Users/ryan/.local/share/codex-router
  ./bin/control chatgpt-account-fallback on
  ./bin/control chatgpt-account-fallback status
  ./bin/control catalog-refresh status
  ./bin/status
  ./bin/doctor
  node src/install-manifest.mjs status
  test "$(git rev-parse HEAD)" = "$(git rev-parse ryan/feat/openai-account-quota-fallback)"
  test -z "$(git status --porcelain)"
)
codesign --verify --deep --strict "$HOME/Applications/Codex Router.app"
```

Expected: exact-generation activation is observed; selected account is either already valid or repaired under exact proof; fallback is enabled with a documented no-backup no-op if no enrolled backup exists; legacy generalized Kimi chain remains enabled as previously configured; Astra appears through safe catalog/status inspection; `bin/status`, doctor, the private install manifest, app signature, installed source root, and active service/tray all point to the pushed SHA. The stable checkout is clean because `.agents/` is tracked on the reviewed branch. Do not inspect credentials, trigger inference, or quit Codex.

- [ ] **Step 9: Verify the installed UI and separate the two attended operational acceptances**

Open the installed Control Center and inspect the rendered Settings section: enabled state, immutable primary, backup/catalog state, consent copy, and reset guard. Do not close Codex.

If an already-enrolled backup is naturally exhausted or has a safe controlled quota result, perform one attended, user-initiated portable request and prove the exact attempt order plus affinity result from sanitized status. Never spend quota merely to manufacture this condition, never automate login, and never use an auth failure as a quota surrogate. If no such account exists, mark real account-hop behavior `PENDING: no controlled exhausted enrolled account`; implementation and deterministic acceptance may pass, but do not call the account hop production-observed.

Separately record that the next ordinary user-driven final Codex quit is the safe production acceptance for automatic refresh. Verify its persisted result afterward with `control catalog-refresh status`; never force Codex to quit for this test. These two pending observations are not interchangeable.

- [ ] **Step 10: Update and push the durable handoff and vault record in their owning repositories**

Record what changed, why, exact pushed/installed SHA, verification evidence, default/installed policy, remaining no-backup condition if applicable, attestation-presence acceptance status, next-quit acceptance, and rollback. Operational rollback is first `chatgpt-account-fallback off`; code rollback to `9b05fff0bfe2dc4ea7b9d110bb056ae4477886cf` requires current-code journal recovery, explicit affinity reset with task abandonment, and clean state before checkout. The router implementation remains its one reviewed commit. Update `/Users/ryan/claude-config/HANDOFF.md` and the existing Ryan-Brain note after installation, then commit/push only those documentation deltas in their owning repositories under their established policies.

Expected: the router branch remains one pushed commit, the stable install is reviewable and reversible, the retained `.agents` rollback copy is removed only after acceptance or explicitly recorded for later recovery, and every durable record distinguishes deterministic verification, real Windows CI, installed non-inference acceptance, an observed or pending real account hop, and the deferred user-driven quit acceptance.

---

## Acceptance Ledger

- State/security: closed schemas, secret isolation, exact identity, lock order, leases, reservations, tombstones, quarantine, reset transaction, downgrade guard.
- Routing: authoritative quota only, core/account portability split, attestation three-state rule, WebSocket deny-only rule, one deadline, zero-send collision, exact commit point, bound continuation, strict account order, one terminal external hop.
- Catalog: trusted desktop binary, pre-GO journal, raw fixture, five artifacts, marker last, profile-switch v3, lock-free generation proof, seven-day compatibility bound, last-known-good behavior.
- Lifecycle: armed final-Codex transition, exact managed suppression, ChatGPT deferral, persistent pending/current reconciliation, relaunch abort/rollback, primary-first plus backup concurrency two, manual non-macOS path.
- UX/operations: default-off consent, exact controls, typed destructive reset, migration, doctor, sanitized support bundle, docs, upstream-update explanation.
- Delivery: full test/build/audit/codesign/browser gates, independent Fable final pass, one commit, pushed parity, reviewed-SHA install, non-inference acceptance, durable rollback record.
