import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  refreshChatGPTSubscriptionAccount,
  removeChatGPTSubscriptionAccount,
} from "../src/chatgpt-account-pool.mjs";
import {
  createRequestUseLease,
  recoverRequestUseLeases,
  requestLeasePath,
} from "../src/chatgpt-request-use-lease.mjs";

const GENERATION = "abcdefghijklmnopqrstuv";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-request-use-lease-"));
  const options = {
    filePath: path.join(root, "pool.json"),
    homesDir: path.join(root, "accounts"),
    identity: () => "router-start-identity",
    identityProbe: () => ({ state: "alive", identity: "router-start-identity" }),
    requestExecutionTimeoutMs: 30_000,
    waitMs: 2_000,
    retryMs: 10,
  };
  const account = createChatGPTSubscriptionAccount(options);
  return { root, options, account, accountHome: path.join(options.homesDir, account.id) };
}

test("request lease creation writes the exact closed owner-bound record", async () => {
  const { options, account, accountHome } = fixture();
  const handle = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: GENERATION,
    requestStartedWallMs: 1_000,
    now: 2_000,
    ...options,
  });
  const leasePath = requestLeasePath(accountHome, handle.nonce);
  const record = JSON.parse(readFileSync(leasePath, "utf8"));
  assert.deepEqual(Object.keys(record).sort(), [
    "accountId",
    "affinityGeneration",
    "createdAt",
    "deadlineAt",
    "nonce",
    "pid",
    "startIdentity",
    "version",
  ]);
  assert.equal(record.accountId, account.id);
  assert.equal(record.pid, process.pid);
  assert.equal(record.startIdentity, "router-start-identity");
  assert.equal(record.affinityGeneration, GENERATION);
  assert.equal(record.createdAt, new Date(2_000).toISOString());
  assert.equal(record.deadlineAt, new Date(91_000).toISOString());
  if (process.platform !== "win32") {
    assert.equal(statSync(leasePath).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(leasePath)).mode & 0o777, 0o700);
  }
  assert.equal(await handle.release(), true);
  assert.equal(existsSync(leasePath), false);
});

test("concurrent request leases refcount while control-plane removal waits for zero", async () => {
  const { options, account } = fixture();
  const first = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: GENERATION,
    requestStartedWallMs: 1_000,
    now: 2_000,
    ...options,
  });
  const second = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: "1234567890abcdefghijkl",
    requestStartedWallMs: 1_001,
    now: 2_001,
    ...options,
  });
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(await first.release(), true);
  const removalOptions = {
    ...options,
    requestLeaseIdentityProbe: options.identityProbe,
  };
  assert.throws(
    () => removeChatGPTSubscriptionAccount(account.id, removalOptions),
    /active request|in use/i,
  );
  assert.ok(readChatGPTAccountPoolState(options.filePath).accounts[account.id]);
  assert.equal(await second.release(), true);
  const removed = removeChatGPTSubscriptionAccount(account.id, removalOptions);
  assert.equal(removed.id, account.id);
  assert.equal(readChatGPTAccountPoolState(options.filePath).accounts[account.id], undefined);
});

test("affinity generation is exactly 22 base64url characters", async () => {
  const { options, account } = fixture();
  for (const affinityGeneration of ["short", `${GENERATION}x`, "abcdefghijklmnopqrstu+"]) {
    await assert.rejects(
      createRequestUseLease({
        accountId: account.id,
        affinityGeneration,
        requestStartedWallMs: 1_000,
        now: 2_000,
        ...options,
      }),
      /affinity generation/i,
    );
  }
});

test("affinity generation rejects non-string values before writing a lease", async () => {
  const { options, account } = fixture();
  let writeStarted = false;
  await assert.rejects(
    createRequestUseLease({
      accountId: account.id,
      affinityGeneration: {
        toString: () => GENERATION,
        toJSON: () => GENERATION,
      },
      requestStartedWallMs: 1_000,
      now: 2_000,
      ...options,
      afterLeaseWriteBeforeVerify() {
        writeStarted = true;
      },
    }),
    /affinity generation/i,
  );
  assert.equal(writeStarted, false);
});

test("proven-dead and PID-reused owners recover immediately before the deadline", async () => {
  for (const probe of [
    { state: "absent" },
    { state: "alive", identity: "replacement-process" },
  ]) {
    const { options, account, accountHome } = fixture();
    const handle = await createRequestUseLease({
      accountId: account.id,
      affinityGeneration: GENERATION,
      requestStartedWallMs: 1_000,
      now: 2_000,
      ...options,
    });
    const result = recoverRequestUseLeases(account.id, {
      homesDir: options.homesDir,
      now: 3_000,
      identityProbe: () => probe,
    });
    assert.deepEqual(result, { cleared: 1, blocked: 0 });
    assert.equal(existsSync(requestLeasePath(accountHome, handle.nonce)), false);
  }
});

test("live and unknown owners remain blocked after the wall-clock deadline", async () => {
  for (const probe of [
    { state: "alive", identity: "router-start-identity" },
    { state: "unknown" },
  ]) {
    const { options, account, accountHome } = fixture();
    const handle = await createRequestUseLease({
      accountId: account.id,
      affinityGeneration: GENERATION,
      requestStartedWallMs: 1_000,
      now: 2_000,
      ...options,
    });
    const result = recoverRequestUseLeases(account.id, {
      homesDir: options.homesDir,
      now: 200_000,
      identityProbe: () => probe,
    });
    assert.deepEqual(result, { cleared: 0, blocked: 1 });
    assert.equal(existsSync(requestLeasePath(accountHome, handle.nonce)), true);
    assert.equal(await handle.release(), true);
  }
});

test("an old release cannot ABA-unlink a replacement at the reusable lease path", async () => {
  const { options, account, accountHome } = fixture();
  const old = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: GENERATION,
    requestStartedWallMs: 1_000,
    now: 2_000,
    ...options,
  });
  const leasePath = requestLeasePath(accountHome, old.nonce);
  const displaced = path.join(accountHome, "displaced-old-request-lease.json");
  renameSync(leasePath, displaced);
  writeFileSync(leasePath, JSON.stringify({
    ...old.record,
    pid: 9898,
    startIdentity: "replacement-owner",
  }), { mode: 0o600 });
  chmodSync(leasePath, 0o600);
  assert.equal(await old.release(), false);
  const tombstoneDir = path.join(accountHome, "router-request-leases", ".tombstones");
  assert.equal(existsSync(leasePath), false);
  assert.equal(readdirSync(tombstoneDir).length, 1);
  const replacement = JSON.parse(readFileSync(path.join(tombstoneDir, readdirSync(tombstoneDir)[0]), "utf8"));
  assert.equal(replacement.pid, 9898);
  assert.equal(existsSync(displaced), true);
});

test("recovery preserves and counts a replacement that appears at relocation", async () => {
  const { options, account, accountHome } = fixture();
  const old = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: GENERATION,
    requestStartedWallMs: 1_000,
    now: 2_000,
    ...options,
  });
  const leasePath = requestLeasePath(accountHome, old.nonce);
  const replacement = {
    ...old.record,
    pid: 8787,
    startIdentity: "replacement-owner",
  };
  const result = recoverRequestUseLeases(account.id, {
    ...options,
    identityProbe: () => ({ state: "absent" }),
    beforeRecoverRelocate() {
      renameSync(leasePath, `${leasePath}.displaced`);
      writeFileSync(leasePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      chmodSync(leasePath, 0o600);
    },
  });
  assert.deepEqual(result, { cleared: 0, blocked: 1 });
  assert.deepEqual(JSON.parse(readFileSync(leasePath, "utf8")), replacement);
});

test("creation cleanup never unlinks a pathname replacement", async () => {
  const { options, account } = fixture();
  let replacementPath;
  await assert.rejects(
    createRequestUseLease({
      accountId: account.id,
      affinityGeneration: GENERATION,
      requestStartedWallMs: 1_000,
      now: 2_000,
      ...options,
      afterLeaseWriteBeforeVerify({ leasePath, record }) {
        replacementPath = leasePath;
        renameSync(leasePath, `${leasePath}.original`);
        writeFileSync(leasePath, `${JSON.stringify({ ...record, pid: 7676 })}\n`, { mode: 0o600 });
        chmodSync(leasePath, 0o600);
      },
    }),
    /identity|replacement|lease/i,
  );
  assert.equal(existsSync(replacementPath), true);
  assert.equal(JSON.parse(readFileSync(replacementPath, "utf8")).pid, 7676);
});

test("descriptor protection is revalidated after opening a lease", async () => {
  if (process.platform === "win32") return;
  const { options, account } = fixture();
  const handle = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: GENERATION,
    requestStartedWallMs: 1_000,
    now: 2_000,
    ...options,
  });
  assert.throws(
    () => recoverRequestUseLeases(account.id, {
      ...options,
      afterLeaseOpen({ descriptor }) {
        chmodSync(`/dev/fd/${descriptor}`, 0o644);
      },
    }),
    /owner-only|mode|private/i,
  );
});

test("lease filename nonce must equal the closed record nonce", async () => {
  const { options, account, accountHome } = fixture();
  const handle = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: GENERATION,
    requestStartedWallMs: 1_000,
    now: 2_000,
    ...options,
  });
  const mismatched = "11111111-1111-4111-8111-111111111111";
  renameSync(
    requestLeasePath(accountHome, handle.nonce),
    requestLeasePath(accountHome, mismatched),
  );
  assert.throws(
    () => recoverRequestUseLeases(account.id, options),
    /filename nonce|nonce.*match/i,
  );
});

test("request lease recovery rejects symlinked lease directories and non-private records", async () => {
  {
    const { root, options, account, accountHome } = fixture();
    const outside = path.join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, path.join(accountHome, "router-request-leases"));
    assert.throws(
      () => recoverRequestUseLeases(account.id, options),
      /symbolic|private directory/i,
    );
  }
  {
    const { options, account, accountHome } = fixture();
    const handle = await createRequestUseLease({
      accountId: account.id,
      affinityGeneration: GENERATION,
      requestStartedWallMs: 1_000,
      now: 2_000,
      ...options,
    });
    chmodSync(requestLeasePath(accountHome, handle.nonce), 0o644);
    assert.throws(
      () => recoverRequestUseLeases(account.id, options),
      /owner-only|private/i,
    );
  }
});

test("background refresh checks request exclusion before claiming or spawning", async () => {
  const { options, account } = fixture();
  const lease = await createRequestUseLease({
    accountId: account.id,
    affinityGeneration: GENERATION,
    requestStartedWallMs: Date.now(),
    ...options,
  });
  let spawned = false;
  try {
    const refreshed = await refreshChatGPTSubscriptionAccount(account.id, {
      filePath: options.filePath,
      homesDir: options.homesDir,
      force: true,
      binary: process.execPath,
      requestLeaseIdentityProbe: options.identityProbe,
      spawnImpl: () => {
        spawned = true;
        throw new Error("refresh must not spawn while a request owns the account");
      },
    });
    assert.equal(refreshed, false);
    assert.equal(spawned, false);
    assert.equal(
      readChatGPTAccountPoolState(options.filePath).accounts[account.id].health.lastRefreshAttemptAt,
      undefined,
    );
  } finally {
    assert.equal(await lease.release(), true);
  }
});
