# Fable design review — cycle 3

**Date:** 2026-09-05
**Command status:** exit 0
**Reviewed spec SHA-256:** `cb2a5a1c85947f9154640434c99d2129930a9f48c15cec7fad8ebfffdb493b61`
**Log evidence:** `/Users/ryan/.claude/logs/fable-design-review.log` lines 2264–2331
**Sentinel evidence:** exactly one standalone PASS and zero BLOCK sentinels in
the cycle-3 log segment
**Verdict:** approved, with three mandatory implementation-plan corrections and
non-blocking advisories

## Reviewer output (verbatim)

````text
I have everything I need. No further reads are required; the remaining work is the assessment itself.

**Verdict: PASS.** Every cycle-1 and cycle-2 correction is present in the design and matches the upstream seams it claims to close. No safety-critical behavior is unspecified. Three spec-literal defects should be corrected in the TDD plan, but none exposes credentials, replays committed work, or crosses account state.

## Verified against source

- **Schema v1 rollback claim holds.** The pool reader in `src/chatgpt-account-pool.mjs` requires `sessions` to be a plain object and drops unknown policy, account, and session keys on every write. Plain upstream therefore reads the new pool and silently returns to default-off, exactly as the design states.
- **`nativeSessionTokenMatches` accepts API-key mode**, so the separate ChatGPT-only matcher is necessary, not optional.
- **The rollout negative cache is real.** `rolloutMetadata` in `src/codex-session-names.mjs` caches a miss for the process lifetime, so the routing-specific resolver is required.
- **`captureNative` reuses a valid cache and writes `native-models.json` before rollback**, confirming the dedicated absent-cache acquisition path.
- **The publication lock waits two minutes by default**, confirming the lock-free generation read.
- **WebSocket frames re-enter the HTTP handler** with the handshake bearer preserved and `previous_response_id` deleted, so the deny-only marker is the only way the HTTP path can see the transport.
- **Profile-switch v2 restores absence for only two of five artifacts**, confirming the v3 change.
- **The old coordinator seeds without firing and arms on a positive count**, so the port is faithful.
- **`failover.json` defaults to enabled with automatic ranking when absent**, so the pre-router Kimi migration is load-bearing. The slug `kimi-api/kimi-k3` matches the config.

## Corrections the plan must apply

1. **Stale request-lease rule blocks accounts for a day after any restart.** The design requires the deadline to pass **and** identity to prove the owner dead, with a 24-hour default deadline. A routine `service restart` mid-turn then blocks refresh, switch, removal, and catalog capture for that account for a day. A request-use lease guards only an in-process fetch, so a proven-dead owner is sufficient. Mirror the login-lease rule: identity-proven-dead recovers immediately, deadline only changes the diagnosis for unknown identity.
2. **The Cursor, Claude, and Gemini exclusion has no mechanism.** Those leaves re-enter `/responses` over loopback with no authorization header, so `nativeHeaders` substitutes the canonical session and they classify as `substituted-chatgpt`. They would qualify for account fallback despite the exclusion list. Either stamp the same deny-only marker on every router-originated loopback hop or drop them from the exclusion list. Both are safe because those bodies are stateless.
3. **Selected-account proof can never hold on a migrated install.** `selectedAccountId` is written only by explicit select and by removal. The auto-enrolment path sets `profile.active` but not `policy.selectedAccountId`. Specify that `fallback on` refuses, or repairs under lock with the identity check, when the selection is unset. Otherwise the feature silently never qualifies.

## Important advisories

- **Attestation may make the feature inert.** If Codex attaches `x-oai-attestation` on ordinary first turns, rule one sends every Codex turn primary-only and the feature rescues nothing. The fail-closed stance is correct. Add an acceptance step that sanitizes one real Codex request to confirm presence before Ryan enables the toggle.
- **Lock two is named but not defined.** The login-lease creator in the background refresh runs outside the pool lock, so the login-versus-request mutual exclusion has a check-then-create window. Name the per-account lock artifact and require every login-lease creator to check request leases inside it. Not safety-critical because auth replacement is atomic.
- **Out-of-process enable is not observed.** The enforcement bit refreshes only from in-process writes, so `fallback on` from Control Center takes effect only after restart. Fail-safe, but state the activation mechanism, such as a pool-file identity stat per request or a required service restart.
- **Consent widening should be stated in copy.** With session sharing on, any caller-key holder that can present a bound family digest may spend backup accounts. That is within the declared trust model, but the toggle copy should say it.
- **The downgrade refusal is a runbook guard, not code.** Old code cannot refuse anything. Say that the new checkout's pre-switch command enforces it.
- **Add the lifecycle control command to the CLI contract** and a persisted-status reader, since the tray must write `native-catalog-refresh.json` through the shared writer.
- **Update AGENTS.md**, not only SECURITY.md. The repository's own instructions make AGENTS.md the single source of truth, and its failover section currently says native failover is absent.
- **Do not hard-code the macOS binary path.** Use the desktop entries from `codexCandidatePaths` so a non-standard install does not read as `probe-failed` forever.
- **A backup non-quota failure suppresses the Kimi hop for that turn.** This is a deliberate choice, but it removes Ryan's existing primary-to-Kimi behavior on those turns. Consider allowing the external hop after a clean reservation clear.
- **Without `resets_at`, each Codex client retry re-walks every exhausted backup.** Bounded to one 429 each, but worth a per-account short observation backoff.
- **The `operator` binding reason has no producer** in the CLI contract.
- **The gated-child launcher needs a writable stdin**, which `runProcessTree` does not currently expose.

## Simpler architecture with the same contract

Two reductions preserve every safety property:

- **Replace the keyed HMAC with plain SHA-256 of the root thread ID.** Thread IDs already sit in plaintext in rollout filenames under the same user, and the digest key changes nothing about forgeability. This deletes the secret file, epoch, quarantine state, the cross-file reset transaction, and most crash-injection matrix. Capacity recovery becomes an ordinary tombstone purge with the same confirmation phrase.
- **Keep reservations in memory only.** One router process exists, request-use leases already protect the control plane, and a reservation never exposes bytes. Persist only `bound` and `tombstone`. This removes `reservedUntil`, cross-process CAS, and startup owner-loss tombstoning. A restart during the window correctly leaves the family unbound.

The persisted, keyed design is safe as written. These are optional reductions, not corrections.

## Per-question summary

| Q | Verdict |
|---|---|
| 1 | Safe and migratable; verified against the reader. |
| 2 | Sound; owner tuple and CAS are sufficient. |
| 3 | Sound; turn-state blocks first hop, bound turns never drift. |
| 4 | Sound; see consent-widening copy advisory. |
| 5 | Sufficient; one background refresh is safe. |
| 6 | Sound except the stale-lease rule and lock-two definition above. |
| 7 | Sound; byte-exact prefix retention and zero-byte promotion failure. |
| 8 | Sound; deny-only marker and three attestation states. |
| 9 | Sound; shared context and discriminated return. |
| 10 | Sound; fixture-gated with `unsupported-cache-schema`. |
| 11 | Sound; v3 journal, capture journals, gated child. |
| 12 | Sound; faithful port with tighter suppression. |
| 13 | Sound and load-bearing. |
| 14 | Specified; clarify the runbook guard. |
| 15 | Broad; add the acceptance and activation tests above. |
| 16 | Yes, two reductions listed. |

FABLE_DESIGN: PASS
````

## Controller acceptance

The cycle-3 command exited zero. Its isolated output segment contains exactly
one standalone `FABLE_DESIGN: PASS` and no standalone BLOCK sentinel. The
reviewed architecture is therefore approved for a task-by-task TDD plan.

The implementation plan must treat the three numbered corrections as binding.
It should also adopt the lock-artifact, activation, Control Center copy,
lifecycle control, repository documentation, binary-resolution, and writable-
stdin advisories. The two simplifications are optional and are not adopted
without a new design review because they materially change the reviewed
architecture.
