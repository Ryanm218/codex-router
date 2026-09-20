# #787 auto-review fallback onto origin/main — design record

Date: 2026-09-20
Goal: cherry-pick only a43b6af8 (#787) onto origin/main 80f11c07. Do not restore the native ChatGPT hop. Do not rebase the local Grok stack.

Live checkout stays on main until tests pass.

## Independent review

Astra Medium: UNAVAILABLE (usage cap; retry 2026-09-21 14:54).
Fable 5.1: UNAVAILABLE (Claude org disabled Claude Code).
User asked "Should we add 1?" after 2 and 3 were already on live main. Same-task earlier authorization to proceed without Astra/Fable.

## Architecture

Worktree: /Users/ryan/Code/Codex/codex-router-787-on-main
Branch: feat/787-auto-review-on-main
Cherry-pick: a43b6af8 only. Scope remains codex-auto-review. Configured reviewer grok-oauth/grok-4.6 already written in ~/.codex/codex-router/auto-review-fallback.json.

## Verification

test/auto-review-fallback.test.mjs and the two #787 cases in test/routing.test.mjs.
