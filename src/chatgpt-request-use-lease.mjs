import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { privateFileIsProtected } from "./file-security.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";
import { processStartIdentity, processStartIdentityProbe } from "./process-identity.mjs";
import {
  CHATGPT_ACCOUNT_HOMES_DIR,
  CHATGPT_ACCOUNT_POOL_PATH,
  CHATGPT_PROFILE_SWITCH_PATH,
} from "./paths.mjs";
import { withChatGPTAccountOperationLock } from "./chatgpt-account-operation-lock.mjs";
import {
  readChatGPTAccountPoolState,
  withChatGPTAccountPoolLock,
} from "./chatgpt-account-pool.mjs";
import { assertChatGPTLoginLeaseInactive } from "./chatgpt-login-lease.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION = /^[A-Za-z0-9_-]{22}$/;
const LEASE_VERSION = 1;
const LEASE_DIRECTORY = "router-request-leases";
const TOMBSTONE_DIRECTORY = ".tombstones";
const MAX_RECORDS = 256;
const MAX_RECORD_BYTES = 16 * 1024;
const REQUEST_CLEANUP_GRACE_MS = 60_000;
const DEFAULT_REQUEST_EXECUTION_TIMEOUT_MS = 24 * 60 * 60_000;
const LEASE_KEYS = new Set([
  "version",
  "accountId",
  "pid",
  "startIdentity",
  "nonce",
  "affinityGeneration",
  "createdAt",
  "deadlineAt",
]);

function accountId(value) {
  const id = String(value || "").trim();
  if (!ACCOUNT_ID.test(id)) throw new Error("Account id is invalid.");
  return id;
}

function canonicalIso(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function assertPrivateDirectory(target, label) {
  ensureNoSymlinkParents(target, { label });
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a private directory.`);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o777) !== 0o700) throw new Error(`${label} is not owner-only.`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`${label} is not owned by the current user.`);
    }
  }
  return stat;
}

function verifiedAccountHome(value, {
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  accountHome,
} = {}) {
  const id = accountId(value);
  const root = path.resolve(homesDir);
  const home = path.resolve(accountHome || path.join(root, id));
  if (path.basename(home) !== id || path.dirname(home) !== root) {
    throw new Error("The ChatGPT request-use lease escaped its account home.");
  }
  assertPrivateDirectory(root, "The ChatGPT request-use lease root");
  assertPrivateDirectory(home, "The ChatGPT request-use lease account home");
  const realRoot = realpathSync(root);
  const realHome = realpathSync(home);
  if (path.dirname(realHome) !== realRoot) {
    throw new Error("The ChatGPT request-use lease account home is not owned by its root.");
  }
  assertPrivateDirectory(home, "The ChatGPT request-use lease account home");
  if (realpathSync(root) !== realRoot || realpathSync(home) !== realHome) {
    throw new Error("The ChatGPT request-use lease account home changed during validation.");
  }
  return { id, home };
}

function ensurePrivateLeaseDirectory(home, { create = false } = {}) {
  const directory = path.join(home, LEASE_DIRECTORY);
  if (!existsSync(directory)) {
    if (!create) return undefined;
    ensureNoSymlinkParents(home, { label: "ChatGPT request-use lease account home" });
    mkdirSync(directory, { mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
  }
  assertPrivateDirectory(directory, "The ChatGPT request-use lease directory");
  if (path.dirname(realpathSync(directory)) !== realpathSync(home)) {
    throw new Error("The ChatGPT request-use lease directory escaped its account home.");
  }
  return directory;
}

function ensurePrivateTombstoneDirectory(leaseDirectory, { create = false } = {}) {
  const directory = path.join(leaseDirectory, TOMBSTONE_DIRECTORY);
  if (!existsSync(directory)) {
    if (!create) return undefined;
    ensureNoSymlinkParents(leaseDirectory, { label: "ChatGPT request-use lease directory" });
    mkdirSync(directory, { mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
  }
  assertPrivateDirectory(directory, "The ChatGPT request-use lease tombstone directory");
  if (path.dirname(realpathSync(directory)) !== realpathSync(leaseDirectory)) {
    throw new Error("The ChatGPT request-use lease tombstone directory escaped its lease directory.");
  }
  return directory;
}

export function requestLeasePath(accountHome, nonce) {
  if (!path.isAbsolute(accountHome)) throw new Error("The ChatGPT request-use lease home must be absolute.");
  if (!NONCE.test(String(nonce || ""))) throw new Error("The ChatGPT request-use lease nonce is invalid.");
  return path.join(accountHome, LEASE_DIRECTORY, `${nonce}.json`);
}

function validateLease(value, expectedAccountId) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== LEASE_KEYS.size
    || !Object.keys(value).every((key) => LEASE_KEYS.has(key))
    || value.version !== LEASE_VERSION
    || value.accountId !== expectedAccountId
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.startIdentity !== "string"
    || value.startIdentity.length < 1
    || value.startIdentity.length > 2_048
    || !NONCE.test(value.nonce)
    || typeof value.affinityGeneration !== "string"
    || !GENERATION.test(value.affinityGeneration)
    || !canonicalIso(value.createdAt)
    || !canonicalIso(value.deadlineAt)
    || Date.parse(value.deadlineAt) < Date.parse(value.createdAt)
  ) {
    throw new Error("The ChatGPT request-use lease is invalid.");
  }
  return value;
}

function assertProtectedDescriptor(stat, label) {
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) {
    throw new Error(`${label} is not a bounded private file.`);
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} is not owner-only.`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`${label} is not owned by the current user.`);
    }
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(
    directory,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readLeaseAt(leasePath, expectedAccountId, options = {}) {
  ensureNoSymlinkParents(path.dirname(leasePath), { label: "ChatGPT request-use lease directory" });
  const before = lstatSync(leasePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_RECORD_BYTES) {
    throw new Error("The ChatGPT request-use lease is not a bounded private file.");
  }
  if (!privateFileIsProtected(leasePath)) {
    throw new Error("The ChatGPT request-use lease is not owner-only.");
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const descriptor = openSync(leasePath, flags);
  try {
    const opened = fstatSync(descriptor);
    assertProtectedDescriptor(opened, "The ChatGPT request-use lease");
    if (!sameFile(before, opened) || opened.size !== before.size) {
      throw new Error("The ChatGPT request-use lease changed while it was opened.");
    }
    options.afterLeaseOpen?.({ descriptor, leasePath });
    let parsed;
    try {
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, total);
        if (count === 0) break;
        total += count;
      }
      if (total > MAX_RECORD_BYTES || total !== opened.size) {
        throw new Error("The ChatGPT request-use lease changed while it was read.");
      }
      parsed = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    } catch (error) {
      throw new Error("The ChatGPT request-use lease could not be read.", { cause: error });
    }
    const after = fstatSync(descriptor);
    assertProtectedDescriptor(after, "The ChatGPT request-use lease");
    const pathname = lstatSync(leasePath);
    if (!sameFile(opened, after) || after.size !== opened.size || !sameFile(after, pathname)) {
      throw new Error("The ChatGPT request-use lease changed while it was read.");
    }
    return { lease: validateLease(parsed, expectedAccountId), stat: opened };
  } finally {
    closeSync(descriptor);
  }
}

function leaseRecords(value, options = {}) {
  const { id, home } = verifiedAccountHome(value, options);
  const leaseDirectory = ensurePrivateLeaseDirectory(home);
  if (!leaseDirectory) return [];
  const tombstoneDirectory = ensurePrivateTombstoneDirectory(leaseDirectory);
  const entries = [];
  for (const [directory, tombstone] of [
    [leaseDirectory, false],
    ...(tombstoneDirectory ? [[tombstoneDirectory, true]] : []),
  ]) {
    for (const name of readdirSync(directory)) {
      if (!tombstone && name === TOMBSTONE_DIRECTORY) continue;
      const match = tombstone
        ? /^([0-9a-f-]{36})\.relocated-[0-9a-f-]{36}\.json$/i.exec(name)
        : /^([0-9a-f-]{36})\.json$/i.exec(name);
      if (!match || !NONCE.test(match[1])) {
        throw new Error("The ChatGPT request-use lease directory contains an unexpected artifact.");
      }
      entries.push({ leasePath: path.join(directory, name), tombstone, filenameNonce: match[1] });
    }
  }
  if (entries.length > MAX_RECORDS) throw new Error("Too many ChatGPT request-use lease records were found.");
  return entries.map((entry) => {
    const read = readLeaseAt(entry.leasePath, id, options);
    if (read.lease.nonce !== entry.filenameNonce) {
      throw new Error("The ChatGPT request-use lease filename nonce does not match its record nonce.");
    }
    return { ...entry, ...read };
  });
}

function sameLease(left, right) {
  return Boolean(left && right && [...LEASE_KEYS].every((key) => left[key] === right[key]));
}

function relocateRecord(record, home, expected, { restoreMismatch = false } = {}) {
  const leaseDirectory = ensurePrivateLeaseDirectory(home, { create: true });
  const tombstoneDirectory = ensurePrivateTombstoneDirectory(leaseDirectory, { create: true });
  const relocated = path.join(
    tombstoneDirectory,
    `${expected.lease.nonce}.relocated-${randomUUID()}.json`,
  );
  try {
    renameSync(record.leasePath, relocated);
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  const moved = readLeaseAt(relocated, expected.lease.accountId);
  if (!sameFile(moved.stat, expected.stat) || !sameLease(moved.lease, expected.lease)) {
    if (restoreMismatch) {
      try {
        linkSync(relocated, record.leasePath);
        unlinkSync(relocated);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    return "mismatch";
  }
  unlinkSync(relocated);
  return "cleared";
}

function observedOwner(lease, options = {}) {
  if (typeof options.identityProbe === "function") return options.identityProbe(lease.pid);
  if (typeof options.identity === "function" && options.identity !== processStartIdentity) {
    const identity = options.identity(lease.pid);
    return typeof identity === "string" && identity
      ? { state: "alive", identity }
      : { state: "unknown" };
  }
  return processStartIdentityProbe(lease.pid);
}

export function recoverRequestUseLeases(value, options = {}) {
  const { home } = verifiedAccountHome(value, options);
  let cleared = 0;
  let blocked = 0;
  for (const record of leaseRecords(value, options)) {
    const observed = observedOwner(record.lease, options);
    const dead = observed?.state === "absent"
      || (observed?.state === "alive" && observed.identity !== record.lease.startIdentity);
    if (!dead) {
      blocked += 1;
      continue;
    }
    options.beforeRecoverRelocate?.(record);
    const relocated = relocateRecord(record, home, record, { restoreMismatch: true });
    if (relocated === "cleared") cleared += 1;
    else blocked += 1;
  }
  return { cleared, blocked };
}

export function assertNoActiveRequestUseLeases(value, options = {}) {
  const result = recoverRequestUseLeases(value, options);
  if (result.blocked > 0) {
    const error = new Error("The ChatGPT account is in use by an active request.");
    error.code = "chatgpt_account_request_in_use";
    throw error;
  }
  return result;
}

function configuredRequestExecutionTimeout(value) {
  const configured = Number(
    value
    ?? process.env.MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS
    ?? process.env.CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS
    ?? DEFAULT_REQUEST_EXECUTION_TIMEOUT_MS,
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_REQUEST_EXECUTION_TIMEOUT_MS;
}

export function assertNoChatGPTProfileSwitchReservation(options = {}) {
  const switchPath = path.resolve(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH);
  const transactionDirectory = path.join(path.dirname(switchPath), "chatgpt-profile", "switch-transaction");
  if (!existsSync(transactionDirectory)) return;
  assertPrivateDirectory(transactionDirectory, "The ChatGPT profile switch reservation");
  const error = new Error("A durable ChatGPT profile switch reservation is active.");
  error.code = "chatgpt_profile_switch_reserved";
  throw error;
}

function cleanupPartialLeasePath(leasePath, home, createdIdentity) {
  if (!createdIdentity) return;
  const tombstone = path.join(home, `.request-lease-cleanup-${randomUUID()}.tmp`);
  try {
    renameSync(leasePath, tombstone);
    const moved = lstatSync(tombstone);
    if (!moved.isSymbolicLink() && sameFile(moved, createdIdentity.stat)) {
      unlinkSync(tombstone);
      return;
    }
    try { if (!existsSync(leasePath)) renameSync(tombstone, leasePath); } catch {}
  } catch {}
}

function writeLease(value, options = {}) {
  const { id, home } = verifiedAccountHome(value.accountId, options);
  const leaseDirectory = ensurePrivateLeaseDirectory(home, { create: true });
  const nonce = randomUUID();
  const leasePath = requestLeasePath(home, nonce);
  const pid = options.pid ?? process.pid;
  const identity = options.identity || processStartIdentity;
  const startIdentity = identity(pid);
  const createdWallMs = Number.isFinite(options.now) ? options.now : Date.now();
  const requestStartedWallMs = Number(value.requestStartedWallMs);
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof startIdentity !== "string" || !startIdentity) {
    throw new Error("The request owner process identity is unavailable.");
  }
  if (typeof value.affinityGeneration !== "string" || !GENERATION.test(value.affinityGeneration)) {
    throw new Error("The affinity generation is invalid.");
  }
  if (!Number.isFinite(requestStartedWallMs) || requestStartedWallMs < 0) {
    throw new Error("The request start time is invalid.");
  }
  const lease = {
    version: LEASE_VERSION,
    accountId: id,
    pid,
    startIdentity,
    nonce,
    affinityGeneration: value.affinityGeneration,
    createdAt: new Date(createdWallMs).toISOString(),
    deadlineAt: new Date(
      requestStartedWallMs
      + configuredRequestExecutionTimeout(options.requestExecutionTimeoutMs)
      + REQUEST_CLEANUP_GRACE_MS,
    ).toISOString(),
  };
  validateLease(lease, id);
  let descriptor;
  let created = false;
  let createdIdentity;
  try {
    descriptor = openSync(
      leasePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    created = true;
    const openedStat = fstatSync(descriptor);
    createdIdentity = { lease, stat: openedStat };
    const bytes = Buffer.from(`${JSON.stringify(lease)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const createdStat = fstatSync(descriptor);
    if (!sameFile(createdStat, openedStat)) throw new Error("The ChatGPT request-use lease inode changed during creation.");
    assertProtectedDescriptor(createdStat, "The ChatGPT request-use lease");
    closeSync(descriptor);
    descriptor = undefined;
    createdIdentity = { lease, stat: createdStat };
    options.afterLeaseWriteBeforeVerify?.({ leasePath, record: { ...lease } });
    const expected = readLeaseAt(leasePath, id, options);
    if (!sameFile(expected.stat, createdStat) || !sameLease(expected.lease, lease)) {
      throw new Error("The ChatGPT request-use lease pathname was replaced during creation.");
    }
    fsyncDirectory(leaseDirectory);
    return {
      ...lease,
      record: { ...lease },
      path: leasePath,
      release: async (releaseOptions = {}) => withChatGPTAccountPoolLock(
        () => withChatGPTAccountOperationLock(id, () => {
          const records = leaseRecords(id, options);
          const matching = records.find((record) => (
            sameFile(record.stat, expected.stat) && sameLease(record.lease, expected.lease)
          ));
          if (!matching) {
            const reusable = records.find((record) => record.leasePath === leasePath);
            if (reusable) {
              releaseOptions.beforeRelocate?.(reusable.lease);
              relocateRecord(reusable, home, expected);
            }
            return false;
          }
          releaseOptions.beforeRelocate?.(matching.lease);
          return relocateRecord(matching, home, expected) === "cleared";
        }, options),
        { filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH },
      ),
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    if (created) {
      try {
        const current = readLeaseAt(leasePath, id);
        if (createdIdentity
          && sameFile(current.stat, createdIdentity.stat)
          && sameLease(current.lease, createdIdentity.lease)) {
          relocateRecord({ leasePath }, home, createdIdentity);
        }
      } catch {}
      cleanupPartialLeasePath(leasePath, home, createdIdentity);
    }
    throw error;
  }
}

export async function createRequestUseLease({
  accountId: value,
  affinityGeneration,
  requestStartedWallMs,
  ...options
}) {
  const id = accountId(value);
  return withChatGPTAccountPoolLock(
    () => withChatGPTAccountOperationLock(id, () => {
      const state = readChatGPTAccountPoolState(options.filePath || CHATGPT_ACCOUNT_POOL_PATH);
      const account = state.accounts[id];
      if (!account || account.state !== "active" || account.paused) {
        throw new Error("The subscription account is not active.");
      }
      assertNoChatGPTProfileSwitchReservation(options);
      // Request-use leases are a refcount, not a mutex. Recover any proven
      // dead/PID-reused records while allowing existing live requests to
      // coexist; only control-plane/auth writers require the count to be zero.
      recoverRequestUseLeases(id, options);
      assertChatGPTLoginLeaseInactive(id, {
        homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
        ...(options.accountHome ? { accountHome: options.accountHome } : {}),
        ...(options.loginLeaseIdentity ? { identity: options.loginLeaseIdentity } : {}),
        ...(options.loginLeaseIdentityProbe || options.identityProbe
          ? { identityProbe: options.loginLeaseIdentityProbe || options.identityProbe }
          : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
        message: "Cannot use a ChatGPT account while its browser sign-in is in progress.",
      });
      return writeLease({
        accountId: id,
        affinityGeneration,
        requestStartedWallMs,
      }, options);
    }, options),
    {
      filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH,
      ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
      ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
      ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
    },
  );
}
