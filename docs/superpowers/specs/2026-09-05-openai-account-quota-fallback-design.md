# OpenAI account quota fallback — design

**Date:** 2026-09-05
**Status:** design approved; implementation may proceed under the TDD plan and
remains subject to a fresh final Fable review before commit/push/install
**Approval:** Ryan approved the strict-priority design in the active Codex task on
2026-09-05.
**Fable approval:** cycle 4 returned exactly one standalone
`FABLE_DESIGN: PASS` at exit 0 after reviewing the implemented bounded scope;
see
`docs/reviews/2026-09-05-openai-account-quota-fallback-fable-design-cycle-4.md`.
**Implementation base:** upstream `origin/main` at
`5db9b314d313067a17851f6bcb20ce12fcc05e29`
**Operational rollback:** the installed checkout remains at
`9b05fff0bfe2dc4ea7b9d110bb056ae4477886cf` until the replacement passes review,
tests, installation checks, and attended acceptance.

## Decision

Codex Router will support an explicit, default-off, strict-priority fallback
sequence for native OpenAI Codex traffic:

1. the OpenAI account already active in the calling Codex process;
2. enabled fallback OpenAI accounts, in operator-defined order;
3. the existing external-model failover chain, configured on Ryan's install to
   end at `kimi-api/kimi-k3`.

This is failover, not load balancing. A healthy primary remains preferred for a
new task. Once a task family succeeds on a backup account, durable affinity keeps
that family on the same account. The router does not round-robin healthy work
across subscriptions.

The implementation will build on upstream's isolated ChatGPT account profiles,
not add another proxy, database, daemon, or canonical-auth-file swap. The old
feature branch remains the live rollback point while the new upstream-based
branch is developed in an isolated worktree.

## Grounding and prior art

The durable grounding note is
`2-Areas/Agency/AI-Stack/Codex-Router-Multi-OpenAI-Account-Failover-Research-2026-09-05.md`.
It is marked `PARTIAL` because Research Index and Firecrawl canonical acquisition
were unavailable. The cautious defaults are nevertheless anchored in:

- OAuth 2.0 Security Best Current Practice, RFC 9700 §§2.2–2.3 and 4.14.2;
- HTTP Semantics, RFC 9110 §9.2.2;
- the gRPC retry commit-point model;
- OpenAI's Codex authentication and credential-storage documentation;
- upstream Codex Router's safe, switch-only account profiles;
- maintained multi-account implementations `codex-multi-auth` and `codex-lb`.

Prior-art verdict: **EXISTS — BUT INSUFFICIENT**. Both external projects prove
multi-account failover can work, but importing either would create a competing
config, proxy, service, and credential owner. We will adapt their bounded-retry,
affinity, eligibility, and replay-safety tests to the existing router.

## Goals

- Let one portable native Responses turn survive confirmed terminal quota
  exhaustion by trying another enrolled OpenAI account before Kimi.
- Keep tokens and raw credential material inside the account's existing private
  `CODEX_HOME`; no credential value enters routing metadata, logs, status JSON,
  telemetry, support bundles, command arguments, or Git.
- Preserve task continuity by binding a root task and its subagents to one
  successful account.
- Attempt only accounts whose own current catalog can serve the requested native
  model.
- Reuse the existing no-visible-response retry boundary and make every attempt
  bounded.
- Extend the existing final-Codex-quit lifecycle refresh so primary and backup
  catalogs stay current without a scheduler or a second process observer.
- Preserve existing behavior byte-for-byte when OpenAI-account fallback is off
  or no backup is eligible.
- Preserve Ryan's current `primary OpenAI -> Kimi K3` operational behavior during
  the migration to upstream's generalized model-failover subsystem.

## Non-goals

- Creating accounts, automating sign-up, bypassing provider entitlements, or
  claiming that automatic account pooling is endorsed by OpenAI.
- Sharing accounts or credentials between users or machines.
- Round-robin balancing, quota harvesting, or choosing accounts by advertised
  remaining balance.
- Retrying ordinary 429s, 5xx responses, network failures, authentication
  failures, entitlement failures, malformed requests, or free-text errors in
  version one.
- Moving an already-committed or partially streamed response to another account.
- Cross-account replay of file, response, conversation, compaction, reasoning,
  encrypted collaboration, or other opaque account-owned state.
- Advertising backup-only native model slugs in the global picker in version
  one.
- Replacing the canonical active `~/.codex/auth.json` per request.
- Forcing Codex to quit, running a live inference without separate approval, or
  reading credential contents during installation/verification.

## Migration strategy

The current branch is four commits ahead and 984 commits behind upstream, with
26 static three-way conflict paths. The old implementation commits must not be
rebased, merged, or cherry-picked wholesale.

The new branch starts at the exact upstream SHA above. The implementation will:

1. retain upstream's account-pool, profile-switch, publication-lock, generalized
   model-failover, request-building, and Control Center architecture;
2. reimplement the narrow native terminal-quota contract using current upstream
   primitives;
3. port only the final-Codex-quit transition coordinator and the strict
   account-catalog acquisition/validation invariants from `9b05fff`;
4. migrate the installed legacy Kimi fallback setting into upstream's
   `failover.json` without deleting the legacy file;
5. leave the stable checkout and installed app at `9b05fff` until the new branch
   has passed all reviews and tests and is pushed;
6. switch the stable checkout only after preserving its untracked `.agents/`,
   then rebuild/install from the stable checkout rather than the development
   worktree.

The upstream endpoint split supersedes the old Kimi endpoint patch. Upstream's
general failover, cooldown, telemetry, request normalization, and response
priming supersede the old fixed `quota-fallback.json` runtime. The legacy branch
remains in Git as the complete rollback.

### Implemented scope and deferred safety layers

This checkout implements the bounded first-turn rescue path: exact native quota
classification, isolated identity attestation, per-account locks and request
leases, catalog readiness observations, and final-exit catalog refresh. Durable
task-family affinity, tombstones/reset, the native-to-Kimi adapter, and a shared
cross-provider attempt budget remain deferred. Consequently a rescued turn is
not sticky across later turns, and the existing external failover chain remains
the only path after account fallback returns no eligible response. Opaque
account-bound headers or body references intentionally disable account fallback
rather than being replayed. Native Responses WebSocket first turns follow the
same bounded eligibility and portability rules as HTTP first turns; a later
frame carrying opaque turn state is not portable. A dedicated deny-only
WebSocket transport marker, transport-specific binding rules, and a blanket
WebSocket no-hop rule are deferred rather than claimed by this checkout. The
lightweight fallback readiness capture is stored as
`router-catalog/fallback-native-models.json`, deliberately separate from the
`native-models.json` artifact owned by profile-switch snapshot and restore.

## Account and policy model

### Existing account profiles

Continue using upstream's `chatgpt-account-pool.json` and
`chatgpt-accounts/<acct_id>/` homes. Account profile creation, browser sign-in,
login leases, identity verification, path validation, symlink rejection,
owner-only modes, atomic auth replacement, token refresh, catalog snapshots, and
explicit profile switching remain owned by the current upstream modules.

The account selected and active in Codex is the primary. Runtime fallback never
invokes profile switching and never writes the canonical active auth or catalog.
It takes a validated in-memory snapshot of a backup profile's request headers,
releases its lock, performs the request, then records only sanitized outcome
state.

### Backward-compatible fallback policy and affinity

Retain account-pool schema version 1 and add optional closed-world policy and
session fields. This uses the already-declared `sessions` field instead of
introducing separate policy and affinity files, preserves `mode: "switch"` for
explicit profile selection, and lets an unmodified upstream rollback continue
to read the account pool. Plain upstream can ignore/drop the additive fields and
keep explicit switching usable, but doing so also loses tombstone/quarantine
enforcement. The installer therefore refuses a plain-upstream/old-router
downgrade while bindings, aliases, tombstones, or quarantine are non-empty
unless the operator explicitly resets affinity and agrees to start new tasks;
field dropping is not described as safe for old continuation-shaped work:

```json
{
  "version": 1,
  "policy": {
    "enabled": true,
    "mode": "switch",
    "selectedAccountId": "acct_local_opaque_id",
    "fallback": {
      "enabled": false,
      "strategy": "strict-priority",
      "maxHops": 2,
      "affinityTtlSeconds": 604800
    }
  },
  "accounts": {},
  "sessions": {
    "version": 1,
    "epoch": "AAAAAAAAAAAAAAAAAAAAAA",
    "bindings": {},
    "aliases": {},
    "quarantine": null
  }
}
```

- An existing version-1 document without the optional fields reads with fallback
  disabled and its accounts/selection unchanged.
- The revised reader explicitly validates and preserves only the declared
  fallback and session keys; unknown keys fail closed for fallback but do not
  make explicit profile switching unusable. An invalid/unreadable sessions
  subtree sets in-memory affinity quarantine rather than assuming it was empty.
- Missing fallback policy means disabled.
- Invalid or unreadable fallback policy means disabled without making explicit
  account switching unusable.
- `maxHops` counts backup OpenAI accounts and is clamped to 0–2 in version one;
  default 2. A separate final external-model hop is allowed, so a native-origin
  turn has at most three post-primary attempts: backup one, backup two, and one
  external destination. Routed-origin failover retains upstream's existing
  two-hop behavior.
- `affinityTtlSeconds` is fixed at seven days in version one and bounded by
  validation.
- Backup order is ascending existing account `priority`, then ascending opaque
  account ID as the deterministic tie-breaker.
- The selected/active account is always first and is never duplicated in the
  backup sequence.
- Paused, revoked, unusable, reauthentication-required, cooldown-active, or
  model-ineligible accounts are skipped.

The repository default stays off. Ryan's installed instance may be turned on
after the branch is installed because the active task explicitly approved it.
With no enrolled backup it is a no-op before the existing model-failover chain.

### Per-account fallback observations

Do not widen upstream's closed `health.state` enum. It remains exactly
`healthy`, `cooldown`, `reauth-required`, or `failed` for the meanings upstream
already owns. Account-fallback-only observations live in an optional,
closed-world `account.fallback` object:

```json
{
  "enabled": true,
  "quota": {
    "state": "clear",
    "observedAt": "2026-09-05T00:00:00.000Z",
    "cooldownUntil": null
  },
  "catalog": {
    "state": "ready",
    "generation": "opaque_generation",
    "capturedAt": "2026-09-05T00:00:00.000Z",
    "lastAttemptAt": "2026-09-05T00:00:00.000Z",
    "lastResult": "ok"
  }
}
```

- `enabled` is the per-account inclusion switch and defaults to true for an
  active, non-paused backup.
- `quota.state` is exactly `clear`, `cooldown`, or `unknown`; `cooldownUntil`
  is present only when the provider supplied an authoritative bounded reset.
- `catalog.state` is exactly `ready`, `missing`, `stale`, `invalid`, or
  `refresh-pending`; `lastResult` is exactly one of `never`, `ok`,
  `last-known-good`, `missing`, `invalid`, `incompatible`, `too-old`,
  `reauth-required`, `login-busy`, `request-in-use`, `refresh-pending`,
  `skipped-user-owned-source`, `skipped-discovery-disabled`,
  `unsupported-platform`, `unsupported-cache-schema`, `probe-failed`,
  `publication-failed`, `identity-changed`, or `cancelled-relaunch`.
- Reauthentication continues to use upstream's existing
  `health.state = "reauth-required"`; fallback never invents a second auth
  state.
- Unknown keys or enum values disable that account for automatic fallback but
  do not invalidate the account for explicit profile switching. Plain upstream
  may drop this additive object on mutation, which safely returns it to the
  default-off behavior.

### Affinity

The additive, closed-world `sessions` object owns affinity and has exactly
`{version:1,epoch,bindings,aliases,quarantine}`. `epoch` is a fresh 128-bit
base64url nonce created on first explicit enable and changed only by destructive
secret reset. `quarantine` is null in normal
operation or exactly `{state:"affinity-secret-invalid",detectedAt,bindingCount,
aliasCount}`; its counts are bounded non-negative integers and carry no digest
or account identity. Keys in both maps are
HMAC-SHA-256 of the stable root task-family ID using a new dedicated secret at
exactly `STATE_DIR/chatgpt-account-affinity-secret`; caller-key rotation must
not invalidate account bindings. The path is exported as
`CHATGPT_ACCOUNT_AFFINITY_SECRET_PATH` from `src/paths.mjs`. Raw thread,
session, parent, prompt, or account-identity values are not persisted. Values
in `bindings` have common fields exactly `state`, `generation`, `createdAt`,
`lastUsedAt`, `requests`, `turns`, and `reason`. `reserved` requires those
fields plus exactly `accountId` and `reservedUntil`; `bound` requires them plus
exactly `accountId`, `boundAt`, and `expiresAt`.
`tombstone` requires the common fields plus exactly `tombstonedAt`, has no
`accountId` or `expiresAt`, and is permanent until the explicit secret-reset
operation below. `state` is exactly `reserved`, `bound`, or `tombstone`; an
account ID is one opaque managed ID; `generation` is a fresh 128-bit base64url
nonce; timestamps are canonical ISO-8601 strings; counters are integers from
zero through `Number.MAX_SAFE_INTEGER`. `requests` is the cumulative count of
managed-account upstream sends for the root and `turns` is the cumulative count
of distinct router turns that resolved the record. Both start at zero, advance
only in a successful locked compare-and-swap, saturate at
`Number.MAX_SAFE_INTEGER`, and survive reserved-account rollover, promotion,
and tombstoning.

The reason enum for reserved/bound records is `terminal-quota`, `inherited`, or
`operator`. For tombstones it is exactly `account-removed`, `account-revoked`,
`account-paused`, `fallback-disabled`, `binding-expired`, or
`operator-cleared`, or `reservation-owner-lost`. Alias values are also
closed-world and discriminated:
`live` is exactly `{state:"live",rootDigest,createdAt,lastUsedAt,expiresAt}`;
`tombstone` is exactly
`{state:"tombstone",rootDigest,createdAt,lastUsedAt,tombstonedAt}`. An alias
cannot point to another alias. Digests are 43-character base64url HMACs;
account IDs and reservation generations retain their existing bounded
validators. The epoch is never emitted in status, logs, telemetry, or support
output. Every request captures it with the initial locked affinity snapshot and
must match a fresh locked read before creating an alias or reservation; a reset
during an unbound primary attempt therefore makes that request skip managed
accounts instead of persisting a digest made with the retired secret.

Limit `bindings + aliases` to 2,048 entries and reject alias cycles or dangling
roots. There is no LRU or time-based eviction into absence. A used live `bound`
record or alias transactionally refreshes the root and every resolving live
alias to the same seven-day expiry. A `reserved` root whose owner or deadline
rule below fails, or an expired `bound` root, converts in-place to a permanent
tombstone, and every resolving alias converts in-place to a permanent tombstone
alias. Removal, revocation, pause, disable, or ordinary clear-affinity does the
same. Tombstones and their resolving aliases never
expire, are never evicted, and can be removed only by
`clear-affinity --reset-secret`. When the 2,048-entry limit leaves no room, an
already resolved family continues under its existing record, but the router
refuses any new reservation or required child alias instead of deleting safety
evidence. A new-root fallback that cannot reserve returns the byte-identical
original primary response with fixed diagnostic code
`affinity-capacity-exhausted` after sending no backup request, unless the
request independently passes the core-portability gate and can continue to the
single Kimi attempt. A bound child that cannot persist its required alias
returns local HTTP 409 with fixed type
`local_router_affinity_capacity_exhausted` before reading a stored account
credential or sending any account/external request. A matching tombstone
returns local HTTP 409 with fixed type
`local_router_account_restart_required` before any primary, backup, or external
send.

A fail-closed in-memory `affinityEnforcementRequired` bit is loaded before the
router listens and refreshed only from successful locked pool writes. It is
true whenever a binding, alias, tombstone, or quarantine exists; unreadable or
invalid session state sets it true and enters an in-memory uncertain state with
the same request restrictions as quarantine. Disabling new fallback therefore
does not bypass enforcement. A request can take the byte-identical zero-overhead
primary path only when both fallback is off and this bit is proven false;
otherwise it performs the bounded family/tombstone check before the first
upstream send. With a valid secret and successfully validated, non-quarantined
session state, a continuation-shaped request that matches no binding, alias, or
tombstone is proven primary-owned and proceeds on primary even when unrelated
affinity records exist. Only quarantine or uncertain session validity makes an
unresolved continuation return the fixed reset-required local 409. Stateless
new work may still use primary in either state without account fallback and,
after an exact primary terminal-quota result, may use the independently gated
single Kimi attempt when core portability passes.

The affinity-secret lifecycle is exact and fail closed:

- automatic fallback version one is POSIX-only (`darwin`, `linux`, and
  `freebsd`); Windows remains explicit switch-only and the enable control
  returns `unsupported-platform`, avoiding a 15-second PowerShell ACL probe on
  a request path;
- the explicit `fallback on` control, while holding the account-pool lock,
  creates the secret only when absent as 48 random bytes encoded base64url plus
  one newline, using an exclusive mode-`0600` temporary and atomic rename into
  the already-private mode-`0700` state directory, then persists the initial
  session epoch in the same locked pool mutation. If that pool write fails, the
  still-empty state contains no binding; the unused valid secret may be reused
  by the next explicit enable, which creates a fresh epoch before routing;
- an existing secret is accepted only when every parent is non-symlink, the
  target is a current-UID-owned regular non-symlink file, mode exactly `0600`,
  size exactly 65 bytes, and contents match 64 base64url characters plus the
  newline; pre-read and post-read `dev`, `ino`, `uid`, `mode`, `size`, and
  `mtimeMs` must match;
- an absent secret with an empty `sessions` map may be created only by that
  explicit enable operation. An absent, unreadable, replaced, or malformed
  secret with persisted bindings/aliases preserves those records, sets the
  global affinity quarantine, and disables automatic managed-account fallback;
  the request path never creates, replaces, repairs, or pretends it can match
  the old HMACs;
- while quarantined, only a stateless new primary request may reach OpenAI; it
  skips every managed backup but may continue to the independently gated single
  Kimi attempt after an exact primary terminal-quota result. Any continuation-
  shaped request—including turn-state,
  previous response/conversation/file IDs, opaque reasoning/collaboration, or
  compaction material—returns local HTTP 409 with fixed type
  `local_router_affinity_reset_required` before reading any account credential
  or sending primary/backup/external traffic;
- `clear-affinity --reset-secret` is the only recovery operation: it uses the
  rollback-journal transaction below to clear bindings, aliases, and quarantine,
  replace the secret, and record a fixed audit/status result plus an operator
  warning to start new tasks. Ordinary `clear-affinity` leaves the secret in
  place and writes tombstones. No automatic rotation is allowed;
- neither secret bytes nor their digest enter logs, status, telemetry, support
  bundles, subprocess arguments, or Git. Doctor reports only
  `present/protected/valid` booleans.

Secret reset is a cross-file transaction, not a claimed atomic rename. Its
fixed private directory is
`STATE_DIR/chatgpt-account-affinity-reset-transaction`, mode `0700`, with
mode-`0600` fixed files `journal.json`, `pool.before`, `secret.before`, and
`secret.new`. The closed journal is exactly
`{version:1,state:"prepared",createdAt,poolBeforePresent,secretBeforePresent}`;
it contains no secret, digest, account ID, or variable path. The reset protocol
is exact:

1. recover any older transaction before accepting a control mutation or
   listening for requests, then acquire the account-pool lock;
2. recover completed/stale profile-switch and catalog-capture journals, reject
   fixed code `affinity-reset-busy` if any login lease, live/unknown request-use
   lease, or live/unknown profile/catalog transaction remains, and keep the pool
   lock so no new request lease or account mutation can start;
3. create the transaction directory exclusively, safely snapshot the exact
   pre-operation pool bytes and the exact safe-readable current secret bytes or
   absence—the secret before-image must be a current-UID-owned regular
   non-symlink file of at most 4 KiB even when malformed—stage the validated
   fresh 65-byte secret, fsync every file, then atomically publish and fsync
   `journal.json` as the prepared marker;
4. use the normal atomic pool writer to publish the unchanged account/policy
   data with a fresh epoch, empty bindings/aliases, null quarantine, and the
   fixed reset audit result, then atomically install `secret.new`; fsync both
   files and the state directory;
5. make that pair the commit point by unlinking `journal.json` and fsyncing its
   directory, then delete only the validated transaction directory. A crash
   after the marker unlink but before cleanup leaves a committed pair and an
   orphan that startup removes without restoring it.

If `journal.json` exists at startup or control entry, recovery always restores
both before-images (including exact absence) with the same atomic writers before
removing and fsyncing the marker; it never tries to infer which forward write
won. Restore failure retains the transaction, enters uncertain affinity state,
disables managed-account fallback, and applies the quarantine continuation
rules. A reset refuses an unsafe/unreadable before-image rather than deleting
it. Ordinary global or account-specific `clear-affinity` is a single locked pool
write but uses the same live/unknown login/request/profile/catalog exclusion.
Crash-injection tests cover every snapshot, marker, pool-write, secret-rename,
fsync, marker-unlink, restore, and cleanup boundary. The transaction directory
and its before-images are blanket-excluded from support bundles and diagnostics.

Add a routing-specific family resolver instead of relying on
`activityMetadataFromHeaders()`'s current process-lifetime negative cache.
Positive child-to-root results may be cached; misses never are. The resolver
uses HMAC digests only in persisted aliases:

- only a request with no `x-openai-subagent`, no verified parent-thread header,
  and no positive spawn/rollout parent record may use its direct thread UUID as
  a root and open a new reservation; absence of all three is the exact root
  proof;
- a request carrying `x-openai-subagent`, a verified parent-thread header, or
  subagent rollout metadata may inherit an existing parent/root binding, but it
  may never create a new reservation;
- when a child inherits, persist a bounded live child-digest -> root-family-
  digest alias with the root's same expiry, so a grandchild can resolve the
  established root; failure to reserve capacity returns the fixed local
  capacity 409 before any stored-account credential read or upstream send;
- positive rollout metadata may refine a direct parent chain, but an absent or
  partially written rollout file is never cached as a root decision;
- if no existing root binding can be proven, the subagent stays on the active
  OpenAI primary for managed-account routing. The `x-openai-subagent` marker by
  itself does not prohibit the independent external hop; Kimi remains possible
  only when the same request separately passes every core-portability check,
  including the encrypted-collaboration and unknown-field exclusions.

This prevents a child observed before its rollout file is complete from binding
a second account and prevents account-specific encrypted state from crossing
identities.

Before sending the first backup request, create a compare-and-swap `reserved`
entry under the pool lock. `reservedUntil` is the canonical wall-clock instant
computed at creation from the remaining monotonic
`FailoverAttemptContext.deadlineAt`; it can never exceed 30 seconds after the
context's start and is never extended. The owning in-memory attempt context
retains an unexposed tuple of `{epoch,rootDigest,generation,accountId}`. Only
that same context presenting an exact tuple and still-live monotonic deadline
may use, advance, clear, or promote the reservation. A generation read from the
pool is never treated as ownership, and the tuple never enters request headers,
status, logs, telemetry, or support output. It is never serialized as a tuple;
its individual fields appear on disk only in the already-declared session key,
epoch, reservation, and matching request-use-lease fields.

A different HTTP or WebSocket request that observes `reserved` waits outside
the lock for at most 250 ms and re-reads once. If it then sees `bound`, normal
same-account affinity applies; if the record was safely cleared, it proceeds on
the original primary path; if it remains `reserved`, it returns local HTTP 409
with fixed type `local_router_account_fallback_in_progress` and sends no
primary, backup, or Kimi request. It never uses the reserved account and never
creates another reservation. On router startup, before listening, every
persisted `reserved` record necessarily lacks its owning in-memory context and
is atomically converted with its aliases to a permanent
`reservation-owner-lost` tombstone. In a live process, reaching either the
monotonic context deadline or `reservedUntil` does the same before any further
send.

Every CAS requires the tuple's epoch to remain current. After backup N returns
exact terminal quota and its observation is durably recorded, the owner
releases that account's request-use lease and performs one locked compare-and-
swap on the matching tuple. If another eligible account
exists, it replaces the same root in-place with that next account, a fresh
128-bit generation, and the unchanged original `reservedUntil`; `createdAt`,
`requests`, and `turns` preserve the root's cumulative history and `lastUsedAt`
advances. The context adopts the new tuple only after that write succeeds. If
no account remains, it deletes only the matching reservation before entering
the independent external hop. CAS, durable observation, lease-release, or
clear failure stops the sequence and returns the untouched primary response;
it never advances to another account or Kimi with ambiguous reservation state.

After a successful backup response has been body-primed but before its first
byte is relayed, only the owner promotes the exact reservation generation to
`bound`, preserving its cumulative counters and setting `boundAt` plus a fresh
seven-day `expiresAt`. A failed, aborted, or rejected attempt may clear only the
owner's matching generation while it is still within deadline and no
persistence uncertainty occurred. If promotion persistence fails, the candidate
is discarded without exposing a byte and the reservation remains conservative
until its deadline converts it to a tombstone; the untouched primary response
is returned. Once bound, the family does not drift back to the primary or
another backup mid-task.

In practice, Codex carries encrypted reasoning or other opaque continuation on
most turns after the first. The feature therefore primarily rescues a new task
started after quota exhaustion. A mid-task turn on an exhausted primary normally
returns that primary error and asks the operator to start a new task. Control
Center copy must say this plainly; cross-account opaque-state continuation is
not promised.

## Credential boundary

Add a narrow account-request credential resolver to the existing native-session
module or a sibling module. For a backup account it must:

1. require discovery/account-profile support to be enabled;
2. validate every parent path and require the account home and auth file to be
   current-user-owned, non-symlink, regular, and owner-only;
3. parse only the existing private auth file in memory;
4. require a non-expired access token and matching non-empty ChatGPT account ID;
5. return an ephemeral `{ Authorization, ChatGPT-Account-Id }` header object;
6. never expose it to a status object, exception string, log, event, snapshot,
   support bundle, subprocess argument, or persisted state;
7. zero or release references as soon as the attempt completes, to the extent
   JavaScript permits.

The incoming request remains authoritative for the active primary. Add a
ChatGPT-only matcher beside, rather than weakening,
`nativeSessionTokenMatches()`: the current helper intentionally accepts Codex
API-key mode for direct endpoint authentication, so it is not sufficient to
authorize subscription-account rotation.

Split route authentication from upstream-credential provenance instead of
reconstructing either after substitution. `authenticatedCallerRoute()` returns
an immutable `{ pathname, routeAuthClass }` rather than only a pathname;
`routeAuthClass` is exactly `capability-path`, `capability-bearer`, or
`native-token`. Independently, a replacement for the bare `nativeHeaders()`
return value carries `{ headers, credentialSource }`, where
`credentialSource` is exactly `caller-chatgpt`, `caller-api-key`,
`substituted-chatgpt`, `router-capability`, `none`, or `other`. The original
Authorization and account-ID values are compared in constant time and then
discarded; neither class contains credential material.

The two axes deliberately do not use path-first precedence. For example, a
capability-bearing path with the exact canonical ChatGPT bearer/account pair is
`{routeAuthClass:"capability-path", credentialSource:"caller-chatgpt"}` and is
eligible under the direct canonical proof. The same path with no upstream
credential is eligible only when `nativeHeaders()` actually performed the
consented canonical substitution and reported `substituted-chatgpt`. A path
with an API key or arbitrary bearer stays ineligible. Direct API-key mode
continues to authenticate the endpoint as `native-token` plus
`caller-api-key`, but never authorizes subscription-account rotation.

At the fallback decision point, atomically snapshot these three independently
validated facts:

1. canonical `CODEX_AUTH_PATH` is a protected ChatGPT-token auth document and
   its current access token and provider account ID are usable;
2. `chatgpt-profile-switch.json.active` and
   `chatgpt-account-pool.json.policy.selectedAccountId` name the same managed
   opaque account ID; and
3. that managed account's persisted `identity.accountId` equals the canonical
   auth document's provider account ID.

Backup rotation is permitted only when that selected-account proof holds and
either:

- `credentialSource` is `caller-chatgpt`, the request bearer matches the
  freshly read canonical ChatGPT access token
  in constant time **and** its incoming `chatgpt-account-id` equals the same
  canonical provider account ID; or
- `credentialSource` is `substituted-chatgpt`, the request authenticated through
  a router-local path/bearer capability, `nativeSessionSharingEnabled()` is
  true, and the header builder substituted that same canonical token/account
  pair.

API-key mode, a stale saved-profile token, an arbitrary bearer, a missing or
mismatched account header, selected/active disagreement, and an unenrolled
canonical identity never qualify. Equality operands are never logged or
persisted. The decision is revalidated immediately before the first backup
send.

When an affinity or candidate names the currently selected managed account,
the router performs **selected-account passthrough**: it uses the already-built
primary target, body, and headers byte-for-byte, does not read the saved profile
copy, and does not replace either credential header. A bound selected-account
turn still creates the ordinary per-account request-use lease solely to exclude
profile/affinity mutation while it is in flight; an unbound ordinary primary
does not. This handles a selected-account binding without sending the same
primary request twice and prevents an older profile token from overriding the
canonical active token.

If a backup returns 401, set
`account.fallback.catalog.state = "refresh-pending"`, trigger the existing bounded
background official-CLI refresh, and stop the account sequence for this turn.
Do not refresh inline: the CLI timeout and profile finalization can consume the
entire failover budget and acquire the same pool/catalog locks. A repeated or
failed refresh moves the account to `reauth-required` on the existing background
path.

## Request eligibility and replay safety

The automatic account path applies only to caller-authenticated native
`/responses` requests. Complete Responses WebSocket requests re-enter the same
HTTP handler with the original ChatGPT bearer and account identity preserved,
so a portable first turn follows the same bounded eligibility rules as a direct
HTTP first turn. Later frames carrying opaque turn state fail the shared
portability gate. Version one excludes
`/responses/compact`, image-description work, agent-payload relay/decryption
calls, vision-bridge reads, search sidecars, Cursor/Claude/Gemini translations,
every other router-originated native call, and every billed or non-native
endpoint. Those auxiliary calls remain primary-only even when their outer user
turn later qualifies.

Core native-origin portability, shared by OpenAI-account and external-model
fallback, requires all of these:

- the body has already been read into the router's immutable bounded Buffer;
- no response headers or body bytes have been exposed to Codex;
- the upstream response is a complete, bounded, parseable structured terminal
  quota error under the native classifier;
- no `previous_response_id` is present;
- no uploaded file/file reference, conversation identifier, opaque turn state,
  opaque reasoning item, compaction state/trigger, or unknown native continuation
  field is present;
- the request is unbound and has no `x-codex-turn-state`; that upstream-issued
  continuation state blocks a first account or external hop even when the JSON
  body looks portable;
- `x-oai-attestation` is not present;
- no Fernet/encrypted native collaboration payload or other account-owned
  ciphertext is present.

Managed OpenAI-account fallback additionally requires a stable proven root
task-family identifier, valid affinity secret/state, the caller and selected-
account proof above, an available reservation, and a generation-verified target
catalog with compatible metadata. Failure of one of those account-only
requirements skips OpenAI backups but does not by itself prohibit the existing
native-to-external path. Thus a portable stateless request with no stable root
may still make the single configured Kimi attempt, while a request with opaque
state, turn-state, or attestation may make neither kind of hop.

A valid already-bound family is not treated as portable: it may carry
`x-codex-turn-state` only to exactly its bound account, including a bound backup,
but that response can never advance to a different OpenAI account or Kimi.

The validator is closed-world for account-bound shapes: a newly observed opaque
field blocks fallback until explicitly reviewed and tested. It may reuse current
upstream KCR1/KCR2 and Fernet classifiers but must not transplant the stale local
`native-fallback-policy.mjs` unchanged.

`x-oai-attestation` is account-bound and has a stricter three-state rule because
there is no genuine native cross-account fixture proving portability:

1. An unbound attested request goes only to the original active primary,
   byte-for-byte. A terminal quota response does not open another account or
   Kimi.
2. A request whose family is bound to the canonical active account uses exact
   selected-account passthrough and preserves the attestation byte-for-byte.
3. A request bound to a non-active account returns local HTTP 409 with fixed
   type `local_router_account_binding_mismatch` before reading or sending any
   backup credential. It preserves the binding and never strips the header to
   manufacture portability.

Attested input is never sent to Kimi. The implementation may add a persisted
fixture only after a genuine native observation has been sanitized to presence,
byte length, SHA-256, redacted placeholder, transport, response shape, and
provenance. Raw attestation bytes are never persisted. Until such a fixture
exists, the rule above remains normative; an existing routed ChatGPT-web test
that strips a synthetic attestation is not evidence for native cross-account
replay.

The bounded implementation does not add a WebSocket transport marker or claim
transport-specific provenance across the loopback HTTP request. WebSocket first
turns are permitted only because they present the same canonical native session
proof and pass the same header/body portability checks. Opaque reconstructed
state, including `x-codex-turn-state`, still blocks a cross-account hop. The
deny-only marker and transport-specific affinity/reservation behavior described
in the broader architecture are deferred with durable affinity.

The native terminal-quota classifier is separate from upstream's prose-regex
provider classifier. Version one advances only from a complete bounded HTTP 429
JSON response: a JSON object with an `error` object and an exact captured Codex
error type of `usage_limit` or `usage_limit_reached`. `error.code` is optional;
when present, it must equal one of those exact values. The
`x-codex-rate-limit-reached-type` header, when present, must be one of
`workspace_owner_credits_depleted`, `workspace_member_credits_depleted`,
`workspace_owner_usage_limit_reached`, or
`workspace_member_usage_limit_reached`. Reset metadata is accepted only from a
validated integer `error.resets_at`, `Retry-After`, or the bounded captured
`x-codex-*-primary-reset-at` family. `insufficient_quota`, arbitrary future
types, a JSON message with no allowed type, and prose alone never qualify until
a persisted real fixture is reviewed and added. A 2xx SSE response is a commit
candidate as soon as its first non-empty complete event is primed; even an
error-looking event is never classified as terminal quota and never advances.

## Routing state machine

Add `src/chatgpt-account-fallback.mjs` for policy, caller proof, strict account
ordering, affinity/reservations, quota classification, catalog snapshots, and
request-use leases. It never builds a routed-provider payload. `router.mjs`
continues to own request transformation, upstream fetches, response commitment,
and the handoff into `attemptModelFailover()`.

Every unbound native turn that reaches a confirmed primary terminal-quota
response creates one in-memory `FailoverAttemptContext`:

```text
startedAt = monotonic now
deadlineAt = startedAt + 30 seconds
accountHopsRemaining = validated policy maxHops (0..2), or 0 when account fallback is off/invalid
externalHopsRemaining = 1
attempted = { "native-model:openai:<normalized source slug>" }
```

The native key exists independently of account enrollment. Once selected-
account proof succeeds, add `openai-account:<opaque id>:<normalized slug>` for
the primary and use that exact namespace for each backup; external candidates
use `routed-model:<provider>:<slug>`. This prevents an invalid/missing selected
ID from disabling Kimi while still ensuring no account or external model key is
sent twice.

The same object is passed through every account attempt and the native-to-
external adapter. An attempt reserves its key and decrements the appropriate
counter before network I/O; a failure never refunds it. All paths recheck the
single deadline, client abort, and `nothingRelayed(response)`. This produces at
most primary + two backup OpenAI calls + one external call and does not reset
upstream's 30-second budget when the implementation changes subsystems. Existing
routed-origin failover keeps its current two-hop counter and also accepts the
same optional context type so no nested path can reset a budget.

The context owns a deadline `AbortController`; its signal is composed with the
client-abort signal and passed to every backup/Kimi fetch, bounded clone read,
SSE/body prime, normalization step that accepts a signal, and routed response
read. Deadline expiry aborts the active owned attempt, releases its request
lease, stops the sequence, and permits no later hop. The timer is cleared on
every terminal path. Merely checking elapsed time between calls is not the
budget contract.

For a native request:

1. Derive the root family and inspect affinity before sending. A valid `bound`
   family goes directly to that account. A binding to the selected account uses
   selected-account passthrough; a binding to a backup replaces only the two
   credential headers. It never probes primary first. A `reserved` family is
   never routed by this entry path: it follows the non-owner wait/re-read/local-
   409 rule above. Only the already-running owner context may use its reservation
   inside the bounded failover loop.
2. A bound task stays on that account even when it contains account-owned opaque
   continuation state. If its account fails or exhausts, return that account's
   response and require a new task; never move an established family again.
   Before a bound-account credential read or send, create its request-use lease
   and revalidate the captured session epoch plus exact binding generation and
   account under the pool lock; an ordinary-clear tombstone returns
   `local_router_account_restart_required`, while an epoch/reset mismatch returns
   `local_router_affinity_reset_required`, both before credential access or
   network I/O.
3. An unbound family sends the already-materialized original body with its
   authoritative primary headers. A request without a stable family remains
   account-primary-only, but after an exact terminal primary response it may
   still enter the single external attempt when core portability passes.
4. If the selected first account succeeds, clear only stale fallback quota
   observations and stream it normally.
5. If an unbound primary attempt fails, call `primaryResponse.clone()` and read
   only the clone through the bounded error reader. The original `Response`,
   body stream, status, status text, and headers remain untouched. If cloning or
   complete bounded parsing fails, return the original response.
6. If the clone is not an exact structured terminal-quota result, return the
   original response unchanged. If portability fails, retain the original and
   enter neither cross-account nor native-origin external failover. If only the
   account policy, caller proof, stable root, or affinity secret/state fails,
   skip managed backup accounts but preserve the independently enabled
   generalized external-model path; this keeps Ryan's existing primary-to-Kimi
   behavior when account fallback is off.
7. Reserve the next strict-priority account under the short pool lock. The
   request path never takes `catalog-publication-lock`. It creates a request-use
   lease, snapshots protected credentials, and obtains a lock-free catalog
   generation proof as specified below, then releases every lock before network
   I/O.
8. Immediately before send, reacquire the pool lock for at most the lesser of
   250 ms and the remaining failover budget and re-check abort, visibility,
   deadline/counters, session epoch, reservation generation, canonical caller/
   selected-account proof, account state, login-lease absence, request-use lease
   identity, and the catalog generation marker. Timeout or mismatch stops and
   returns the original response.
9. Send the same immutable native body to the same native backend. Build backup
   headers from a copy of the original safe native headers, replacing exactly
   `authorization` and `chatgpt-account-id`; never carry an attestation header
   because an attested request is primary-only or fails locally under the
   three-state rule above.
10. Inspect every backup failure through `backupResponse.clone()`, leaving its
    original stream untouched. Only a complete bounded HTTP 429 JSON response
    satisfying the exact native classifier consumes the reservation attempt and
    records additive fallback quota state; it may advance only through the
    owner-only lease-release and reservation CAS transition specified above. A
    401 schedules background refresh, attempts to clear only the owner's exact
    reservation, and returns the original primary response. A 403, non-terminal
    429, 5xx, malformed failure body, or any other non-success application
    response stops the account sequence, attempts the same exact-generation
    clear, and returns that untouched backup response. Clear failure leaves the
    reservation conservative for deadline tombstoning and never opens another
    hop. A 2xx SSE response proceeds only to the commitment step below; no SSE
    event is parsed as a retry signal.
11. `primeUncommittedResponse()` owns the acceptance boundary for a successful
    backup or external candidate. For SSE it retains every raw byte from stream
    offset zero through the first complete non-empty dispatch within the
    existing response-byte bound and remaining deadline. That prefix includes
    any UTF-8 BOM, comments, blank dispatches, original CRLF/LF delimiters,
    unknown fields, and multiline `data:` records; parsing is used only to find
    the dispatch boundary, never to reserialize it. The first non-empty dispatch
    commits the candidate regardless of its JSON or `error` text. A bounded SSE
    stream that reaches EOF with only preamble/comment/blank bytes commits that
    exact completed response and never advances. For a non-SSE response it
    retains every byte from offset zero through the first non-empty chunk, or
    accepts a bodyless completion. It then rebuilds a `Response` whose stream
    begins with the byte-exact retained prefix followed by the unread remainder
    and whose status, statusText, and headers exactly match the candidate.
    Oversized, malformed, aborted, or timed-out priming stops without another
    hop, cancels the candidate, and returns the untouched primary; a matching
    OpenAI reservation remains conservative until its deadline.

    For an OpenAI backup, promote the matching reservation to `bound` before
    exposing headers or calling `pipeResponse()`. If promotion or its durable
    write fails, cancel the candidate stream, relay zero candidate headers or
    body bytes, leave the matching generation conservatively reserved, and
    return the untouched original primary response. For an external candidate,
    no account reservation exists; the complete `adoptRoute()` state must be
    committed before its first byte, and adoption failure likewise relays zero
    candidate bytes and returns the untouched primary. Once either candidate
    becomes visible, it is never retried or replaced.
12. A pre-visible transport error preserves the original primary quota response
    and stops in version one. A mid-stream error is surfaced and never replayed.
13. After all eligible OpenAI backups returned exact terminal quota and the
    owner durably CAS-cleared the final reservation, build a native-origin
    adapter for upstream's generalized external failover. It
    uses the immutable active-native descriptor captured from the validated
    global native entry that selected the original primary route **before** any
    account-pool/affinity check. `slug` is the variant-normalized native model,
    `provider` is `openai`, and context/input/reasoning/search capabilities come
    from that exact active entry. It never depends on selected-account policy,
    identity consistency, a private account catalog, or fallback being enabled,
    so invalid/off/unenrolled account state cannot silently remove Ryan's
    existing native-to-Kimi path. `rankFailoverCandidates()` and
    `logFailover()` therefore receive a complete non-null source.
14. The adapter computes, only after portability has passed,
    `normalizedInput = normalizeRoutedAgentInput(request, payload.input,
    signal)`, `agingEnabled = toolResultAgingEnabled()`, `agedInput =
    ageToolResults(normalizedInput)`, and the same flattened namespace map used
    by routed turns. It snapshots native hosted-search intent/history into a
    `searchContract` whose required mode is `hosted` when applicable. It then
    calls `attemptModelFailover()` with the original payload, source descriptor,
    those exact normalized/aged/namespace/search values, and the shared attempt
    context. It allows one external candidate in version one.
15. `prepareRoutedRequest()` remains the only external-candidate builder. On
    success, the existing `adoptRoute()` path must adopt the candidate's
    transformed body, target, headers, aged input, namespace mapping, pending
    interrupts, tool-aging stats, and search mode as one unit before response
    transforms or accounting run. Native bytes are never sent to Kimi or another
    routed provider.
16. Ryan's migrated explicit external chain ends at `kimi-api/kimi-k3`. Kimi is
    the single terminal external attempt for a native-origin sequence and
    retains non-sticky semantics. Extend `attemptModelFailover()` with a
    native-origin discriminated return so a sent candidate is never collapsed
    into `undefined`: it returns exactly `not-attempted`, `candidate`, or
    `terminal-failure`. Both sent variants carry the selected route, complete
    `prepareRoutedRequest()` result, and upstream response; a terminal non-2xx
    also carries the already-read bounded `failedBodyText` in memory.

    A Kimi 2xx follows the priming/adoption boundary above. For a Kimi non-2xx,
    adopt the complete built route state first, then feed its status, safe
    headers, and `failedBodyText` into the existing leak-safe routed error
    translation and return that deterministic Kimi failure. Never try another
    candidate or silently replace a sent Kimi result with the primary quota.
    Only `not-attempted`—no eligible candidate or no external send—returns the
    untouched original primary quota response, including safe headers such as
    `Retry-After`. A transport failure follows step 12.

Every account/model key is attempted once. There is no inline token refresh and
no same-request same-account retry. Auxiliary native calls listed in the
eligibility section never construct this context and therefore cannot enter
account or external failover.

## Health, cooldown, and request-use leases

Keep upstream health semantics unchanged and write automatic-routing evidence
only to the additive `account.fallback` object. A terminal quota result records
`fallback.quota.state = "cooldown"` only when OpenAI provides an authoritative
reset timestamp. Without one, record `unknown` plus a bounded observation time,
not an invented durable window. A later successful usage probe or request sets
it back to `clear`.

Add a per-account request-use lease/refcount separate from login leases. Account
removal, destructive profile operations, and active-profile replacement must be
rejected while any request lease exists. Each lease is an exclusive mode-`0600`
file at
`chatgpt-accounts/<id>/router-request-leases/<random nonce>.json`; every parent
is mode `0700` and non-symlink. Its closed schema is exactly version, opaque
account ID, PID, process-start identity, nonce, affinity-record generation,
`createdAt`, and `deadlineAt`. `deadlineAt` is the owning router request's
`startedAt + REQUEST_EXECUTION_TIMEOUT_MS + 60 seconds`, so it covers the
router's own maximum execution window plus cleanup grace.

Create the lease with `O_CREAT|O_EXCL` while holding the pool lock and after
proving no login lease exists. Release uses relocate-then-verify generation
semantics: atomically rename the exact lease into that account's private
tombstone directory, revalidate its nonce/inode/owner/mode, then unlink only
that file. A lease is stale-recoverable only when its deadline has passed **and**
process identity proves the owning process no longer exists or has a different
start identity. A live identity stays active; an unknown identity fails closed.
No timeout alone authorizes deletion.

Login/refresh and request-use leases are mutually exclusive. A request-use lease
blocks official-CLI token refresh, login finalization, account removal, profile
switching involving that account, account-catalog acquisition, ordinary
affinity clearing for that account, and global affinity-secret reset; an active
login lease makes the account ineligible for a request-use lease and blocks the
same affinity mutations. Backup catalog acquisition is an auth-file writer
because the official CLI may refresh tokens: it must claim the existing
reserved-then-running login lease, verify zero active request leases, skip an
account whose login lease is active, and invoke the existing login-finalize path
if the auth digest changes. Global clear/reset scans all accounts while the pool
lock prevents new leases; a live or unknown lease blocks it, and an expired
lease is recoverable only under the process-identity rule above.

Lock order is fixed and tested:

1. account-pool/policy lock;
2. per-account credential/request-use lock;
3. catalog-publication lock;

Control-plane login, profile, and catalog operations may use all three in that
order. The request path uses only the first two, then performs the generation-
checked lock-free catalog read below; it never acquires the publication lock.
No lock is held during upstream network I/O or while piping a response. State
updates reacquire the minimum lock and revalidate generation/identity before
commit. Request-path acquisition uses the short bound above; the two-minute
default remains control-plane-only.

## Per-account catalog behavior

- The selected primary account's native catalog remains the only native source
  published into the global picker.
- Each backup's authoritative eligibility source is
  the paired, generation-verified
  `chatgpt-accounts/<id>/router-catalog/models_cache.json` and
  `native-models.json`, never its merged catalog.
- Attempt a backup only when the variant-normalized requested slug is present
  in the freshly captured raw account set **and** its enriched native entry has
  input modalities covering those used by the request, a context window at
  least the primary entry's context window, and a supported reasoning ladder
  containing the requested effort. A bundled-only appended slug remains useful
  for normal picker compatibility but is not proof that a backup account can
  serve it and therefore never makes that backup eligible.
- Exact Codex binary-version equality is **not** an eligibility gate. Capture
  records `capturedWith` as diagnostic metadata, but a newer installed client
  may use a seven-days-old snapshot when the capture format, digests, required
  model fields, modalities, context, and reasoning ladder remain compatible.
  Unknown native model fields are retained verbatim. Format or capability
  incompatibility, not an ordinary version string change, fails closed.
- A missing, malformed, unauthenticated, digest-mismatched, schema-incompatible,
  or more-than-seven-days-old backup catalog makes only that account ineligible.
  It never removes or rolls back a valid primary catalog.
- A failed refresh may retain a last-known-good snapshot for up to seven days
  with a surfaced stale warning; it is ineligible after that bound.
- Backup-only slugs remain absent from the picker in version one.

Catalog acquisition rejects an operator-adopted/user-owned native source with
fixed `skipped-user-owned-source`, and rejects discovery-disabled mode with
fixed `skipped-discovery-disabled`, **before** reading account auth, cache, or
config and before spawning a process. It never overwrites either source. Once
eligible, it claims the account's login/auth-writer lease, proves there are no
request-use leases, snapshots global and account artifact bytes/presence plus
their generation markers, and only then changes a probe-visible path.

The probe is a new dedicated acquisition path rather than
`publishCatalog({refreshNative:true})`, because current `captureNative(cache)`
can reuse a valid cache and writes `native-models.json` before rollback begins.
It runs the explicit Codex desktop binary in the managed account's existing
isolated `CODEX_HOME`: macOS is exactly
`/Applications/Codex.app/Contents/Resources/codex`; other platforms use only
their exported Codex-desktop resolver, never the generic resolver whose first
candidate may be ChatGPT's bundle or a router shim. If an account home contains
any `config.toml`, acquisition returns `skipped-user-owned-source` based on file
presence and skips rather than opening, editing, or interpreting it; managed
capture homes therefore have no possible `model_catalog_json` override. The
existing raw cache is transactionally staged aside so `models_cache.json` is
deliberately absent at spawn time. Backup auth is never copied into another
home.

Under that lease, the acquisition runs the explicit binary's `--version`,
`debug models`, and `debug models --bundled` with private bounded stdout/stderr,
the managed `CODEX_HOME`, no routed catalog configuration, and the existing
`runProcessTree` timeout/termination contract. Every invocation goes through
`spawnableCommand`: a direct executable is spawned without a shell, while an
explicit `.cmd`/`.bat` platform shim retains the existing escaped `cmd.exe`
path. CLI text never reaches status, logs, telemetry, or support bundles.

A successful probe captures both the enriched account catalog from stdout and
the newly written raw-cache bytes. The repository currently has no raw-cache
envelope parser or genuine fixture, so the TDD phase must first add a sanitized
fixture from this exact explicit-binary operation before accepting any envelope
assumption. The expected version-one envelope is
`{client_version,etag,fetched_at,models}`; the fixture stores only schema and
redacted/non-identifying model data, never auth or headers. Until that fixture
pins the field types and time units, acquisition returns fixed
`unsupported-cache-schema` and publishes nothing.

Once pinned, the raw validator requires a non-empty bounded `etag`, a
`client_version` equal to the version of the binary just invoked, a
`fetched_at` accepted by the fixture-backed parser within the capture interval
plus a fixed five-minute clock-skew allowance, and a newly created file identity
whose mtime is not the staged old cache. Raw and enriched account catalogs must
each have unique non-empty slugs and exactly the same normalized slug set; both
must reject routed slugs and satisfy the required native metadata schema. The
raw cache is thereafter preserved byte-for-byte rather than reserialized.

The enriched account entry wins for every same-slug field, bundled-only slugs
append, and bundled data may fill an empty account value only for these six
fields: `additional_speed_tiers`, `service_tiers`, `input_modalities`,
`experimental_supported_tools`, `include_apps_usage_instructions`, and
`model_messages`. Never backfill visibility, reasoning levels, or an unknown
future field. A missing `base_instructions` may be derived only from
`model_messages.instructions_template`, substituting declared
`instructions_variables.<name>_default` values and stripping every unresolved
placeholder. The freshly validated raw cache and
`native_source_fingerprint` publish together so the next ordinary catalog build
reuses rather than silently downgrades the new capture. `captured_with` remains
diagnostic; reuse is gated by schema, digests, capabilities, and age rather than
exact current-version equality.

Each successful account capture stages and atomically synchronizes the exact
five artifacts that `chatgpt-profile-switch.mjs` already switches, including
absence as well as contents:

1. raw Codex-owned `models_cache.json`;
2. router `{ captured_with?, native_source_fingerprint?, models }`
   `native-models.json`;
3. router `{ models }` `merged-models.json` built against the currently enabled
   external registry for future explicit switching, never used for backup
   eligibility;
4. `{ version: 1, aliases: {...} }` `native-aliases.json`; and
5. `{ version: 1, models: {...} }` `announced-models.json`.

It additionally publishes `account-catalog-generation.json` **last** in the
same catalog root, with the closed schema
`{version:1,generation,capturedAt,capturedWith,artifacts}`. `generation` is a
fresh 128-bit base64url nonce. `artifacts` has exactly the five filenames above;
each value is exactly `{present:true,sha256}` and hashes that artifact's exact
bytes. A missing or extra key, `present:false` in a successful capture, or a
digest mismatch invalidates the generation.

Publication uses a shared multi-file private transaction added beside
`writePrivateFile`, not either catalog module's local `atomicContents`. On
POSIX, every created directory is mode `0700` and every staged and published
file is mode `0600`, with non-symlink and owner checks before and after rename.
On Windows, the transaction writes every temporary file first, hardens and
validates the entire temporary batch in **one** bounded PowerShell process, and
only then begins renames; an ACL failure aborts before any publication. The
existing timeout kills the helper process tree. All platforms validate every
staged file and snapshot every previous byte sequence and absence before the
probe or first rename. Failure injected after any rename restores all prior
global/account bytes and presence, including all five artifacts, both
generation markers, and the temporarily removed probe cache.

A selected-account refresh publishes the complete five-file global set and its
global marker, then synchronizes the byte-identical set and marker into that
account directory. A backup refresh writes only its private five-file set and
private marker. Profile switching is extended so snapshot and restore
synchronize absence for **all five** artifacts, not only
`models_cache.json`/`native-models.json`, and publish the selected account's
generation marker last. The selected identity, process absence, and login-lease
generation are revalidated immediately before marker publication.

The existing private profile-switch transaction advances from version 2 to
version 3. Version 3 retains the current auth and selection fields and adds
content-or-absent snapshots for the global/account generation markers and all
five artifacts. Its reader remains backward-compatible with version 2: a v2
journal restores its existing five-file global snapshot and removes any
unjournaled generation marker before completing recovery. Unknown versions fail
closed.

Standalone Retry Catalog and final-quit refreshes use separate per-account
capture journals at the fixed path
`STATE_DIR/chatgpt-catalog/capture-transactions/<validated-account-id>/`.
Each has a version-1 `manifest.json` with exact operation `catalog-capture`, the
opaque account ID, `touchGlobal`, selected/active opaque IDs at start, login-
lease generation, owner PID/start identity, phase, optional child PID/start
identity, and a closed object of logical snapshot slots. Exact previous bytes
live as mode-`0600` files beside the manifest; entries hold only
present/filename/SHA-256, never arbitrary destination paths. Recovery re-derives
destinations from the validated ID and fixed path table. Slots cover the probe
cache, account five-file set and marker, and, when `touchGlobal` is true, the
global five-file set and marker. The manifest phases are exactly `prepared`,
`child-attached`, and `publishing`.

The protected `prepared` manifest and every snapshot are durable before the
probe cache moves. To close the spawn/identity gap, a small committed catalog-
probe launcher starts as the tracked `runProcessTree` child and blocks on a
one-byte parent pipe without touching `CODEX_HOME` or spawning Codex. The parent
records and fsyncs that launcher's PID/start identity as `child-attached`, moves
the old probe cache, verifies the live path is absent with parent/inode restats,
and only then sends the single `GO` byte.

The parent keeps the control pipe open through command completion. EOF before
`GO` makes the launcher exit without touching the home; EOF or cancellation
after `GO` makes the launcher terminate and wait for every descendant before it
exits. After `GO`, the exact Codex command remains in the launcher's recorded
POSIX process group or non-breakaway Windows Job Object, and the launcher owns
the same timeout/abort tree cleanup between all three CLI commands. Recovery can
therefore identify a surviving group/job from the durable launcher identity
even if the router died. Thus a crash cannot create an unrecorded or unwatched
auth-writing Codex process; no credential or auth value crosses the control
pipe, environment, or argv.

Service startup recovers the profile-switch journal and then the bounded,
account-ID-sorted capture-journal directories before listening or reading a
catalog; every catalog/profile control command performs the same checks before
work. Recovery acquires pool then publication locks, validates each manifest and
snapshot, and proves the recorded owner and attached child tree are dead or have
different start identities. A live or unknown identity remains pending and
fails closed. Otherwise it restores every prior byte and absence, finalizes or
reconciles the login lease if the CLI changed auth, and only then removes the
journal. The normal success path removes a journal only after the last marker,
identity recheck, and auth finalization. A crash after full publication but
before cleanup therefore rolls back rather than guessing completion.

The primary capture completes before backups start. Backup remote probes may run
with concurrency two because each owns a different per-account journal and
private home; publication still takes the shared lock and serializes. A profile
switch or same-account capture refuses while the relevant capture journal is
live, and `touchGlobal` is unique under the pool lock. Thus final-quit backup
capture has a recovery owner independent of a switch, a crash cannot pair old
catalog bytes with a newer marker, and plain-upstream checkout is allowed only
after current code has recovered and removed every v3 switch and v1 capture
journal.

The probe cache at `chatgpt-accounts/<id>/models_cache.json` is a separate
transaction participant from the canonical saved raw artifact at
`chatgpt-accounts/<id>/router-catalog/models_cache.json`. On success, the newly
created probe bytes become both files (and, for the selected account, the global
raw artifact); on failure, the probe path returns to its exact prior bytes or
absence. The operation never mistakes the staged old cache for fresh output.

Request-time eligibility is lock free:

1. read and validate generation marker A as a protected regular file;
2. read `models_cache.json` and `native-models.json` through `O_NOFOLLOW`, each
   with a one-megabyte bound and pre/post-read `dev`, `ino`, `uid`, mode, size,
   and `mtimeMs` restat;
3. hash both exact byte sequences and require marker A's matching artifact
   digests;
4. require the normalized slug in the raw account model set, then parse and
   validate its enriched native capabilities;
5. read marker B and require its exact bytes/generation equal marker A; and
6. immediately before fetch, repeat marker B and require the same generation.

A writer that has renamed a new catalog but not its last marker causes a digest
mismatch; a writer that completes between reads changes the generation. Both
skip the account without waiting. The request path never calls
`withCatalogPublicationLock()` and never waits behind a two-minute control-plane
publication.

## Final-Codex-quit lifecycle

Port `CodexCatalogRefreshCoordinator.swift` as a clean current-upstream file and
wire it into the existing macOS lifecycle observer:

- seed the initial `com.openai.codex` desktop-instance count without firing and
  arm only after observing a positive count;
- enqueue exactly once on the armed desktop-count transition from positive to
  zero; terminal `codex` processes, ChatGPT desktop events, initial absence,
  partial multi-instance exits, and duplicate zero observations never trigger;
- let polling recover a missed notification only while that positive-count arm
  is live; a poll that merely discovers initial zero cannot synthesize an exit;
- assign a deliberate managed restart one suppression generation only after the
  observer has armed on a positive Codex desktop count, and bind it in memory to
  the exact pre-restart set of desktop PID/start identities targeted by that
  managed action. Consume it only when that exact set's managed removal produces
  the immediate transition to zero. Clear it on a partial or unrelated exit,
  an untracked/new instance, no matching instance, any pre-zero restart failure,
  or its bounded deadline, so a surviving instance's later manual quit can
  never be suppressed;
- coalesce overlap to one active refresh plus at most one pending rerun;
- use a Codex-only process signal, distinct from the tray's aggregate
  Codex/ChatGPT/CLI visibility boolean;
- record the refresh intent on that Codex transition, but before any official
  CLI process that may rewrite OAuth state, require both Codex **and** ChatGPT
  desktop processes to be absent. If ChatGPT remains open, keep exactly one
  `pending-shared-auth-consumer` intent and run it when the aggregate shared-auth
  consumer count reaches zero; do not require another Codex launch/quit cycle;
- load and validate this persisted pending intent when the tray starts. If both
  desktop consumers are already absent, enqueue it once after observer startup;
  otherwise watch the aggregate count and consume it on the first transition to
  zero. This restart recovery does not arm or fabricate a new Codex quit and
  coalesces with an in-memory pending run by trigger generation;
- after recovering any capture journal and resolving its recorded process
  identity, reconcile a persisted non-null `current` before consuming pending
  work. A live or unknown owned tree keeps `current` and blocks a duplicate. If
  that tree is proven dead and its journal has rolled back, write fixed
  `interrupted-recovered`; with no newer queued generation, requeue the same
  trigger generation once, while an already queued newer generation remains the
  sole rerun. Never turn a stale `current` into a second concurrent probe;
- reconcile any already-pending explicit profile switch first, then refresh the
  resulting active primary;
- refresh/publish the active primary first;
- refresh enabled backup eligibility snapshots afterward with concurrency two
  and the existing bounded account limit;
- treat backup failures as per-account warnings while retaining last-known-good
  snapshots;
- never disable live routing, force-quit Codex/ChatGPT, or terminate either app.

The control-plane lock order remains pool then publication. A refresh rechecks
the Codex/ChatGPT absence and selected/active account identity after acquiring
the pool lock and again immediately before spawning the CLI. A relaunch at
either boundary defers the intent; it never starts an auth-writing probe beside
a live shared-auth desktop consumer. While each owned catalog probe is running,
the lifecycle observer continuously watches both desktop bundle IDs. A Codex or
ChatGPT launch aborts and terminates only that owned `runProcessTree` CLI group,
waits for termination, restores the capture transaction's probe cache and all
artifact bytes/presence, persists the same trigger as one
`pending-shared-auth-consumer` deferral, and stops the batch. It never signals or
relaunches either desktop app, and publication cannot resume until a later
aggregate transition to zero consumes the persisted intent.

The lifecycle operation returns backward-compatible JSON with primary outcome,
per-backup sanitized outcome, counts, and fixed warning codes. Raw CLI output,
stderr, auth data, account identifiers, paths containing capabilities, and raw
exceptions never reach the tray.

Persist lifecycle observability in private
`STATE_DIR/native-catalog-refresh.json`. Its schema is closed and exactly:

```json
{
  "version": 1,
  "pending": false,
  "trigger": null,
  "current": null,
  "last": {
    "generation": null,
    "status": "never",
    "code": "none",
    "startedAt": null,
    "completedAt": null,
    "capturedWith": null,
    "nativeModelCount": 0,
    "usedLastKnownGood": false
  }
}
```

`last.status` is exactly `never`, `deferred`, `refreshed`, `failed`, or
`skipped`; `code` is exactly one of `none`, `codex-final-exit`,
`manual-retry`, `pending-shared-auth-consumer`, `managed-restart-suppressed`,
`no-enabled-backups`, `skipped-user-owned-source`,
`skipped-discovery-disabled`, `unsupported-platform`,
`unsupported-cache-schema`, `app-relaunched`, `interrupted-recovered`,
`probe-owner-unknown`, `profile-reconcile-failed`,
`identity-changed`, `login-busy`, `request-in-use`, `probe-failed`,
`publication-failed`, `partial-backup-failure`, or `ok`. Generation is a fresh
opaque nonce, and timestamps are canonical ISO-8601 or the declared null. `current` is null
when idle or exactly `{generation,startedAt}` while one execution owns the
intent. Before the first quit, `pending` is false, `trigger` and `current` are
null, `last.generation` is null, `last.status` is `never`, its code is `none`,
both timestamps and `capturedWith` are null, count is zero, and the last-known-
good flag is false.

After a real trigger, `trigger` is exactly
`{generation,observedAt,codexBecameAbsentAt}`. A deferred idle intent has
`pending:true`, `current:null`, and `last` records that trigger generation with
`status:"deferred"`. Starting it sets `current` to that generation and clears
`pending`. If another real trigger arrives while it runs, `pending:true` and
`trigger` hold only that next generation while `current` retains the running
one; this represents the coalesced single rerun. Completion clears `current`
and writes `last.generation` from the completed execution with non-null
start/completion times, then either starts the queued generation or leaves
`pending:false`. A pre-start skip has null `startedAt` and non-null
`completedAt`. Invalid combinations fail closed and are replaced only by an
explicit Retry Catalog action, never by inventing a quit. The file never
contains account IDs, paths, etags, model names or bodies, stdout/stderr, auth
metadata, or exception text. Every trigger/defer/completion rewrites it through
the shared private writer, so a no-op is still observable. The support bundle
includes only `active = Boolean(current)`, current age, `pending`, trigger age,
`last.status`, `last.code`, completion age, `nativeModelCount`, and
`usedLastKnownGood`, never an opaque generation or raw timestamp.

Automatic quit refresh is macOS-only in version one. Windows and Linux retain
explicit account switching and the deterministic Retry Catalog control; doctor
must state that backup catalogs refresh manually on those platforms. Update
`SECURITY.md` so its subprocess and credential-read claims cover isolated backup
catalog probes accurately.

## Control Center and tray UX

Upstream Control Center remains the account-management surface. The native
macOS tray keeps its compact role and opens Control Center; do not resurrect the
old Kimi-only Swift settings UI.

Add an **OpenAI account fallback** section with:

- an explicit default-off toggle and a short cross-account data-boundary
  explanation stating that the feature primarily rescues a new task and does
  not move opaque mid-task state;
- immutable active-primary row;
- ordered backup rows with local alias, enabled/paused state, usage/reset,
  auth health, catalog freshness, and model-eligibility summary;
- Add/Sign In, Reconnect, Enable/Disable, Move Up/Down, Clear Affinity, Retry
  Catalog, and deliberate Remove actions;
- a separate destructive **Reset affinity secret** action for quarantine or
  capacity recovery. It displays that every former backup-bound task must be
  abandoned, requires a second confirmation containing the literal phrase
  `START NEW TASKS`, invokes the journaled `clear-affinity --reset-secret`
  control operation, and offers no optimistic success state;
- fixed states for cooldown, reauthentication required, catalog stale,
  model-ineligible, login in progress, request in use, affinity quarantine, and
  restart-required tombstone, plus affinity-capacity exhaustion with current
  entry count and explicit copy that the only capacity reset means starting new
  tasks;
- on Windows, a fixed switch-only notice and disabled automatic-fallback toggle
  with no hidden attempt to probe account credentials on the request path;
- optimistic UI only when the existing rollback behavior can restore the prior
  snapshot after IPC failure.

Disabling never deletes credentials. Removal requires a separate explicit
action, invalidates affinity, and is blocked while login or request-use leases
are active. Status responses are sanitized and never contain bearer tokens,
refresh tokens, raw auth JSON, raw account IDs, prompts, or thread IDs.

## CLI and control contracts

Add or extend deterministic commands for:

```text
control chatgpt-account-fallback status
control chatgpt-account-fallback on|off
control chatgpt-account-fallback clear-affinity [ACCOUNT]
control chatgpt-account-fallback clear-affinity --reset-secret
control chatgpt-account-fallback retry-catalog [ACCOUNT]
control chatgpt-account priority ACCOUNT NUMBER
control chatgpt-account pause|resume ACCOUNT
```

Existing add/login/reconnect/remove/switch commands remain authoritative. All
mutations assert checkout/state ownership and use existing locks. JSON output is
versioned and contains only sanitized profile IDs/local labels and fixed error
codes.

Doctor gains one row that distinguishes disabled, ready, no-backup, stale-
catalog, reauth-required, affinity-capacity-exhausted, and invalid-state
conditions. Invalid fallback state is a fail-closed diagnostic, not a router
crash.

The support bundle adds only sanitized account-fallback diagnostics: policy
enabled/strategy/max hops; platform support; selected-account consistency;
account counts by eligibility/catalog/quota state; affinity entry and alias
counts plus tombstone count, capacity-exhausted boolean, and quarantine boolean;
active/stale request-lease counts; catalog generation age and digest-
match booleans; and the affinity-secret `present/protected/valid` booleans.
It also adds only the bounded quit-refresh summary named above, not the raw
`native-catalog-refresh.json` document.
It includes no secret bytes or digests, raw provider account identities, raw
thread/session IDs, raw managed account IDs, auth paths, token metadata, prompts,
request/response bodies, or CLI stderr. The existing blanket secret discovery
also adds the affinity-secret path, the entire affinity-reset transaction
directory, and all account auth paths so historical arbitrary text remains
omitted if safe redaction cannot be proven. Tests seed unique sentinel values in
every forbidden field and require that none appears anywhere in the generated
archive or its filenames.

## Installed-state migration

Add an idempotent migration that runs inside install/update repair and service
startup before the router can observe upstream's default-enabled automatic
ranking. It reads metadata only from the retained legacy
`quota-fallback.json` when the new generalized `failover.json` has no explicit
operator choice:

- legacy enabled with target `kimi-api/kimi-k3` -> generalized failover enabled
  with chain exactly `kimi-api/kimi-k3`;
- legacy disabled -> generalized failover disabled;
- malformed, unknown target, or conflicting explicit new state -> do nothing
  and report a fixed warning;
- never delete or rewrite the legacy file.

This migration does not enable OpenAI-account fallback. On Ryan's installation,
the post-install control step may enable it because this task contains explicit
approval. No backup credentials are copied or enrolled by migration.

## Failure modes and recovery

- **Invalid fallback policy with valid empty sessions:** disable account
  failover, preserve core-portable primary/external behavior, and show doctor
  failure.
- **Unreadable/invalid pool sessions:** set affinity quarantine; continuation-
  shaped work is blocked locally, while stateless work skips managed accounts
  but retains core-portable primary-to-Kimi behavior.
- **Invalid affinity secret with persisted sessions:** enter quarantine;
  stateless new work skips managed accounts but retains core-portable primary-
  to-Kimi behavior, while continuation-shaped work returns the fixed local
  reset-required error with zero upstream sends.
- **Credential path/owner/mode/symlink violation:** mark only that account
  unusable and perform no upstream request with it.
- **Token expired:** one official-CLI refresh under the existing login lease;
  otherwise reauthentication required.
- **Catalog unavailable/incompatible:** skip only that backup and retain its
  last-known-good snapshot.
- **State persistence failure after a failed attempt:** stop; do not walk more
  accounts without durable cooldown/lease state.
- **Affinity/adoption persistence failure before candidate commitment:** expose
  zero candidate bytes, cancel it, return the untouched primary response, and
  retain the matching reservation conservatively. Never replay the completed
  candidate merely to recover it.
- **Diagnostic persistence failure after candidate commitment:** the response is
  already visible, so finish that same stream, emit only a sanitized in-memory
  diagnostic, and never retry or replace it.
- **Client abort:** cancel current work, release the request lease, and make no
  further attempt.
- **Headers/body already visible:** never retry.
- **Unknown response/application failure:** return that response and stop.
- **Router restart:** durable bound/tombstone affinity, cooldowns, and account
  profiles recover; every live reservation becomes an owner-lost tombstone
  before listening, and stale request leases are validated against process
  identity before cleanup.
- **Fast Codex/ChatGPT relaunch during catalog refresh:** cancel only the owned
  probe tree, restore the prior complete catalog/probe cache, persist the same
  intent as deferred, and publish nothing until both apps are absent again.

## Verification contract

Implementation is test-driven. Required RED-to-GREEN coverage includes:

### State and security

- default-off, invalid-off, bounded settings, upstream-compatible schema-v1
  additive fields, private modes, no symlinks, current UID ownership,
  one-megabyte auth-file bound, pre/post-read restat, closed-world schemas,
  permanent safety-record retention, hard capacity refusal, and lock order;
- affinity-secret exact path/format/atomic creation, missing-secret session
  quarantine, exact session-epoch validation/recheck across concurrent reset,
  explicit reset, and zero secret bytes/digests in every outward surface;
- affinity-reset transaction before-images, prepared marker, commit-point
  unlink, orphan cleanup, unconditional rollback recovery, live/unknown lease
  exclusion, and injected crash/failure at every file/rename/fsync boundary;
- disable/pause/revoke/remove/expiry/ordinary-clear convert roots and every
  resolving child alias to permanent tombstones; restart, seven-day aging, and
  capacity pressure never expire or evict them into absence; matching
  tombstones return restart-required with zero primary, backup, or Kimi sends;
- at 2,048 entries, a new root cannot reserve and makes zero backup sends; it
  returns its byte-identical primary response when external portability fails
  or makes at most the independently gated single Kimi attempt when portability
  passes. A required new child alias receives the fixed local capacity 409
  before credential reads or sends; only explicit reset releases capacity;
- with valid non-quarantined session state, an unrelated unmatched legitimate
  primary continuation proceeds on primary even while other bindings or
  tombstones exist; only quarantine or uncertain session validity makes an
  unresolved continuation return reset-required with zero primary, backup, or
  Kimi sends, while quarantined stateless new work skips backup accounts but
  retains the core-portable primary-to-Kimi path;
- backup header resolution and background account refresh without any credential value
  in serialized state, logs, errors, status, telemetry, or support bundles;
- arbitrary bearer/API-key callers cannot access managed backup credentials;
- canonical-auth versus saved-profile token drift, selected/active/identity
  mismatch, router-capability consent, and exact same-selected-account
  passthrough without a duplicate request or saved-profile read;
- independent immutable route-auth and credential-source classification across
  path capability plus canonical bearer, bearer capability, canonical ChatGPT
  token, canonical API-key mode, substituted native headers, WebSocket
  loopback, and stale/arbitrary bearer cases;
- request-use leases block remove/switch races and recover only when process
  identity proves staleness after the exact request deadline; timeout alone,
  live identity, and unknown identity remain blocked; ordinary affinity clear
  and destructive secret reset obey the same exclusion across affected
  accounts.

### Routing

- when fallback is off and affinity enforcement is proven empty, primary
  success makes no pool read beyond the cheap in-memory gate; enabled or
  enforcement-required requests perform exactly one bounded pre-send affinity
  snapshot;
- structured terminal quota: primary -> backup one -> backup two -> Kimi;
- deterministic ascending priority/opaque-ID tie break and shared account plus
  external max-attempt/30-second budget bounds, including abort of an in-flight
  fetch/body read at the deadline with no later hop;
- model-ineligible, paused, revoked, cooldown, stale-catalog, and reauth-required
  accounts are skipped;
- successful backup commits durable root-family affinity; parent/subagent and
  restart reuse it;
- only roots reserve; subagents inherit an existing positive child/root mapping
  or stay on the active OpenAI primary for account routing; the subagent marker
  alone still permits Kimi only when every independent core-portability check
  passes; negative rollout lookups are never cached;
- only the originating in-memory context with the exact private tuple can use or
  mutate a reservation; concurrent HTTP/WebSocket requests wait/re-read and
  receive the fixed in-progress 409 if it remains, with zero upstream sends;
- reservation wall/monotonic deadlines, startup owner-loss tombstoning,
  backup-one to backup-two fresh-generation CAS, final durable clear before
  Kimi, and concurrent root/child/grandchild arrival cannot create a second
  binding or use an uncommitted account;
- a missing stable ID skips managed accounts while a core-portable HTTP request
  may still reach Kimi; `previous_response_id`, files, compaction, opaque
  reasoning, encrypted collaboration, search/image/direct endpoints, and
  unknown opaque fields block both paths;
- arbitrary JSON messages, unsupported quota codes/types, ordinary 429, backup
  401 with background refresh pending, 403 entitlement, 5xx, malformed/free-text
  errors, transport failures, client abort, and mid-stream failures never walk
  the pool;
- only complete bounded HTTP 429 JSON can advance; a 2xx SSE dispatch,
  including an error-looking first dispatch, commits and never advances, while
  every raw prefix byte through it survives byte-for-byte;
- promotion/adoption failure after a candidate was primed relays zero candidate
  bytes, returns the byte-identical original primary, and leaves a matching
  reservation conservative;
- `x-codex-turn-state` blocks a first cross-account hop while a proven bound
  same-account continuation is allowed and cannot advance again;
- all three attestation states: unbound primary-only, bound canonical-active
  byte-exact passthrough, and bound non-active deterministic local failure
  before any backup-credential read; all prohibit Kimi;
- native -> Kimi uses the native-origin source descriptor, pristine normalized
  input, provider-transformed routed body, adopted namespace/search/tool-aging
  state, and a log-safe non-null source; router-originated native relay, vision,
  image, search, Cursor, Claude, and Gemini calls stay primary-only;
- native -> Kimi remains available from the active/global source when account
  fallback is off, pool state is invalid, or the canonical account is
  unenrolled; a sent Kimi non-2xx returns its bounded translated error after
  route adoption and is never collapsed back to the primary quota;
- WebSocket first turns pass the same canonical-session and portability checks
  as HTTP, while reinjected `x-codex-turn-state`, opaque previous-response
  reconstruction, abort, and caller mismatches block account fallback;
- no attempt occurs after headers or the first body byte;
- clone-based inspection leaves every failure path's original response and safe
  headers byte-identical;
- feature off reproduces upstream behavior exactly.

### Catalog and lifecycle

- adopted-source/discovery-disabled checks occur before auth/cache/config reads
  or spawn; a stale same-version cache still forces a genuine remote capture,
  and a newly captured Astra entry survives the next ordinary publication;
- the exact Codex desktop binary runs in the managed account home with no
  routed config and an absent probe cache; enriched stdout and the newly
  created raw cache have unique identical slug sets, validated freshness and
  version provenance, bounded private output, and no credential disclosure;
- account values win, bundled-only slugs append, only the six named metadata
  fields backfill when empty, base instructions derive only from declared
  template defaults, and unknown future fields are retained without being
  invented;
- per-account last-known-good preservation, login-lease/finalize behavior, and
  publication locking;
- exact five-artifact global/account byte synchronization plus last-published
  generation metadata, absence synchronization for every artifact, digest
  mismatch rejection, and injected failure after each individual rename
  restoring prior bytes and presence, including the probe cache;
- profile-switch-v3/v2 recovery plus per-account capture-journal validation,
  journal publication before probe mutation, gated-child attach before Codex
  can touch its home, two concurrent private probes with serialized
  publication, startup/control recovery before catalog use, and live/unknown
  probe identity failing closed;
- GO is impossible until the old cache is moved and absence reverified; parent
  death before GO, immediately after GO, and during each of `--version`, remote
  `debug models`, and bundled `debug models` terminates and waits for the owned
  descendant tree before transactional recovery;
- lock-free generation A/file/generation B reads, profile/generation drift
  between A and B, and the pre-send generation recheck while a long publication
  lock is held;
- a changed Codex version with compatible capture metadata remains eligible,
  while capture-format or required-field drift fails closed;
- POSIX directory/file modes are `0700`/`0600`; Windows stages all files,
  performs exactly one ACL batch before publication, and an ACL failure causes
  zero renames. Direct executables use no shell and `.cmd`/`.bat` preserve the
  bounded `spawnableCommand` path;
- primary-only global publication and backup-only private eligibility;
- Swift suites cover initial 0, one and two Codex desktop instances, partial
  exits, duplicate zero, ChatGPT and terminal-CLI events ignored, armed polling
  recovery, exact PID/start-set-bound managed-restart suppression plus clearing
  on partial/unrelated/no-instance/pre-zero failure/timeout, concurrent
  coalescing, fast relaunch,
  owned-probe tree cancellation/transaction rollback, ChatGPT-
  open deferral until all shared-auth consumers close, and persisted-pending
  consumption plus stale-current/live-owner reconciliation after tray restart
  without synthesizing another quit or starting a duplicate probe;
- private quit-refresh status persists trigger/defer/success/failure/no-op with
  its valid `trigger:null` initial state and other closed invariants, and
  contains no account ID, path, etag, model name/body, stdout/stderr, auth
  metadata, or raw exception sentinel;
- every account catalog `lastResult` and lifecycle `last.code` accepts only its
  explicitly enumerated value set; unknown or cross-enum values fail closed;
- primary-first and concurrency-two backup refresh, identity rechecks, and
  per-backup warning behavior;
- legacy Kimi setting migration is idempotent and conflict-safe.

### UI, install, and regression

- Control Center rendering and IPC for toggle/order/pause/reconnect/catalog/
  affinity/removal, including the non-optimistic destructive secret-reset
  confirmation, with rollback on failure and sanitized output;
- native tray rebuild/fingerprint and Swift lifecycle suites;
- doctor, support bundle, installer/update/rollback, service rendering, Windows/
  Linux non-regression, catalog, routed failover, subagent/collaboration,
  compaction KCR1/KCR2, namespace, usage, and complete Node suites;
- support-bundle count/boolean coverage with zero account IDs, affinity keys,
  secret material, auth metadata, request bodies, or raw CLI failures, including
  active/current-age visibility while `pending` is false;
- no live inference smoke test without separate approval.
- short request-lock timeout returns the original response while a long account
  switch/catalog operation holds the control-plane locks.

Fresh completion evidence must include repository checks, complete Node tests,
Control Center tests/build, macOS Swift tests/release build, `git diff --check`,
secret-shaped literal scan, exact Fable final review, push/fetch/SHA parity,
stable-checkout install identity, doctor, service/tray health, and account/catalog
status. UI behavior requires rendered Control Center verification. The first real
fallback remains an attended acceptance using an already-exhausted or controlled
test account; it must not spend quota merely to prove routing.

## Rollout and rollback

1. Build and review entirely in the isolated upstream-based worktree.
2. Push the reviewed branch to `Ryanm218/codex-router` and verify remote parity.
3. Preserve the existing stable checkout's `.agents/` and old branch ref.
4. Move the stable checkout to the new pushed branch only after tests/review.
5. Run the normal stable-checkout installer without an inference smoke.
6. Verify install manifest, source root, service, tray, doctor, model catalog,
   Kimi chain, account fallback status, and current account preservation.
7. Do not quit Codex. The next ordinary full quit/open supplies lifecycle
   acceptance; account enrollment/fallback acceptance is separately attended.

The immediate non-destructive runtime rollback is turning account fallback off;
that converts existing bindings to enforced tombstones under the current
router. A code rollback to pushed commit `9b05fff` is allowed only after capture
and switch journals are recovered, affinity is empty/reset by explicit operator
action, and the operator agrees not to resume any formerly bound task. Then
switch the stable checkout, run its installer, and verify doctor/catalog/tray.
Retain account homes, logs, snapshots, and legacy state; do not delete
credentials.

## Review gates

- Independent Fable design review must return exactly one standalone
  `FABLE_DESIGN: PASS` before the first production implementation edit.
- The approved architecture and Fable reference must be recorded here before
  implementation.
- A task-by-task TDD implementation plan is required after design approval.
- Fresh tests and exactly one standalone `FABLE_REVIEW: PASS` are required
  before commit/push/install.
- Any material scope or failure-contract change requires a new design review.

## Review outcome

Fable design cycle 1 blocked on five omissions. Those corrections and its
advisories were incorporated. Cycle 2 accepted the architecture but found five
additional source-specific seams. Ryan explicitly authorized one additional
corrected review cycle in the active task. This revision closes them by
specifying:

- a concrete native source descriptor and complete normalization/aging/
  namespace/search adapter into `attemptModelFailover()`, one shared deadline
  and attempt ledger, atomic `adoptRoute()` state, and primary-only auxiliary
  native calls;
- a freshly read canonical ChatGPT-token plus selected/active/identity caller
  proof, explicit rejection of API-key/stale-profile callers, and byte-exact
  selected-account passthrough;
- a closed additive `account.fallback` object and exact POSIX-only affinity-
  secret path, shape, ownership, creation, invalidation, recovery, and outward-
  redaction lifecycle;
- five-file switch-compatible account catalogs plus a last-published generation
  marker, transaction-v3 crash recovery, a real remote-capture prerequisite,
  and a digest/re-stat/generation lock-free request algorithm; and
- separate route/credential provenance and a deny-only WebSocket transport
  design; the marker and transport-specific affinity behavior remain deferred
  from the bounded first-turn implementation.

It also fixes the cycle-2 advisories: request leases have an exact deadline and
stale rule; compatible client-version drift is allowed; attestation has an
explicit three-state fail-closed rule without claiming a nonexistent native
fixture; only complete HTTP 429 JSON can advance and candidate-promotion failure
relays zero candidate bytes; automatic account fallback is POSIX-only in version
one; priority is ascending; variants map to base slugs; quit refresh waits for
every shared-auth desktop consumer and persists sanitized status;
support-bundle additions are closed; and catalog publication uses one private
cross-platform batch transaction with standalone capture crash recovery. The
final correction also retains the entire raw SSE prefix, separates external
portability from root-only account affinity, represents the never-triggered
lifecycle state, consumes persisted deferral after restart, and cancels only an
owned probe tree if either desktop app relaunches. The final preflight correction
makes tombstones and their resolving aliases permanent until explicit reset,
refuses new affinity writes at the hard cap instead of evicting ownership
evidence, and treats an unmatched continuation as primary-owned whenever the
loaded secret and session state are valid; global unresolved-continuation 409s
are limited to quarantine or uncertain state. A final consistency pass further
restricts every reservation to its originating in-memory capability, defines
deadline/restart and backup-to-backup CAS transitions, journals destructive
secret reset across the pool and secret files with lease exclusion and rollback,
clarifies that a rootless subagent is account-primary-only but may independently
qualify for Kimi, and exposes reset as an explicit destructive Control Center
action.

The detailed results are retained in
`docs/reviews/2026-09-05-openai-account-quota-fallback-fable-design-cycle-1.md`
and
`docs/reviews/2026-09-05-openai-account-quota-fallback-fable-design-cycle-2.md`.
Cycle 3 returned the required approval before implementation. Cycle 4 then
reviewed the bounded implementation and returned exactly one standalone
`FABLE_DESIGN: PASS`, subject to the two pre-commit corrections recorded in
`docs/reviews/2026-09-05-openai-account-quota-fallback-fable-design-cycle-4.md`.
