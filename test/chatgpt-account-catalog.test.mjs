import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureChatGPTAccountCatalog,
} from "../src/chatgpt-account-catalog.mjs";
import {
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";

test("account catalog capture publishes a ready generation for an isolated profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-account-catalog-"));
  const homesDir = path.join(root, "homes");
  const filePath = path.join(root, "pool.json");
  try {
    const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
    const result = await captureChatGPTAccountCatalog(account.id, {
      filePath,
      homesDir,
      binary: "/fake/codex",
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] }),
      }),
    });
    assert.ok(result?.generation);
    const catalogPath = path.join(
      homesDir,
      account.id,
      "router-catalog",
      "fallback-native-models.json",
    );
    assert.equal(existsSync(catalogPath), true);
    assert.equal(
      existsSync(path.join(homesDir, account.id, "router-catalog", "native-models.json")),
      false,
    );
    assert.equal(JSON.parse(readFileSync(catalogPath, "utf8")).generation, result.generation);
    assert.equal(readChatGPTAccountPoolState(filePath).accounts[account.id].fallback.catalog.state, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
