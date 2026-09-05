import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chatGPTAccountOperationLockPath,
  withChatGPTAccountOperationLock,
  withOrderedChatGPTLocks,
} from "../src/chatgpt-account-operation-lock.mjs";
import {
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  refreshChatGPTSubscriptionAccount,
  removeChatGPTSubscriptionAccount,
} from "../src/chatgpt-account-pool.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-account-operation-lock-"));
  const options = {
    filePath: path.join(root, "pool.json"),
    homesDir: path.join(root, "accounts"),
    waitMs: 2_000,
    retryMs: 10,
  };
  const first = createChatGPTSubscriptionAccount(options);
  const second = createChatGPTSubscriptionAccount(options);
  return { root, options, first, second };
}

test("the account operation lock uses the exact private account-home path", async () => {
  const { options, first } = fixture();
  const expected = path.join(options.homesDir, first.id, "router-account.lock");
  assert.equal(chatGPTAccountOperationLockPath(first.id, options), expected);
  await withChatGPTAccountOperationLock(first.id, async () => {
    assert.equal(existsSync(expected), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(expected).mode & 0o777, 0o700);
    }
  }, options);
  assert.equal(existsSync(expected), false);
});

test("ordered account locks normalize duplicates and acquire canonical ids in lexical order", async () => {
  const { options, first, second } = fixture();
  const acquired = [];
  await withOrderedChatGPTLocks(
    [` ${second.id} `, first.id, second.id],
    async () => {},
    { ...options, onAcquired: (id) => acquired.push(id) },
  );
  assert.deepEqual(acquired, [first.id, second.id].sort());
});

test("opposite requested account orders cannot deadlock", async () => {
  const { options, first, second } = fixture();
  const orders = [
    [second.id, first.id],
    [first.id, second.id],
  ];
  const completed = await Promise.all(orders.map((ids, index) => withOrderedChatGPTLocks(
    ids,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return index;
    },
    options,
  )));
  assert.deepEqual(completed.sort(), [0, 1]);
});

test("operation-lock validation never chmods or enters through a replaced symlink path", async () => {
  if (process.platform === "win32") return;
  const { root, options, first } = fixture();
  const outside = path.join(root, "outside-lock-target");
  const displaced = path.join(root, "displaced-operation-lock");
  mkdirSync(outside, { mode: 0o755 });
  chmodSync(outside, 0o755);
  let entered = false;
  await assert.rejects(
    withChatGPTAccountOperationLock(first.id, async () => {
      entered = true;
    }, {
      ...options,
      beforeValidateLock(_accountId, lockPath) {
        renameSync(lockPath, displaced);
        symlinkSync(outside, lockPath);
      },
    }),
    /symbolic|identity|operation lock/i,
  );
  assert.equal(entered, false);
  assert.equal(statSync(outside).mode & 0o777, 0o755);
});

test("public account removal cannot bypass an in-flight account operation lock", async () => {
  const { options, first } = fixture();
  let releaseHolder;
  const holderReady = new Promise((resolve) => {
    releaseHolder = resolve;
  });
  let acquired;
  const entered = new Promise((resolve) => {
    acquired = resolve;
  });
  const holder = withChatGPTAccountOperationLock(first.id, async () => {
    acquired();
    await holderReady;
  }, options);
  await entered;
  assert.throws(
    () => removeChatGPTSubscriptionAccount(first.id, { ...options, waitMs: 25 }),
    /lock|busy|already being held/i,
  );
  assert.ok(readChatGPTAccountPoolState(options.filePath).accounts[first.id]);
  releaseHolder();
  await holder;
});

test("background refresh and interactive login reserve the same operation lock before child work", async () => {
  const { options, first } = fixture();
  const ipcModule = await import("../apps/control-center/electron/ipc.mjs");
  const sequence = [];
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshEntered;
  const refreshReady = new Promise((resolve) => {
    refreshEntered = resolve;
  });
  const refresh = refreshChatGPTSubscriptionAccount(first.id, {
    ...options,
    force: true,
    binary: process.execPath,
    createLoginLease: async () => {
      sequence.push("refresh-reserved");
      assert.equal(existsSync(chatGPTAccountOperationLockPath(first.id, options)), true);
      refreshEntered();
      await refreshGate;
      return { nonce: "refresh", release: async () => true };
    },
    spawnImpl: () => {
      throw new Error("intentional child stop");
    },
  });
  await refreshReady;
  let loginFinished = false;
  const login = ipcModule.reserveChatGPTInteractiveLogin(first.id, {
    ...options,
    createLoginLease: async () => {
      sequence.push("interactive-reserved");
      assert.equal(existsSync(chatGPTAccountOperationLockPath(first.id, options)), true);
      return { nonce: "interactive", release: async () => true };
    },
  }).then((value) => {
    loginFinished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(loginFinished, false);
  releaseRefresh();
  await refresh;
  const reservation = await login;
  assert.deepEqual(sequence, ["refresh-reserved", "interactive-reserved"]);
  await reservation.release();
});

test("background refresh and interactive login both refuse a durable profile-switch reservation", async () => {
  const { root, options, first } = fixture();
  const switchPath = path.join(root, "switch.json");
  mkdirSync(path.join(root, "chatgpt-profile", "switch-transaction"), {
    recursive: true,
    mode: 0o700,
  });
  let refreshLeaseCreated = false;
  const refreshed = await refreshChatGPTSubscriptionAccount(first.id, {
    ...options,
    switchPath,
    force: true,
    binary: process.execPath,
    createLoginLease: () => {
      refreshLeaseCreated = true;
      return { nonce: "must-not-exist", release: async () => true };
    },
    spawnImpl: () => {
      throw new Error("refresh must not spawn during a profile switch");
    },
  });
  assert.equal(refreshed, false);
  assert.equal(refreshLeaseCreated, false);

  const ipcModule = await import("../apps/control-center/electron/ipc.mjs");
  let interactiveLeaseCreated = false;
  await assert.rejects(
    ipcModule.reserveChatGPTInteractiveLogin(first.id, {
      ...options,
      switchPath,
      createLoginLease: () => {
        interactiveLeaseCreated = true;
        return { nonce: "must-not-exist", release: async () => true };
      },
    }),
    /profile switch|reservation/i,
  );
  assert.equal(interactiveLeaseCreated, false);
});
