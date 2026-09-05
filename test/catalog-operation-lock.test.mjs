import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CATALOG_ACQUISITION_TIMEOUT_MS,
  withCatalogOperationLock,
} from "../src/catalog-operation-lock.mjs";
import { runCatalogCli } from "../src/catalog.mjs";

test("catalog operation lock serializes two asynchronous holders", { timeout: 5_000 }, async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-lock-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const events = [];
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered;
  const firstDidEnter = new Promise((resolve) => {
    firstEntered = resolve;
  });

  const first = withCatalogOperationLock(async () => {
    events.push("first-enter");
    firstEntered();
    await firstMayFinish;
    events.push("first-exit");
  }, { stateDir, waitMs: 1_000, retryMs: 10, staleMs: 5_000, updateMs: 100 });
  await firstDidEnter;
  const second = withCatalogOperationLock(async () => {
    events.push("second-enter");
  }, { stateDir, waitMs: 1_000, retryMs: 10, staleMs: 5_000, updateMs: 100 });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events, ["first-enter"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-enter", "first-exit", "second-enter"]);
});

test("catalog operation lock maps acquisition timeout to a stable retry error", async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-lock-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered;
  const firstDidEnter = new Promise((resolve) => {
    firstEntered = resolve;
  });
  const first = withCatalogOperationLock(async () => {
    firstEntered();
    await firstMayFinish;
  }, { stateDir, waitMs: 500, retryMs: 10, staleMs: 5_000, updateMs: 100 });

  await firstDidEnter;
  await assert.rejects(
    withCatalogOperationLock(async () => undefined, {
      stateDir,
      waitMs: 40,
      retryMs: 10,
      staleMs: 5_000,
      updateMs: 100,
    }),
    (error) =>
      error?.code === "catalog_operation_locked" &&
      error.message === "Another catalog operation is still running; retry shortly.",
  );
  releaseFirst();
  await first;
});

test("catalog lock defaults outlive acquisition and keep a heartbeat active", async () => {
  let observed;
  const lock = async (target, options) => {
    observed = { target, options };
    return async () => {};
  };

  await withCatalogOperationLock(async () => "held", {
    stateDir: "/fixture/state",
    mkdir: () => {},
    lock,
  });

  assert.equal(CATALOG_ACQUISITION_TIMEOUT_MS, 10_000 + 30_000);
  assert.ok(observed.options.waitMs >= CATALOG_ACQUISITION_TIMEOUT_MS + 5_000);
  assert.ok(observed.options.stale > CATALOG_ACQUISITION_TIMEOUT_MS);
  assert.ok(observed.options.update > 0);
  assert.ok(observed.options.update < CATALOG_ACQUISITION_TIMEOUT_MS);
  assert.ok(observed.options.update <= observed.options.stale / 2);
});

for (const argv of [[], ["--refresh-native"], ["--bundled-native"]]) {
  test(`catalog CLI mode ${argv[0] || "default"} passes through the operation lock`, async () => {
    const events = [];
    const result = await runCatalogCli({
      argv,
      withLock: async (operation) => {
        events.push("lock-enter");
        const value = await operation();
        events.push("lock-exit");
        return value;
      },
      operation: async (flags) => {
        events.push(["operation", flags]);
        return { mode: argv[0] || "default" };
      },
    });

    assert.deepEqual(events, [
      "lock-enter",
      ["operation", {
        refreshNative: argv.includes("--refresh-native"),
        bundledNative: argv.includes("--bundled-native"),
      }],
      "lock-exit",
    ]);
    assert.deepEqual(result, { mode: argv[0] || "default" });
  });
}
