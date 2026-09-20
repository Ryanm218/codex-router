# Grok chat-stream error shape on #787-main Implementation Plan

> **For agentic workers:** Inline execution in the commissioning session. Do not dispatch subagents for this port. TDD: tests first, watch them fail, then production code.

**Goal:** On live #787-main, grok-oauth committed-head stream failures emit Chat Completions `data: {"error":...}` so LiteLLM does not IndexError on `choices[0]`.

**Architecture:** Listener-local `endChatCompletionStream` replaces `endStreamedResponse` in `src/grok-oauth-forwarder.mjs` only. Usage rides on the finish-reason chunk. Shared Responses `event: error` in `http-utils.mjs` stays for router `/v1/responses`.

**Tech Stack:** Node ESM, `node --test`, grok-oauth-forwarder on `:4208`, LiteLLM chat→Responses on `:4200`.

**Spec:** `docs/superpowers/specs/2026-09-20-grok-chat-stream-error-shape-on-787-main.md`

## Global Constraints

- Base `8ebcd906`. Do not restore native ChatGPT hop. Do not rebase Grok keep-alive / 4xx / schema-flatten.
- Do not edit `src/http-utils.mjs` or `src/router.mjs` error framing.
- Do not patch the LiteLLM venv.
- Isolated worktree `/Users/ryan/Code/Codex/codex-router-grok-error-shape-on-787`. Cherry-pick onto live only after Astra final PASS.
- No live xAI probe.

### Acceptance outcomes

| ID | Observable outcome | Status |
| --- | --- | --- |
| A1 | Streamed `progress_only_unrepairable` is Chat Completions error, not Responses `event: error` | pending |
| A2 | Mid-turn upstream failure uses the same Chat Completions error frame | pending |
| A3 | Successful streams: every non-error chunk has `choices[0]`; usage on finish-reason chunk | pending |
| A4 | Non-stream unrepairable stays HTTP 502 JSON | pending |
| A5 | `http-utils.mjs` / `router.mjs` error framing unchanged | pending |
| A6 | `test/grok-oauth-forwarder.test.mjs` and `npm run check` green | pending |
| A7 | Live install: commit on HEAD, `/health` ok | pending |

---

### Task 1: Failing LiteLLM-safety tests

**Files:**
- Modify: `test/grok-oauth-forwarder.test.mjs` (helpers after `writeSession`, then the stream-error assertions listed below)

**Interfaces:**
- Consumes: existing forwarder test harness (`startForwarder`, SSE/JSON clients)
- Produces: `assertLiteLlmChatToResponsesSafe(body)`, `assertChatCompletionsStreamError(body, code)`

- [ ] **Step 1: Add helpers and retarget assertions (tests only)**

Copy the helpers and assertion updates from `a6accb6c` (`git show a6accb6c -- test/grok-oauth-forwarder.test.mjs`). Do not touch `src/` yet.

Helpers go immediately after `writeSession`:

- `parseSseBlocks`, `sseBlockFields`, `chatCompletionErrorFrames`
- `assertLiteLlmChatToResponsesSafe` — fail if any block has `event: error`, or a non-error JSON chunk lacks `choices[0]`
- `assertChatCompletionsStreamError(body, code)` — exactly one `data: {"error":...}` with that code, type `api_error`, no `[DONE]`, and LiteLLM-safe

Replace `event: error` / `local_router_stream_failed` string matches in:

- `emits one terminal SSE error when the upstream stream fails mid-turn` → `assertChatCompletionsStreamError(result.body, "local_router_stream_failed")`
- `streams xAI reasoning deltas as chat reasoning_content` → add `assertLiteLlmChatToResponsesSafe(body)` and usage token matches
- `buffers a proven progress-only prefix without losing a healthy short answer` (the abort branch)
- `post-tool repair releases held actions only after a successful terminal` (SSE failure branches)
- `an unsuccessful first turn emits one error without replaying its live client tool` (SSE branches) → `assertChatCompletionsStreamError(body, \`grok_upstream_response_${terminal}\`)`
- `double-empty after a tool result is an explicit terminal error, never a clean stop` (SSE) → `assertChatCompletionsStreamError(body, "progress_only_unrepairable")` and drop the `[DONE]` from the finish_reason negative match (error path must not send `[DONE]`; finish_reason still forbidden)

- [ ] **Step 2: Run tests and confirm RED**

```bash
cd /Users/ryan/Code/Codex/codex-router-grok-error-shape-on-787
node --test --test-timeout=120000 test/grok-oauth-forwarder.test.mjs
```

Expected: FAIL on SSE error paths because the current forwarder still writes Responses `event: error` via `endStreamedResponse`. Failure message should mention `event: error` or missing chat.completions error frame — not a harness crash.

- [ ] **Step 3: No commit yet** — tests are the RED proof; commit with the production fix in Task 2.

---

### Task 2: Chat Completions error frames on :4208

**Files:**
- Modify: `src/grok-oauth-forwarder.mjs`
- Modify: `CHANGELOG.md` (Unreleased top)
- Modify: `docs/TROUBLESHOOTING.md` (progress-only 502 paragraph)
- Modify: spec review sentinels after Astra final

**Interfaces:**
- Consumes: `writeJson`, `writeEventStreamHead`; must **stop importing** `endStreamedResponse`
- Produces: `endChatCompletionStream(response, { message, code })`

- [ ] **Step 1: Implement the listener-local helper and call sites**

Port the `a6accb6c` forwarder hunk:

1. Remove `endStreamedResponse` from the `http-utils.mjs` import.
2. Keep `OPENAI_ROLE_CHUNK` emitting `choices: [{ index: 0, delta, finish_reason }]` (block-body form is fine).
3. Add:

```javascript
function endChatCompletionStream(response, { message, code } = {}) {
  if (!response || response.writableEnded || response.destroyed) return;
  const payload = {
    error: {
      message: message || "The Grok OAuth forwarder lost the upstream response stream.",
      type: "api_error",
      code: code || "local_router_stream_failed",
    },
  };
  try {
    response.write(`\n\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // The socket may already be gone; end anyway.
  }
  response.end();
}
```

4. Replace the three `endStreamedResponse` call sites:
   - upstream-terminal-failed, stream already started → `endChatCompletionStream(response, { message, code: \`grok_upstream_response_${status}\` })`
   - progress-only-unrepairable, stream already started → `{ message: repairFailure.message, code: repairFailure.code }`
   - lost-stream cleanup → default message / `local_router_stream_failed`
5. On successful stream finish, write usage on the finish-reason chunk, not a `choices: []` trailer:

```javascript
response.write(OPENAI_ROLE_CHUNK(id, created, model, {}, turn.finishReason, {
  ...(turn.usage ? { usage: turn.usage } : {}),
  ...tierFields,
}));
response.write("data: [DONE]\n\n");
response.end();
```

Do not add `[DONE]` after `endChatCompletionStream`.

- [ ] **Step 2: Run tests GREEN**

```bash
node --test --test-timeout=120000 test/grok-oauth-forwarder.test.mjs
npm run check
```

Expected: grok-oauth 71+ tests pass (count may rise only if helpers add none; suite count stays). `npm run check` pass.

- [ ] **Step 3: Docs**

Add under CHANGELOG `## Unreleased` (top of list, not next to the missing 4xx bullet):

```
- **Grok OAuth chat streams no longer emit Responses `event: error` or empty-choice usage trailers.** LiteLLM translates this listener from Chat Completions to Responses and indexes `choices[0]` on every non-error chunk. A committed-head failure now writes `data: {"error":{message,type,code}}` and closes without `[DONE]`; usage rides on the finish-reason chunk. Direct `/v1/responses` to Codex still uses Responses `event: error`.
```

Update `docs/TROUBLESHOOTING.md` progress-only paragraph to match `a6accb6c`: streamed unrepairable is Chat Completions `data: {"error":...}` with `progress_only_unrepairable`, not Responses `event: error`.

Confirm `git diff --stat` is only: forwarder, its test, CHANGELOG, TROUBLESHOOTING, plus this spec/plan. `src/http-utils.mjs` and `src/router.mjs` must be untouched (`git diff --name-only` check).

- [ ] **Step 4: Commit in the worktree**

```bash
git add src/grok-oauth-forwarder.mjs test/grok-oauth-forwarder.test.mjs CHANGELOG.md docs/TROUBLESHOOTING.md \
  docs/superpowers/specs/2026-09-20-grok-chat-stream-error-shape-on-787-main.md \
  docs/superpowers/plans/2026-09-20-grok-chat-stream-error-shape-on-787-main.md
git commit -m "$(cat <<'EOF'
fix(grok): emit chat.completions errors LiteLLM can translate

A committed-head progress-only failure used Responses event: error
on the grok-oauth Chat Completions listener. LiteLLM's chat→Responses
transform indexes choices[0] and IndexError'd; Codex saw list index
out of range. Emit data: {"error":...} instead, and attach usage to
the finish-reason chunk rather than a choices: [] trailer.

Port of a6accb6c / b0a4fe92 onto the live #787-on-main line.
EOF
)"
```

---

### Task 3: Astra final, then live install

- [ ] **Step 1: Independent Astra Medium final review** from this worktree (`codex exec -C "$WT" -s read-only -m gpt-6-astra -c 'model_reasoning_effort="medium"'`). Accept only standalone `ASTRA_REVIEW: PASS`. Record in the spec. Do not install on BLOCK.

- [ ] **Step 2: Cherry-pick onto live and kickstart**

```bash
LIVE=/Users/ryan/.local/share/codex-router
COMMIT=$(git -C /Users/ryan/Code/Codex/codex-router-grok-error-shape-on-787 rev-parse HEAD)
git -C "$LIVE" cherry-pick "$COMMIT"
launchctl kickstart -k "gui/$(id -u)/io.github.codex-router"
curl -sS http://127.0.0.1:4202/health
```

Confirm live `git merge-base --is-ancestor "$COMMIT" HEAD`, `/health` `"ok":true`, grok-oauth-forwarder listening on `:4208`. Do not force-push. Push `fix/grok-chat-stream-error-on-787-main` to `ryan` if the worktree commit is the source of truth; live `main` follows the cherry-pick.

- [ ] **Step 3: HANDOFF + vault**

Update `~/claude-config/HANDOFF.md` with live SHA and undo (`git -C ~/.local/share/codex-router reset --hard 8ebcd906` then kickstart). Append the matching Obsidian note under `2-Areas/Agency/AI-Stack`, linked from the 2026-09-19 reliability note.
