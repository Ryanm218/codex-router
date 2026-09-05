import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { ensureNoSymlinkParents } from "./path-security.mjs";
import { CHATGPT_ACCOUNT_HOMES_DIR } from "./paths.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function normalizedAccountId(value) {
  const id = String(value || "").trim();
  if (!ACCOUNT_ID.test(id)) throw new Error("Account id is invalid.");
  return id;
}

function positiveInteger(value, fallback, minimum = 1) {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

function assertPrivateDirectory(target, label) {
  ensureNoSymlinkParents(target, { label });
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a private directory.`);
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o777) !== 0o700) throw new Error(`${label} is not owner-only.`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`${label} is not owned by the current user.`);
    }
  }
  return stat;
}

function validateLockDescriptor(lockPath, label) {
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_DIRECTORY || 0)
    | (fsConstants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = openSync(lockPath, flags);
  } catch (error) {
    throw new Error(`${label} could not be opened without following a symbolic link.`, { cause: error });
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) throw new Error(`${label} is not a private directory.`);
    if (process.platform !== "win32") {
      fchmodSync(descriptor, 0o700);
      const protectedStat = fstatSync(descriptor);
      if ((protectedStat.mode & 0o777) !== 0o700) throw new Error(`${label} is not owner-only.`);
      if (typeof process.getuid === "function" && protectedStat.uid !== process.getuid()) {
        throw new Error(`${label} is not owned by the current user.`);
      }
    }
    const pathname = lstatSync(lockPath);
    if (pathname.isSymbolicLink() || !pathname.isDirectory()
      || pathname.dev !== opened.dev || pathname.ino !== opened.ino) {
      throw new Error(`${label} pathname identity changed during validation.`);
    }
    return pathname;
  } finally {
    closeSync(descriptor);
  }
}

function verifiedAccountHome(value, {
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  accountHome,
} = {}) {
  const id = normalizedAccountId(value);
  const root = path.resolve(homesDir);
  const home = path.resolve(accountHome || path.join(root, id));
  if (path.basename(home) !== id || path.dirname(home) !== root) {
    throw new Error("The ChatGPT account operation lock escaped its account home.");
  }
  const rootStat = assertPrivateDirectory(root, "The ChatGPT account operation lock root");
  const homeStat = assertPrivateDirectory(home, "The ChatGPT account operation lock account home");
  const realRoot = realpathSync(root);
  const realHome = realpathSync(home);
  if (path.dirname(realHome) !== realRoot) {
    throw new Error("The ChatGPT account operation lock account home is not owned by its root.");
  }
  assertPrivateDirectory(home, "The ChatGPT account operation lock account home");
  if (realpathSync(root) !== realRoot || realpathSync(home) !== realHome) {
    throw new Error("The ChatGPT account operation lock account home changed during validation.");
  }
  return { id, home, root, rootStat, homeStat, realRoot, realHome };
}

function assertHomeIdentity(expected, options) {
  const current = verifiedAccountHome(expected.id, options);
  if (current.rootStat.dev !== expected.rootStat.dev
    || current.rootStat.ino !== expected.rootStat.ino
    || current.homeStat.dev !== expected.homeStat.dev
    || current.homeStat.ino !== expected.homeStat.ino
    || current.realRoot !== expected.realRoot
    || current.realHome !== expected.realHome) {
    throw new Error("The ChatGPT account operation lock path identity changed during acquisition.");
  }
}

export function chatGPTAccountOperationLockPath(value, options = {}) {
  return path.join(verifiedAccountHome(value, options).home, "router-account.lock");
}

export async function withChatGPTAccountOperationLock(value, operation, options = {}) {
  if (typeof operation !== "function") throw new TypeError("Account lock operation must be a function.");
  const verified = verifiedAccountHome(value, options);
  const { id, home } = verified;
  const lockPath = path.join(home, "router-account.lock");
  const waitMs = positiveInteger(options.waitMs, DEFAULT_WAIT_MS, 0);
  const retryMs = positiveInteger(options.retryMs, DEFAULT_RETRY_MS);
  const staleMs = positiveInteger(options.staleMs, DEFAULT_STALE_MS, 2_000);
  const heartbeatMs = Math.min(
    positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, 1_000),
    staleMs / 2,
  );
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  let release;
  try {
    release = await lockfile.lock(home, {
      realpath: false,
      lockfilePath: lockPath,
      stale: staleMs,
      update: heartbeatMs,
      retries: {
        retries,
        factor: 1,
        minTimeout: retryMs,
        maxTimeout: retryMs,
        randomize: false,
      },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") {
      const locked = new Error("The ChatGPT account is busy with another protected operation.", { cause: error });
      locked.code = "chatgpt_account_locked";
      throw locked;
    }
    throw error;
  }
  try {
    options.beforeValidateLock?.(id, lockPath);
    assertHomeIdentity(verified, options);
    validateLockDescriptor(lockPath, "The ChatGPT account operation lock");
    assertHomeIdentity(verified, options);
    options.onAcquired?.(id, lockPath);
    return await operation();
  } finally {
    if (release) await release().catch(() => {});
  }
}

export function withChatGPTAccountOperationLockSync(value, operation, options = {}) {
  if (typeof operation !== "function") throw new TypeError("Account lock operation must be a function.");
  const verified = verifiedAccountHome(value, options);
  const { id, home } = verified;
  const lockPath = path.join(home, "router-account.lock");
  let release;
  try {
    release = lockfile.lockSync(home, {
      realpath: false,
      lockfilePath: lockPath,
      stale: positiveInteger(options.staleMs, DEFAULT_STALE_MS, 2_000),
      update: false,
      retries: 0,
    });
  } catch (error) {
    if (error?.code === "ELOCKED") {
      const locked = new Error("The ChatGPT account is busy with another protected operation.", { cause: error });
      locked.code = "chatgpt_account_locked";
      throw locked;
    }
    throw error;
  }
  try {
    options.beforeValidateLock?.(id, lockPath);
    assertHomeIdentity(verified, options);
    validateLockDescriptor(lockPath, "The ChatGPT account operation lock");
    assertHomeIdentity(verified, options);
    options.onAcquired?.(id, lockPath);
    return operation();
  } finally {
    if (release) {
      try { release(); } catch {}
    }
  }
}

export async function withOrderedChatGPTLocks(accountIds, operation, options = {}) {
  if (!Array.isArray(accountIds)) throw new TypeError("Account ids must be an array.");
  if (typeof operation !== "function") throw new TypeError("Account lock operation must be a function.");
  const ordered = [...new Set(accountIds.map(normalizedAccountId))].sort();
  const acquire = async (index) => {
    if (index >= ordered.length) return operation();
    return withChatGPTAccountOperationLock(
      ordered[index],
      () => acquire(index + 1),
      options,
    );
  };
  return acquire(0);
}
