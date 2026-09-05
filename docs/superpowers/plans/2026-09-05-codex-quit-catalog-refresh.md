# Codex quit catalog refresh implementation plan

> **For Codex:** Execute with `superpowers:subagent-driven-development`. The design spec is binding. Use strict red-green TDD and keep the controller as the sole committer and pusher.

**Goal:** Refresh the authenticated Codex account model catalog after the last Codex.app instance quits, while keeping the live router configuration and last-known-good merged catalog continuously usable.

**Architecture:** The tray detects a Codex-only positive-to-zero lifecycle transition and invokes one coalesced `catalog-refresh` control operation. The Node side acquires the account catalog from the explicit Codex.app CLI in an isolated private home, attests the online fetch with its fresh cache, validates and constructs the complete catalog transaction in memory, serializes all writers, and commits the merged catalog last.

**Tech stack:** Node.js ESM, `node:test`, `proper-lockfile`, Swift 5.10/AppKit/SwiftUI/XCTest, POSIX shell.

**Spec:** `docs/superpowers/specs/2026-09-05-codex-quit-catalog-refresh-design.md`

## Global constraints

- Preserve ancestry commit `1db3bfdd9fbc` and all Kimi quota-fallback behavior.
- Never read credential contents in router code, and never render CLI stdout/stderr, auth data, config data, or environment data in errors or logs.
- Never disable, rewrite, back up, or restore live `~/.codex/config.toml` during catalog refresh.
- The unattended path must use the explicit Codex.app bundled CLI, a private isolated `CODEX_HOME`, file credential storage, an allowlisted child environment, and a fresh cache attestation. Silent bundled fallback is failure.
- All catalog writers share one cross-process lock. All output is validated before the first target write. Native/auxiliary outputs publish before `merged-models.json`; capture metadata publishes only after merged. Handled failure keeps the prior merged and restores prior auxiliary bytes.
- Initial app absence, ChatGPT exits, intermediate Codex-instance exits, duplicate notifications, and managed restart quits must not refresh. One in-flight refresh plus one coalesced rerun is the maximum.
- Automatic failure messages are fixed and sanitized. Missing auth is a quiet `skipped`; unsafe auth metadata is a failure.
- Do not force-quit Codex, relaunch it, run inference, modify the live tray before final review, merge upstream, or touch the stable checkout's untracked `.agents/` directory.
- Pre-final app-bundle builds use an explicit scratch bundle path.
- The controller alone creates the final single commit, creates the public fork, pushes, installs, and updates durable handoff/vault records.

## Task 1: Build the isolated native-catalog acquisition boundary

**Files:**

- Create: `src/native-catalog-refresh.mjs`
- Create: `test/native-catalog-refresh.test.mjs`

**Step 1 — Write failing tests:** Add fixtures for a fake Codex binary and scratch state/auth paths. Assert that missing auth returns `{status:"skipped", reason:"signed-out"}` before spawn; auth symlink, wrong mode, wrong owner, or path replacement returns stable codes before publication; and the runner receives the explicit Codex.app path contract, `-c cli_auth_credentials_store="file"`, `debug models`, a mode-0700 temporary `CODEX_HOME`, and an allowlisted environment without API/base-URL/proxy override variables.

**Step 2 — Prove RED:** Run `node --test test/native-catalog-refresh.test.mjs`; confirm module-not-found or assertion failures for the new behavior.

**Step 3 — Implement metadata admission and runner injection:** Export a testable acquisition function accepting explicit paths, clock, uid, runner, and cleanup dependencies. Use `lstat`, parent-realpath comparison, uid, and exact `0600` checks without opening auth. Create the temporary directory beneath state with exact `0700`; create one auth symlink; spawn only the explicit Codex.app binary with the fixed override and allowlisted environment.

**Step 4 — Add failing attestation tests:** Cover nonzero child exit, invalid/empty stdout, stderr sentinel, absent/new-cache failure, stale `fetched_at`, wrong `client_version`, duplicate/empty slugs, stdout/cache slug mismatch, routed-slug collision, missing enriched fields, invalid reasoning structure, and preservation of speed tiers/service tiers/model messages/unknown fields. Assert no raw child text appears in thrown errors.

**Step 5 — Prove RED, then implement validation:** Require a regular current-user-owned cache created during the invocation with no group/world write bits (the verified `0700` parent supplies confidentiality and permits the official CLI's `0644` mode), matching the bare semantic version derived from the explicit binary's branded version output, an invocation-window timestamp with the documented skew, equal non-empty unique slug sets, no `MODEL_BY_SLUG` collision, and complete listed-model metadata. Return the complete stdout candidate without normalizing away unknown fields.

**Step 6 — Add cleanup/postflight tests and implement:** Verify canonical inode/type/owner/mode and exact expected temp symlink after the child. Unlink the symlink before removing the generated tree. If the temp auth path changes type/target, leave the private tree and return a stable postflight error. Cover an in-place auth write that preserves inode and an unexpected canonical replacement that aborts.

**Step 7 — Prove GREEN:** Run `node --test test/native-catalog-refresh.test.mjs` and `npm run check`.

## Task 2: Make catalog construction and publication transactional under one lock

**Files:**

- Create: `src/catalog-operation-lock.mjs`
- Create: `test/catalog-operation-lock.test.mjs`
- Modify: `src/catalog.mjs`
- Modify: `test/catalog.test.mjs`

**Step 1 — Write failing lock tests:** Assert two asynchronous holders serialize, acquisition timeout maps to a stable retry error, the lock heartbeat/stale interval exceeds acquisition, and all `catalog.mjs` CLI entry modes pass through the lock.

**Step 2 — Prove RED, then implement lock:** Follow the existing service-lock shape with a dedicated target and a writer wait longer than native acquisition. Export dependency-injectable options for deterministic tests.

**Step 3 — Write failing transaction tests:** Assert complete artifacts are built without writes; routed Kimi models and native alias/login-mode invariants survive; candidate unknown fields survive; matching digest returns `unchanged` only when active native+merged consistency matches; interrupted/mismatched metadata forces repair; and capture metadata is written after the merged rename.

**Step 4 — Write failing fault-injection tests:** Inject failures at staging and each rename. Assert validation failures touch no target and every handled pre-merged failure restores exact prior native/alias/announcement bytes while the prior merged bytes and mtime remain active. Verify merged is the last catalog rename.

**Step 5 — Prove RED, then refactor:** Separate native selection, pure artifact construction, staged private-file validation, publication, and CLI orchestration. Keep existing normal reuse/version-fallback behavior. For the forced safe candidate, perform no bundled fallback, validate merge uniqueness and alias invariants, and publish capture metadata only after merged is active.

**Step 6 — Prove GREEN:** Run `node --test test/catalog-operation-lock.test.mjs test/catalog.test.mjs test/native-catalog-refresh.test.mjs`, then `npm test` and `npm run check`.

## Task 3: Expose the safe operation through control and manual refresh

**Files:**

- Modify: `src/control.mjs`
- Modify: `bin/refresh-catalog`
- Modify: `test/control.test.mjs`
- Create: `test/refresh-catalog-script.test.mjs`

**Step 1 — Write failing dispatch tests:** Assert `bin/control catalog-refresh` invokes the safe transaction and returns only `{status:"updated|unchanged|skipped", nativeModels:<integer>}`. Assert stable nonzero failure text contains a local reason code but never fixture stdout/stderr.

**Step 2 — Prove RED, then implement control dispatch:** Dynamically import the refresh orchestrator only for this command. Keep other control paths unchanged.

**Step 3 — Write failing shell-contract tests:** Assert macOS manual refresh delegates to `bin/control catalog-refresh`, never runs config-manager disable/enable, and does not swallow a restore failure because no restoration exists. Unsupported platforms must fail with explicit guidance.

**Step 4 — Prove RED, then rewrite script:** Keep POSIX `sh`, `set -eu`, and exact source-root resolution. Emit a concise next-launch message only after a successful safe result.

**Step 5 — Prove GREEN:** Run `node --test test/control.test.mjs test/refresh-catalog-script.test.mjs test/native-catalog-refresh.test.mjs test/catalog.test.mjs` and `sh -n bin/refresh-catalog bin/control`.

## Task 4: Add a pure, testable Codex lifecycle/coalescing state machine

**Files:**

- Create: `apps/macos/ModelRouterTray/Sources/CodexCatalogRefreshCoordinator.swift`
- Create: `apps/macos/ModelRouterTray/Tests/CodexCatalogRefreshTests.swift`

**Step 1 — Write failing transition tests:** Assert seed false does nothing; `0→1→0` refreshes once; `2→1` does not and `1→0` does; ChatGPT state is irrelevant; repeated zero does not duplicate; and an unconsumed managed-restart suppression token is cleared on a later zero-to-positive observation.

**Step 2 — Prove RED, then implement transition state:** Model observed Codex instance count separately from the aggregate host-app state. Make suppression consume exactly one positive-to-zero transition and expose a deterministic action result.

**Step 3 — Write failing coalescing tests:** With an async gate, assert one in-flight operation, any number of duplicate observations coalesces, and two complete launch/quit cycles while blocked schedule exactly one follow-up.

**Step 4 — Prove RED, then implement coordinator:** Keep state main-actor serialized; expose only closures needed by `RouterStore` and tests.

**Step 5 — Prove GREEN:** Run `swift test --package-path apps/macos/ModelRouterTray --filter CodexCatalogRefreshTests`.

## Task 5: Integrate the coordinator into the real tray and sanitize status

**Files:**

- Modify: `apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift`
- Modify: `apps/macos/ModelRouterTray/Tests/CodexCatalogRefreshTests.swift`

**Step 1 — Write failing RouterStore tests:** Through `controlRunnerOverride`, assert final Codex exit issues exactly `["catalog-refresh"]`; catalog work waits behind `providerOperation`; provider mutation cannot begin while catalog work owns the operation; a second completed cycle coalesces once; a managed `restartCodexApp` quit is suppressed; and `SECRET_RAW_BODY` from a thrown control error never reaches `message`.

**Step 2 — Prove RED, then integrate:** Keep existing `hostAppRunning` aggregation for surfaces/service. Re-query live Codex instance count on relevant workspace notifications, feed the coordinator, and drain refreshes asynchronously. Reserve `providerOperation = "catalog-refresh"` only while running. Parse the narrow result and use only fixed messages from the design, including the fast-relaunch message when Codex is running at completion. Missing-auth `skipped` is quiet.

**Step 3 — Integrate restart suppression:** Arm before the graceful managed termination; clear on failure; consume on the relevant exit; clear stale token on relaunch-before-notification. Do not add timers or force termination.

**Step 4 — Prove GREEN:** Run the targeted Swift filter, full `swift test --package-path apps/macos/ModelRouterTray`, and `swift build -c release --package-path apps/macos/ModelRouterTray`.

## Task 6: Documentation, whole-branch verification, review, Git, and installation

**Files:**

- Modify: `docs/MACOS-TRAY.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Use scratch output only: `/private/tmp/model-router-catalog-refresh-build/Model Router.app`

**Step 1 — Document behavior and recovery:** Explain final-instance semantics, next-launch timing, coalescing, quiet skip, fixed failure status, manual safe command, last-known-good guarantee, and that an upstream update alone is not the freshness mechanism.

**Step 2 — Run fresh complete verification:** Run `npm run check`, targeted Node tests, `npm test`, targeted Swift tests, full Swift tests, release Swift build, `scripts/build-macos-tray-app.sh '/private/tmp/model-router-catalog-refresh-build/Model Router.app'`, `sh -n` on changed shell scripts, `git diff --check`, and relevant router doctor/catalog invariant checks against scratch state. Confirm Astra and the selected Kimi route remain represented without an inference call.

**Step 3 — Independent reviews:** Complete the subagent task reviews and one broad whole-branch review. Then run the mandatory read-only Fable final review with exact requirement/diff/test evidence; require exactly one standalone `FABLE_REVIEW: PASS` before commit or push.

**Step 4 — Create one final commit and public fork:** Controller stages only reviewed paths, verifies no secret or `.agents/` path is included, creates one feature commit, creates the approved public `Ryanm218/codex-router` fork, pushes `feat/catalog-refresh-on-codex-quit`, fetches, and verifies local/remote SHA parity. Do not open an upstream PR or merge upstream.

**Step 5 — Install from the stable checkout:** Fast-forward the stable checkout to the reviewed commit, run its installer/rebuild the persistent tray, and verify doctor, effective source-root, Astra, Kimi fallback, and rendered tray behavior. Do not terminate Codex; the next ordinary user quit/open is lifecycle acceptance.

**Step 6 — Durable records:** In the separate `claude-config` owner repository, update the shared `HANDOFF.md` without overwriting unrelated active work and publish that repository according to its own rules. Update the existing Astra vault incident note with change, reason, verification, rollback, commit, remote, and the date of the live-state snapshot. Neither external record is part of the router feature commit.
