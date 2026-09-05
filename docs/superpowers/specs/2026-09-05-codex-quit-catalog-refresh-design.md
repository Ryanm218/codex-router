# Refresh the Codex model catalog after the final app quit

**Status:** User-approved, literature-grounded, and independently design-reviewed
**Date:** 2026-09-05
**Target:** Codex Router `0.4.0-beta.2` at `1db3bfdd9fbc`, including the three local Kimi quota-fallback commits
**Primary user outcome:** A normal full quit of Codex refreshes the router's native account catalog so a newly released OpenAI model is available on the next launch without a manual router repair.
**Grounding:** `2-Areas/Agency/AI-Stack/Codex-Catalog-Refresh-Safety-Research-2026-09-05.md`

## Decision

Extend the existing macOS menu-bar tray. It already observes application launch and termination through `NSWorkspace`; it will additionally track the number of running `com.openai.codex` applications and schedule one refresh only when that count transitions from positive to zero.

The refresh will not use the current `bin/refresh-catalog` transaction, because that command temporarily disables the router's live Codex configuration. A user who reopens Codex during that gap can load an unintended native/bypass configuration. Instead, a new Node control action will run the official CLI from `/Applications/Codex.app` inside a private, temporary `CODEX_HOME` that has no `config.toml` and no previous model cache. It will link only the existing protected `auth.json`, force Codex's file credential backend, fetch the account catalog, validate the CLI output and newly created cache, build all router catalog artifacts in memory, and publish the merged catalog last under a dedicated cross-process lock.

The live `~/.codex/config.toml`, its caller-capability URL, the running router service, provider selection, Kimi fallback state, and authentication contents are never read into logs or modified by this operation. A fast relaunch is safe: it sees either the previous complete merged catalog or the new complete merged catalog. If it launches before publication, the tray reports that one more normal quit/reopen is needed; it never terminates the relaunched app.

The feature will be implemented from the current live Kimi-enabled ancestry and pushed as one feature commit to a public `Ryanm218/codex-router` fork. The exact upstream divergence is time-varying; updating or rebasing across it is a separate integration task.

## Why upstream update is not the fix

Current `origin/main` adopts a pre-existing user-owned native catalog but does not add a quit-triggered refresh or freshness policy. The current checkout reuses `native-models.json` whenever the Codex CLI version is unchanged, so a server-side release can remain absent indefinitely. The built-in updater also requires branch `main`, while this installation intentionally runs the unpushed `feat/kimi-quota-fallback` branch.

This change fixes the model-release recurrence directly and makes the custom installation recoverable from Git. It does not silently merge upstream or claim that future fork synchronization is automatic.

## Scope

### In scope

- macOS tray observation of the final Codex.app instance terminating;
- one coalesced refresh, plus at most one pending rerun after another complete launch/quit cycle;
- an explicit `bin/control catalog-refresh` operation;
- online account-catalog acquisition using the Codex.app bundled CLI and existing ChatGPT authentication;
- strict authentication-file metadata checks without reading or rendering credential contents;
- validation of the fresh cache as proof that the invocation actually reached the account catalog;
- in-memory construction and last-known-good publication of native and merged router catalogs;
- a dedicated cross-process catalog-operation lock used by all `catalog.mjs` CLI builds;
- replacing the unsafe macOS manual refresh path with the same control operation;
- sanitized tray success/failure status;
- Node and Swift regression coverage, documentation, local installation, and Git push.

### Out of scope

- force-quitting or automatically relaunching Codex after an ordinary user quit;
- a timer, LaunchAgent, file watcher, or second persistent daemon;
- any inference request or quota-consuming model smoke test;
- reading, copying, printing, backing up, or restoring credential contents;
- changing provider routing, Kimi quota fallback, caller authentication, or the router service lifecycle;
- integrating the current feature stack with `origin/main`;
- a repository-wide generation-pointer migration for every catalog reader;
- Windows or Linux tray lifecycle behavior.

## Lifecycle contract

The existing aggregate `hostAppRunning` remains responsible for visibility and follow-Codex service behavior across both Codex and ChatGPT. Catalog refresh gets a separate Codex-only tracker.

The tracker starts unarmed. Its transitions are:

| Previous Codex count | Current count | Result |
| ---: | ---: | --- |
| unknown | any | seed only; no refresh |
| 0 | positive | arm a future final-exit refresh |
| 2 or more | positive | no refresh |
| positive | 0 | enqueue one refresh |
| 0 | 0 | no refresh |

The workspace termination notification identifies which application ended, but it is not treated as proof that all Codex instances are gone. On every relevant notification the tray re-queries `NSRunningApplication.runningApplications(withBundleIdentifier:)` and triggers only on the observed positive-to-zero count transition. A ChatGPT quit never triggers the action, and ChatGPT remaining open never suppresses it.

`catalogRefreshTask` owns one asynchronous drain loop on the main actor. A boolean records whether a second complete launch/quit happened while work was in flight; any number of duplicate notifications coalesces to at most one follow-up run. The refresh waits for the existing provider-operation exclusion boundary and then marks itself as `catalog-refresh`, so provider, picker, auth-mode, maintenance, and automatic catalog mutations do not overlap in the tray process. The Node lock provides cross-process serialization.

The deliberate quit inside the tray's managed Codex restart consumes an explicit suppression token. Suppression is attached to one positive-to-zero transition, not to a timing window or the string value of another operation. If the graceful termination fails, the token is cleared. If a zero-to-positive observation arrives before the token was consumed, the token is also cleared so a reordered workspace notification cannot suppress a later ordinary quit.

## Isolated acquisition and credential boundary

The acquisition module accepts the explicit Codex.app CLI path. It must not use the existing resolver that prefers ChatGPT.app before Codex.app.

Before spawning anything it checks the canonical `~/.codex/auth.json` with metadata operations only:

1. the path exists and `lstat` says the canonical path itself is a regular file, not a symlink;
2. the file's real path equals the exact filename beneath the real path of the configured parent directory, allowing a legitimate symlinked `~/.codex` directory without allowing the file itself to be a symlink;
3. the file owner is the current effective uid;
4. the Unix mode is exactly `0600`;
5. the file is not group- or world-writable.

It creates a unique directory beneath the router state directory with mode `0700`, verifies the resulting mode and ownership, and creates exactly one symlink named `auth.json` that targets the validated canonical file. It does not open the credential file itself.

The child command is equivalent to:

```text
CODEX_HOME=<private-temporary-directory> \
  /Applications/Codex.app/Contents/Resources/codex \
  -c 'cli_auth_credentials_store="file"' \
  debug models
```

The child receives a small allowlisted environment containing only the operating-system values required to launch the explicit binary, plus the generated `CODEX_HOME`, and its working directory is that same private home. API-key, base-URL, proxy, and provider override variables are not inherited. The temporary home has no `config.toml` and no model cache, so `debug models` uses the online-if-uncached account route. The forced file backend follows Codex's current in-place `auth.json` write behavior. Because the final app process is already gone, there is no Codex.app writer competing for the file.

CLI stdout, stderr, and the temporary cache are captured privately. None may be included in an exception, tray message, normal log, support text, or Git artifact. After the child exits, the module verifies that the temporary auth path is still the expected symlink and that the canonical auth path retains the same inode, owner, type, and mode. It unlinks the temporary auth symlink before removing the exact generated temporary tree and never follows the link during cleanup. If the temporary auth path is no longer the expected symlink, it does not unlink that path or recursively delete the directory; it leaves the private `0700` tree for manual recovery and returns a stable postflight error code.

The design deliberately does not restore an old auth copy after a child failure. An OAuth refresh may rotate a token, making an old copy invalid, and the router never reads credential contents. A failed postflight aborts catalog publication and reports a stable error code for manual diagnosis.

## Candidate and freshness validation

`debug models` stdout is the candidate native catalog. Raw `models_cache.json` is not copied into router state because it omits enriched fields such as `base_instructions`. The newly created temporary cache is only an acquisition attestation.

The candidate is accepted only when all of these hold:

- the child exits zero;
- a new regular temporary `models_cache.json` exists in the generated home, is
  owned by the current effective uid, and has no group- or world-write bits;
  confidentiality comes from the already verified `0700` parent, so the
  official CLI's observed `0644` cache mode is valid;
- its `client_version` equals the bare semantic version derived from the
  invoked Codex CLI's exact branded version output;
- its parseable `fetched_at` falls within the invocation window with a small documented clock-skew allowance;
- both cache and stdout contain non-empty model arrays;
- every slug is a unique non-empty string and the two slug sets match exactly;
- no native slug collides with a routed slug in `MODEL_BY_SLUG`;
- every listed candidate carries a non-empty `base_instructions`, display name, integer priority, visibility, and a valid reasoning-level structure;
- the complete candidate retains speed tiers, service tiers, model messages, and unknown upstream fields verbatim;
- a dry in-memory merge retains all selected external routes, produces unique slugs, and satisfies login-mode alias invariants.

The operation calculates a SHA-256 digest of the validated candidate and records its account ETag, fetch time, and client version as internal native-capture metadata. It performs an online acquisition on every final quit. If the validated digest and version match the last capture, it returns `unchanged` only after verifying that the active native and merged catalogs are consistent with that digest. Capture metadata is committed only after the merged catalog rename, so an interrupted earlier publication cannot mask the next repair. The `captured_with` value uses the exact branded version string returned by the explicit Codex.app binary inside the isolated acquisition boundary; only the derived bare semantic version is compared with the cache.

There is no bundled fallback in the unattended path. Network, authentication, parse, cache-attestation, or validation failure retains the last-known-good catalog.

## Locking and publication

Add a dedicated catalog-operation lock beside the existing service-operation lock, using the repository's pinned `proper-lockfile` dependency. Every command-line execution of `catalog.mjs`, including install/apply/manual paths, holds the lock from native acquisition through final publication. A second writer waits for a bounded interval longer than the maximum acquisition timeout or fails with a stable retry message. The stale interval must exceed the maximum acquisition timeout and the lock heartbeat must remain active during the child process.

The refresh builds native, alias, announcement, and merged JSON values in memory before the first target changes. Each file is staged beside its destination with mode `0600`, parsed back for validation, and renamed on the same filesystem. Native and auxiliary files publish first; `merged-models.json` publishes last because it is the only file Codex reads at startup.

For every handled write or rename failure before the merged rename, restore any already-published auxiliary/native file from the exact previous bytes and leave the old merged file active. No failure after the merged rename may be introduced: all validation, routed-agent synchronization, staging, and auxiliary publication happen first. A process kill between renames can leave a newer native file beside an older merged file, but both individual files remain complete; the next locked refresh repairs the pair. Closing that process-kill window completely requires a versioned generation plus one pointer and changing every reader, which is outside this surgical feature.

## Control and tray output

The control interface is:

```text
bin/control catalog-refresh
```

Successful stdout is narrow JSON:

```json
{"status":"updated","nativeModels":9}
```

or:

```json
{"status":"unchanged","nativeModels":9}
```

If no protected ChatGPT file credential is configured, the operation returns a quiet `skipped` status rather than presenting an error on every quit. This skip is decided by metadata preflight before any child process starts; malformed or unsafe credential metadata remains a failure.

Failures exit nonzero and expose only a fixed message and stable local reason code. The tray discards raw subprocess errors and uses fixed operator copy:

- `Model catalog refreshed for the next Codex launch.`
- `Model catalog is already current.`
- `Model catalog refreshed. Quit and reopen Codex once more.` when Codex relaunched before publication;
- `Catalog refresh failed; the previous catalog remains active.`

The existing manual `bin/refresh-catalog` command calls this same safe operation on macOS. It no longer disables and restores the live router configuration or prints success after a swallowed restore error. Unsupported platforms keep an explicit manual fallback rather than silently claiming account freshness.

## Test contract

All implementation follows strict red-green TDD. No test performs a live account request.

### Node tests

- metadata-only auth admission: signed-out absence skips, while symlinked, wrong owner, and wrong mode fail before spawn;
- an executable fixture receives the explicit Codex.app path contract, a private temporary home, and the exact file-credential override;
- the fixture writes a complete stdout catalog and cache attestation; speed tiers, service tiers, model messages, and an unknown field survive publication;
- same CLI version still performs acquisition; matching digest returns `unchanged` without touching catalog mtimes;
- child failure, stderr sentinel, invalid JSON, empty models, duplicate or routed slugs, missing required fields, stale cache, version mismatch, and cache/stdout slug mismatch retain byte-identical last-known-good native and merged files;
- no config file is copied, disabled, parsed, or restored;
- cleanup removes only the generated temporary tree and never the canonical auth target;
- an in-place fixture auth write preserves the canonical inode and remains valid; unexpected link/inode replacement aborts publication;
- concurrent catalog executions serialize under the dedicated lock;
- selected Kimi routes and native alias invariants survive the refreshed merge;
- manual refresh and control dispatch return stable results without raw stderr.

### Swift tests

- initial absence does not refresh;
- `0 -> 1 -> 0` issues exactly one command;
- `2 -> 1` does not refresh and `1 -> 0` does;
- ChatGPT remaining open does not suppress the Codex action;
- repeated zero observations do not duplicate work;
- two complete cycles during a blocked refresh coalesce to one follow-up;
- one managed-restart suppression token consumes exactly one exit;
- catalog and provider operations never overlap;
- a raw-error sentinel never appears in the tray message.

### Repository and UI verification

```text
npm run check
targeted Node tests
npm test
swift test
release Swift build and macOS app-bundle build to a scratch bundle path
shell syntax checks
git diff --check
bin/model-router codex doctor
```

The installed tray must be opened and visually inspected in its real rendered menu-bar surface. The feature adds no new control, so acceptance checks status behavior and verifies the tray remains responsive while the refresh command runs. This task does not terminate Codex. The next ordinary user quit/open cycle is the live lifecycle acceptance.

## Deployment and Git

The production commit remains in the ancestry of `1db3bfdd9fbc`, preserving Kimi quota fallback. The pre-existing untracked `.agents/` directory in the stable checkout is never copied, staged, or modified.

After fresh tests and the mandatory Fable final review:

1. create the approved public `Ryanm218/codex-router` GitHub fork;
2. push `feat/catalog-refresh-on-codex-quit` and verify local/remote SHA parity;
3. fast-forward the stable checkout to the reviewed commit without using a disposable worktree as its installed source owner;
4. run the installer and rebuild the persistent tray bundle from the stable checkout;
5. run doctor, verify the merged catalog still contains Astra and the selected Kimi route, and inspect the real tray;
6. push any documentation included in the same reviewed commit and re-fetch for parity.

No force-push, upstream PR, upstream merge, billed model request, or Codex quit is part of this task.

## Rollback

Operational rollback is to install the parent commit `1db3bfdd9fbc` from the stable checkout and rebuild the tray. The previous native and merged catalogs remain last-known-good throughout acquisition and validation failures. Repository rollback is a normal revert of the single feature commit on the user-owned fork; it does not alter credentials, provider selection, Kimi fallback state, logs, or unrelated Codex settings.

## Review gates

This changes AI-harness model catalog wiring and therefore requires:

1. an independent read-only Fable design review of this exact document before the first production edit;
2. a failing test before each production behavior change;
3. fresh complete local verification;
4. an independent read-only Fable final review before commit or push;
5. installation and rendered-UI acceptance without a forced Codex quit or model request.

## Independent design approval

Approved on 2026-09-05 by an independent read-only Fable review of this exact design and the actual repository:

```text
FABLE_DESIGN: PASS
```

The reviewer specifically conditioned implementation on consistency-aware `unchanged` handling, non-destructive cleanup if the temporary auth link changes type, a child-environment allowlist, exact `captured_with` normalization, quiet signed-out skips, stale suppression-token clearing, scratch-path bundle builds, and a writer wait longer than acquisition. Those conditions are incorporated above. The grounding note was subsequently confirmed at the stated vault path.
