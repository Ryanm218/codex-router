import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { privateFileIsProtected, protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import {
  assertChatGPTLoginLeaseInactive,
  chatGPTLoginAuthChanged,
  chatGPTLoginLeaseCompletionCandidate,
  chatGPTLoginLeaseMatches,
  chatGPTLoginLeaseStatus,
  clearChatGPTLoginLease,
} from "./chatgpt-login-lease.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { withOrderedChatGPTLocks } from "./chatgpt-account-operation-lock.mjs";
import { assertNoActiveRequestUseLeases } from "./chatgpt-request-use-lease.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { processStartIdentity, processStartIdentityProbe } from "./process-identity.mjs";
import {
  CHATGPT_ACCOUNT_HOMES_DIR,
  CHATGPT_ACCOUNT_POOL_PATH,
  CHATGPT_PROFILE_SWITCH_PATH,
  CODEX_HOME,
  MERGED_CATALOG_PATH,
  MODELS_CACHE_PATH,
  NATIVE_ALIAS_PATH,
  NATIVE_CATALOG_PATH,
  ANNOUNCED_MODELS_PATH,
} from "./paths.mjs";
import {
  chatGPTSubscriptionAccountCatalogDir,
  createChatGPTSubscriptionAccount,
  chatGPTSubscriptionAccountHome,
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountStatus,
  hardenChatGPTSubscriptionAccountAuth,
  isChatGPTAccountId,
  readChatGPTAccountPoolState,
  removeChatGPTSubscriptionAccountLocked,
  sanitizeChatGPTAccountPool,
  writeChatGPTAccountPoolState,
  withChatGPTAccountPoolLock,
} from "./chatgpt-account-pool.mjs";

const VERSION = 1;
const TRANSACTION_VERSION = 2;
const LEGACY_PRIMARY = "primary";
const AUTO = "auto";
const CATALOG_ARTIFACTS = Object.freeze([
  ["models_cache.json", "modelsCachePath"],
  ["native-models.json", "nativeCatalogPath"],
  ["merged-models.json", "mergedCatalogPath"],
  ["native-aliases.json", "nativeAliasPath"],
  ["announced-models.json", "announcedModelsPath"],
]);

function assertProfileDiscoveryEnabled() {
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
}

function catalogLockOptions(options = {}) {
  return {
    stateDir: options.catalogLockStateDir
      || path.dirname(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH),
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
  };
}

function withProfileCatalogLock(operation, options = {}) {
  const withLock = options.withProfileCatalogLock || withCatalogPublicationLock;
  return withLock(operation, catalogLockOptions(options));
}

function accountOperationLockOptions(options = {}) {
  return {
    homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
  };
}

function withProfileAccountLocks(operation, options = {}, extraAccountIds = []) {
  const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
  const state = readChatGPTAccountPoolState(filePath);
  const accountIds = [...Object.keys(state.accounts), ...extraAccountIds]
    .filter((id) => isChatGPTAccountId(id));
  return withOrderedChatGPTLocks(accountIds, () => {
    for (const id of [...new Set(accountIds)]) {
      assertNoActiveRequestUseLeases(id, {
        homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
        ...(options.requestLeaseIdentityProbe
          ? { identityProbe: options.requestLeaseIdentityProbe }
          : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }
    return operation();
  }, accountOperationLockOptions(options));
}

function withProfileMutationLocks(operation, options = {}, extraAccountIds = [], resume = false) {
  return withProfileAccountLocks(
    () => {
      if (!resume) assertNoLiveSwitchWriter(options);
      return withProfileCatalogLock(operation, options);
    },
    options,
    extraAccountIds,
  );
}

function assertNoLiveSwitchWriter(options = {}) {
  const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
  const state = readChatGPTProfileSwitchState(switchPath);
  if (state.phase === "idle") return;
  const transaction = readSwitchTransaction(switchPath);
  if (!transaction?.writerPid) return;
  const probe = options.profileWriterIdentityProbe || processStartIdentityProbe;
  const observed = probe(transaction.writerPid);
  if (observed?.state === "unknown"
    || (observed?.state === "alive" && observed.identity === transaction.writerStartIdentity)) {
    const error = new Error("A live durable ChatGPT profile switch writer reservation is active.");
    error.code = "chatgpt_profile_switch_reserved";
    throw error;
  }
}

function transactionDirectory(switchPath = CHATGPT_PROFILE_SWITCH_PATH) {
  return path.join(path.dirname(switchPath), "chatgpt-profile", "switch-transaction");
}

function transactionStagingDirectory(switchPath = CHATGPT_PROFILE_SWITCH_PATH) {
  return `${transactionDirectory(switchPath)}.staging`;
}

function transactionManifestPath(switchPath) {
  return path.join(transactionDirectory(switchPath), "manifest.json");
}

function transactionAuthPath(switchPath) {
  return path.join(transactionDirectory(switchPath), "primary-auth.json");
}

function validateTransactionDirectory(directory, { allowManifest = true } = {}) {
  ensureNoSymlinkParents(directory);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The ChatGPT profile switch transaction is not a private directory.");
  }
  const allowed = new Set(["primary-auth.json", ...(allowManifest ? ["manifest.json"] : [])]);
  for (const name of readdirSync(directory)) {
    if (!allowed.has(name)) {
      throw new Error("The ChatGPT profile switch transaction contains an unexpected artifact.");
    }
    const entry = lstatSync(path.join(directory, name));
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("The ChatGPT profile switch transaction artifact is invalid.");
    }
    if (!privateFileIsProtected(path.join(directory, name))) {
      throw new Error("The ChatGPT profile switch transaction artifact is not private.");
    }
  }
}

function removeStagedSwitchTransaction(switchPath) {
  const staging = transactionStagingDirectory(switchPath);
  if (!existsSync(staging)) return;
  removeValidatedTransactionDirectory(staging);
}

function removeValidatedTransactionDirectory(directory) {
  validateTransactionDirectory(directory);
  for (const name of ["manifest.json", "primary-auth.json"]) {
    const target = path.join(directory, name);
    if (!existsSync(target)) continue;
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile() || !privateFileIsProtected(target)) {
      throw new Error("The ChatGPT profile switch transaction artifact changed during cleanup.");
    }
    rmSync(target);
  }
  // Non-recursive removal is deliberate. An artifact inserted after the
  // validation above makes cleanup fail closed instead of being erased.
  rmdirSync(directory);
}

function catalogPaths(options = {}) {
  return {
    modelsCachePath: options.modelsCachePath || MODELS_CACHE_PATH,
    nativeCatalogPath: options.nativeCatalogPath || NATIVE_CATALOG_PATH,
    mergedCatalogPath: options.mergedCatalogPath || MERGED_CATALOG_PATH,
    nativeAliasPath: options.nativeAliasPath || NATIVE_ALIAS_PATH,
    announcedModelsPath: options.announcedModelsPath || ANNOUNCED_MODELS_PATH,
  };
}

function catalogHandlingEnabled(options = {}) {
  return options.refreshCatalog !== false || CATALOG_ARTIFACTS.some(([, key]) => options[key]);
}

function atomicContents(target, contents) {
  const parent = path.dirname(target);
  ensureNoSymlinkParents(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(parent);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    ensureNoSymlinkParents(parent);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error("Refusing to replace a symbolic-link catalog artifact.");
    }
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function ensureNoSymlinkParents(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (!isAllowedSystemTempLink(current)) {
        throw new Error(`Refusing to traverse a symbolic-link path: ${current}`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Profile path component is not a directory: ${current}`);
    }
  }
}

function isAllowedSystemTempLink(target) {
  const normalized = path.resolve(target);
  if (!["/var", "/tmp"].includes(normalized)) return false;
  try {
    const resolved = path.resolve(realpathSync(normalized));
    return normalized === "/var"
      ? resolved === "/private/var"
      : resolved === "/private/tmp";
  } catch {
    return false;
  }
}

function accountCatalogPath(accountId, artifact, options = {}) {
  return path.join(
    chatGPTSubscriptionAccountCatalogDir(accountId, { homesDir: options.homesDir }),
    artifact,
  );
}

function copyOptionalArtifact(source, destination) {
  if (!existsSync(source)) return false;
  ensureNoSymlinkParents(path.dirname(source));
  const file = lstatSync(source);
  if (file.isSymbolicLink()) throw new Error(`Catalog artifact is a symbolic link: ${source}`);
  if (!file.isFile()) throw new Error(`Catalog artifact is not a regular file: ${source}`);
  atomicPrivateCopy(source, destination);
  return true;
}

function removeOptionalArtifact(target) {
  ensureNoSymlinkParents(path.dirname(target));
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to remove a symbolic-link catalog artifact: ${target}`);
  }
  rmSync(target, { force: true });
}

function snapshotAccountCatalog(accountId, options = {}) {
  const paths = catalogPaths(options);
  for (const [artifact, key] of CATALOG_ARTIFACTS) {
    copyOptionalArtifact(paths[key], accountCatalogPath(accountId, artifact, options));
  }
}

function restoreAccountCatalog(accountId, options = {}) {
  const paths = catalogPaths(options);
  for (const [artifact, key] of CATALOG_ARTIFACTS) {
    const source = accountCatalogPath(accountId, artifact, options);
    if (existsSync(source)) copyOptionalArtifact(source, paths[key]);
    else if (artifact === "models_cache.json" || artifact === "native-models.json") {
      removeOptionalArtifact(paths[key]);
    }
  }
}

function snapshotGlobalCatalog(options = {}) {
  const paths = catalogPaths(options);
  return Object.fromEntries(
    CATALOG_ARTIFACTS.map(([artifact, key]) => [
      key,
      existsSync(paths[key])
        ? (() => {
            ensureNoSymlinkParents(path.dirname(paths[key]));
            const file = lstatSync(paths[key]);
            if (file.isSymbolicLink() || !file.isFile()) {
              throw new Error(`Catalog artifact is not a regular file: ${paths[key]}`);
            }
            return readFileSync(paths[key], "utf8");
          })()
        : null,
    ]),
  );
}

function restoreGlobalCatalog(snapshot, options = {}) {
  validatePersistedGlobalCatalogSnapshot(snapshot);
  const paths = catalogPaths(options);
  for (const [, key] of CATALOG_ARTIFACTS) {
    const contents = snapshot[key];
    if (contents === null) removeOptionalArtifact(paths[key]);
    else atomicContents(paths[key], contents);
  }
}

function writeSwitchTransaction({
  switchPath,
  active,
  target,
  targetIdentity,
  primary,
  catalogsEnabled,
  globalCatalogSnapshot,
  previousState,
  afterEvidenceStaged,
  afterManifestStaged,
}) {
  const directory = transactionDirectory(switchPath);
  const staging = transactionStagingDirectory(switchPath);
  ensureNoSymlinkParents(path.dirname(directory));
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(path.dirname(directory));
  if (existsSync(directory)) {
    throw new Error("A ChatGPT profile switch transaction is already pending recovery.");
  }
  removeStagedSwitchTransaction(switchPath);
  const identity = authIdentity(primary);
  if (!identity) throw new Error("The active ChatGPT login profile has no verified identity.");
  const writerPid = process.pid;
  const writerStartIdentity = processStartIdentity(writerPid);
  if (!writerStartIdentity) throw new Error("The ChatGPT profile switch writer identity is unavailable.");
  mkdirSync(staging, { mode: 0o700 });
  try {
    atomicPrivateCopy(primary, path.join(staging, "primary-auth.json"));
    afterEvidenceStaged?.();
    writePrivateJson(path.join(staging, "manifest.json"), {
      version: TRANSACTION_VERSION,
      active,
      target,
      activeAccountId: identity.accountId,
      targetAccountId: targetIdentity.accountId,
      writerPid,
      writerStartIdentity,
      catalogsEnabled: catalogsEnabled === true,
      previousState,
      ...(catalogsEnabled ? { globalCatalogSnapshot } : {}),
    }, { directoryMode: 0o700 });
    afterManifestStaged?.();
    validateTransactionDirectory(staging);
    ensureNoSymlinkParents(path.dirname(directory));
    if (existsSync(directory)) {
      throw new Error("A ChatGPT profile switch transaction is already pending recovery.");
    }
    renameSync(staging, directory);
    validateTransactionDirectory(directory);
  } finally {
    if (existsSync(staging)) {
      removeValidatedTransactionDirectory(staging);
    }
  }
  return {
    active,
    target,
    activeAccountId: identity.accountId,
    targetAccountId: targetIdentity.accountId,
    writerPid,
    writerStartIdentity,
    catalogsEnabled: catalogsEnabled === true,
    globalCatalogSnapshot,
    previousState,
  };
}

function validateTransactionPreviousState(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== VERSION
    || typeof value.pending !== "boolean"
    || value.phase !== "idle"
  ) {
    throw new Error("The ChatGPT profile switch transaction manifest is invalid.");
  }
  if (value.desired !== undefined && value.desired !== AUTO && value.desired !== LEGACY_PRIMARY && !isChatGPTAccountId(value.desired)) {
    throw new Error("The ChatGPT profile switch transaction manifest is invalid.");
  }
  if (value.active !== undefined && value.active !== LEGACY_PRIMARY && !isChatGPTAccountId(value.active)) {
    throw new Error("The ChatGPT profile switch transaction manifest is invalid.");
  }
  return {
    version: VERSION,
    ...(value.desired ? { desired: value.desired } : {}),
    ...(value.active ? { active: value.active } : {}),
    pending: value.pending,
    phase: "idle",
  };
}

function validatePersistedGlobalCatalogSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("The ChatGPT profile switch catalog snapshot is invalid.");
  }
  const artifactKeys = CATALOG_ARTIFACTS.map(([, key]) => key);
  if (
    Object.keys(snapshot).length !== artifactKeys.length
    || artifactKeys.some((key) => !Object.hasOwn(snapshot, key))
  ) {
    throw new Error("The ChatGPT profile switch catalog snapshot is invalid.");
  }
  for (const [key, contents] of Object.entries(snapshot)) {
    if (!artifactKeys.includes(key) || (contents !== null && typeof contents !== "string")) {
      throw new Error("The ChatGPT profile switch catalog snapshot is invalid.");
    }
  }
  return snapshot;
}

function readSwitchTransaction(switchPath) {
  const directory = transactionDirectory(switchPath);
  if (!existsSync(directory)) return undefined;
  validateTransactionDirectory(directory);
  ensureNoSymlinkParents(directory);
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("The ChatGPT profile switch transaction is not a private directory.");
  }
  const manifestPath = transactionManifestPath(switchPath);
  const authPath = transactionAuthPath(switchPath);
  if (!existsSync(manifestPath) || !existsSync(authPath)) {
    throw new Error("The ChatGPT profile switch transaction is incomplete.");
  }
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error("The ChatGPT profile switch transaction manifest is invalid.");
  }
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    parsed?.version !== TRANSACTION_VERSION
    || !isChatGPTAccountId(parsed.active)
    || !isChatGPTAccountId(parsed.target)
    || typeof parsed.activeAccountId !== "string"
    || !parsed.activeAccountId.trim()
    || typeof parsed.targetAccountId !== "string"
    || !parsed.targetAccountId.trim()
    || ((parsed.writerPid !== undefined || parsed.writerStartIdentity !== undefined)
      && (!Number.isSafeInteger(parsed.writerPid)
        || parsed.writerPid < 1
        || typeof parsed.writerStartIdentity !== "string"
        || !parsed.writerStartIdentity))
    || typeof parsed.catalogsEnabled !== "boolean"
  ) {
    throw new Error("The ChatGPT profile switch transaction manifest is invalid.");
  }
  const globalCatalogSnapshot = parsed.catalogsEnabled
    ? validatePersistedGlobalCatalogSnapshot(parsed.globalCatalogSnapshot)
    : undefined;
  const previousState = parsed.previousState === undefined
    ? undefined
    : validateTransactionPreviousState(parsed.previousState);
  ensureAuthFile(authPath, "The saved");
  if (authIdentity(authPath)?.accountId !== parsed.activeAccountId) {
    throw new Error("The ChatGPT profile switch transaction identity does not match its manifest.");
  }
  return {
    active: parsed.active,
    target: parsed.target,
    activeAccountId: parsed.activeAccountId,
    targetAccountId: parsed.targetAccountId,
    ...(parsed.writerPid === undefined ? {} : {
      writerPid: parsed.writerPid,
      writerStartIdentity: parsed.writerStartIdentity,
    }),
    catalogsEnabled: parsed.catalogsEnabled === true,
    globalCatalogSnapshot,
    previousState,
  };
}

function capturedPrivateFile(target, label) {
  ensureNoSymlinkParents(path.dirname(target), { label });
  const before = lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile() || !privateFileIsProtected(target)) {
    throw new Error(`${label} is not a private file.`);
  }
  const contents = readFileSync(target);
  const after = lstatSync(target);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error(`${label} changed while its capability was captured.`);
  }
  return {
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    digest: createHash("sha256").update(contents).digest("hex"),
  };
}

function authIdentityValue(target) {
  return authIdentity(target)?.accountId;
}

function captureSwitchTransactionCapability(switchPath, options = {}) {
  const directory = transactionDirectory(switchPath);
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("The ChatGPT profile switch transaction capability is not a private directory.");
  }
  const transaction = readSwitchTransaction(switchPath);
  const writerStartIdentity = transaction?.writerPid
    ? processStartIdentity(transaction.writerPid)
    : undefined;
  if (transaction?.writerPid !== process.pid
    || writerStartIdentity !== transaction.writerStartIdentity) {
    throw new Error("The ChatGPT profile switch transaction writer identity is not current.");
  }
  const state = readChatGPTProfileSwitchState(switchPath);
  const homesDir = options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR;
  const pool = readChatGPTAccountPoolState(options.filePath || CHATGPT_ACCOUNT_POOL_PATH);
  return {
    directory: { dev: directoryStat.dev, ino: directoryStat.ino },
    manifest: capturedPrivateFile(transactionManifestPath(switchPath), "The ChatGPT profile switch manifest"),
    evidence: capturedPrivateFile(transactionAuthPath(switchPath), "The ChatGPT profile switch evidence"),
    transaction: JSON.stringify(transaction),
    writerStartIdentity,
    state: JSON.stringify(state),
    primaryIdentity: authIdentityValue(primaryAuthPath(options.primaryHome)),
    activeProfileIdentity: authIdentityValue(profileAuthPath(transaction.active, { homesDir })),
    targetProfileIdentity: authIdentityValue(profileAuthPath(transaction.target, { homesDir })),
    activePoolIdentity: pool.accounts[transaction.active]?.identity?.accountId,
    targetPoolIdentity: pool.accounts[transaction.target]?.identity?.accountId,
  };
}

function assertSwitchTransactionCapability(capability, switchPath, options = {}, {
  expectedState = JSON.parse(capability.state),
  expectedPrimaryIdentity = capability.primaryIdentity,
} = {}) {
  const changed = (cause) => {
    const error = new Error("The durable ChatGPT profile switch transaction capability changed.", {
      ...(cause ? { cause } : {}),
    });
    error.code = "chatgpt_profile_switch_capability_changed";
    return error;
  };
  let current;
  try {
    current = captureSwitchTransactionCapability(switchPath, options);
  } catch (error) {
    throw changed(error);
  }
  const expected = {
    ...capability,
    state: JSON.stringify(expectedState),
    primaryIdentity: expectedPrimaryIdentity,
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw changed();
  }
  return current;
}

function removeSwitchTransaction(switchPath) {
  const directory = transactionDirectory(switchPath);
  if (!existsSync(directory)) return;
  validateTransactionDirectory(directory);
  ensureNoSymlinkParents(directory);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The ChatGPT profile switch transaction is not a private directory.");
  }
  removeValidatedTransactionDirectory(directory);
}

function discardIncompleteUnpublishedTransaction(switchPath, state, options = {}) {
  const directory = transactionDirectory(switchPath);
  if (!existsSync(directory)) return false;
  validateTransactionDirectory(directory);
  const names = new Set(readdirSync(directory));
  if (names.has("manifest.json")) return false;
  if (state.phase !== "idle") {
    throw new Error(`The ChatGPT profile switch transaction is incomplete for phase ${state.phase}.`);
  }
  if (names.has("primary-auth.json")) {
    if (!authFilesEqual(
      path.join(directory, "primary-auth.json"),
      primaryAuthPath(options.primaryHome),
    )) throw new Error("The incomplete ChatGPT profile switch transaction does not match the active login.");
  }
  removeValidatedTransactionDirectory(directory);
  return true;
}

function switchStatesEqual(left, right) {
  return Boolean(
    left
    && right
    && left.version === right.version
    && left.desired === right.desired
    && left.active === right.active
    && left.pending === right.pending
    && left.phase === right.phase,
  );
}

function authFilesEqual(left, right) {
  ensureAuthFile(left, "The active");
  ensureAuthFile(right, "The saved");
  return readFileSync(left).equals(readFileSync(right));
}

function transactionArtifactsExist(switchPath) {
  return existsSync(transactionDirectory(switchPath))
    || existsSync(transactionStagingDirectory(switchPath));
}

function restoreSwitchTransaction(transaction, switchPath, options, { catalogAlreadySettled = false } = {}) {
  atomicPrivateCopy(transactionAuthPath(switchPath), primaryAuthPath(options.primaryHome));
  if (transaction.catalogsEnabled && !catalogAlreadySettled) {
    restoreGlobalCatalog(transaction.globalCatalogSnapshot, options);
  }
}

async function refreshActiveCatalog(options = {}) {
  if (options.refreshCatalog === false) return;
  if (typeof options.refreshCatalog === "function") {
    await options.refreshCatalog();
    return;
  }
  // The profile transaction already owns the catalog publication lock. Calling
  // catalog.mjs as a child would try to acquire that same cross-process lock
  // and deadlock; invoke its exported publication body inside this lease.
  const { publishCatalog } = await import("./catalog.mjs");
  publishCatalog({ refreshNative: true, output: false });
}

function normalizeSelection(value) {
  const selection = String(value || "").trim();
  if (selection === LEGACY_PRIMARY || selection === AUTO || isChatGPTAccountId(selection)) return selection;
  throw new Error("Account selection must be automatic or a registered account id.");
}

function defaultState() {
  return { version: VERSION, desired: undefined, active: undefined, pending: false, phase: "idle" };
}

export function readChatGPTProfileSwitchState(filePath = CHATGPT_PROFILE_SWITCH_PATH) {
  assertProfileDiscoveryEnabled();
  let file;
  try {
    file = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState();
    throw new Error("The saved ChatGPT profile switch state could not be inspected.", { cause: error });
  }
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error("The saved ChatGPT profile switch state is not a regular file.");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error("The saved ChatGPT profile switch state could not be read as JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== VERSION) {
    throw new Error("The saved ChatGPT profile switch state has an unsupported schema.");
  }
  if (
    parsed.desired !== undefined
    && parsed.desired !== AUTO
    && parsed.desired !== LEGACY_PRIMARY
    && !isChatGPTAccountId(parsed.desired)
  ) throw new Error("The saved ChatGPT profile switch target is invalid.");
  if (
    parsed.active !== undefined
    && parsed.active !== LEGACY_PRIMARY
    && !isChatGPTAccountId(parsed.active)
  ) throw new Error("The saved active ChatGPT profile is invalid.");
  if (typeof parsed.pending !== "boolean") {
    throw new Error("The saved ChatGPT profile pending state is invalid.");
  }
  if (!["idle", "preparing", "backed-up", "installed"].includes(parsed.phase)) {
    throw new Error("The saved ChatGPT profile switch phase is invalid.");
  }
  return {
    version: VERSION,
    desired: parsed.desired,
    active: parsed.active,
    pending: parsed.pending,
    phase: parsed.phase,
  };
}

function writeState(state, filePath) {
  const value = {
    version: VERSION,
    ...(state.desired ? { desired: state.desired } : {}),
    ...(state.active ? { active: state.active } : {}),
    pending: state.pending === true,
    phase: state.phase || "idle",
  };
  writePrivateJson(filePath, value, { directoryMode: 0o700 });
  return value;
}

function primaryAuthPath(primaryHome = CODEX_HOME) {
  return path.join(primaryHome, "auth.json");
}

function backupAuthPath(filePath = CHATGPT_PROFILE_SWITCH_PATH) {
  return path.join(path.dirname(filePath), "chatgpt-profile", "primary-auth.json");
}

function profileAuthPath(selection, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) {
  return chatGPTSubscriptionAccountAuthPath(selection, { homesDir });
}

function ensureAuthFile(filePath, label) {
  try {
    ensureNoSymlinkParents(path.dirname(filePath));
    const file = lstatSync(filePath);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error();
    return filePath;
  } catch {
    throw new Error(`${label} login profile is unavailable.`);
  }
}

export function atomicPrivateCopy(source, destination, { protect = protectPrivateFile } = {}) {
  ensureAuthFile(source, "The selected");
  ensureNoSymlinkParents(path.dirname(destination));
  if (existsSync(destination)) {
    const target = lstatSync(destination);
    if (target.isSymbolicLink()) throw new Error("Refusing to replace a symbolic-link login profile.");
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(path.dirname(destination));
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    copyFileSync(source, temporary, fsConstants.COPYFILE_EXCL);
    protect(temporary);
    ensureNoSymlinkParents(path.dirname(destination));
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
      throw new Error("Refusing to replace a symbolic-link login profile.");
    }
    renameSync(temporary, destination);
    // rename preserves the temporary file's DACL on Windows, but protect the
    // final path as well so every OAuth credential replacement is verified at
    // the name Codex will open. POSIX remains an owner-only chmod.
    protect(destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function atomicPrivateContents(contents, destination, { protect = protectPrivateFile } = {}) {
  if (!Buffer.isBuffer(contents)) throw new Error("The selected login profile snapshot is invalid.");
  ensureNoSymlinkParents(path.dirname(destination));
  if (existsSync(destination)) {
    const target = lstatSync(destination);
    if (target.isSymbolicLink()) throw new Error("Refusing to replace a symbolic-link login profile.");
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(path.dirname(destination));
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    protect(temporary);
    ensureNoSymlinkParents(path.dirname(destination));
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
      throw new Error("Refusing to replace a symbolic-link login profile.");
    }
    renameSync(temporary, destination);
    protect(destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function syncAuthProfile(source, destination) {
  ensureAuthFile(source, "The active");
  ensureAuthFile(destination, "The saved");
  const sourceMtime = statSync(source).mtimeMs;
  const destinationMtime = statSync(destination).mtimeMs;
  if (sourceMtime >= destinationMtime) atomicPrivateCopy(source, destination);
  else atomicPrivateCopy(destination, source);
}

function authIdentityFromContents(contents) {
  try {
    const parsed = JSON.parse(Buffer.from(contents).toString("utf8"));
    const tokens = parsed?.tokens;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";
    if (!accountId || accountId.length > 256 || /[\u0000-\u001f\u007f]/.test(accountId)) return undefined;
    let email;
    try {
      const payload = JSON.parse(Buffer.from(String(tokens?.id_token || "").split(".")[1] || "", "base64url").toString("utf8"));
      email = typeof payload?.email === "string" ? payload.email.trim() : undefined;
    } catch {
      email = undefined;
    }
    return { accountId, ...(email ? { email } : {}) };
  } catch {
    return undefined;
  }
}

function authIdentity(filePath) {
  if (!existsSync(filePath)) return undefined;
  try {
    ensureNoSymlinkParents(path.dirname(filePath));
    const file = lstatSync(filePath);
    if (file.isSymbolicLink() || !file.isFile() || !privateFileIsProtected(filePath)) return undefined;
    return authIdentityFromContents(readFileSync(filePath));
  } catch {
    return undefined;
  }
}

function failedLoginDiscardCode(state, accountId, homesDir) {
  const account = state.accounts[accountId];
  if (!account) return undefined;
  const identity = authIdentity(chatGPTSubscriptionAccountAuthPath(accountId, { homesDir }));
  if (!identity) return "invalid-auth";
  const conflicts = (
    (account.identity?.accountId && account.identity.accountId !== identity.accountId)
    || Object.entries(state.accounts).some(([candidateId, candidateAccount]) => (
      candidateId !== accountId
      && (
        candidateAccount?.identity?.accountId === identity.accountId
        || authIdentity(chatGPTSubscriptionAccountAuthPath(candidateId, { homesDir }))?.accountId
          === identity.accountId
      )
    ))
  );
  return conflicts ? "identity-conflict" : undefined;
}

function authSnapshot(filePath, label) {
  ensureAuthFile(filePath, label);
  if (!privateFileIsProtected(filePath)) throw new Error(`${label} login profile is not owner-only.`);
  const contents = readFileSync(filePath);
  const identity = authIdentityFromContents(contents);
  if (!identity) throw new Error(`${label} login profile has no verified identity.`);
  return { contents, identity };
}

function accountForAuth(state, authPath, {
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  leasedAccountIds = new Set(),
} = {}) {
  const identity = authIdentity(authPath);
  if (!identity) return undefined;
  const matches = [];
  for (const id of Object.keys(state.accounts)) {
    const bound = state.accounts[id]?.identity?.accountId;
    if (bound && bound === identity.accountId) {
      matches.push(id);
      continue;
    }
    if (leasedAccountIds.has(id)) continue;
    const candidate = authIdentity(chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
    if (candidate?.accountId === identity.accountId) matches.push(id);
  }
  if (matches.length > 1) throw new Error("The ChatGPT account identity is registered more than once.");
  return matches[0];
}

function ensureProfileAccountLocked(options = {}) {
  const {
    filePath = CHATGPT_ACCOUNT_POOL_PATH,
    homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
    primaryHome = CODEX_HOME,
    switchPath = CHATGPT_PROFILE_SWITCH_PATH,
  } = options;
  let state = readChatGPTAccountPoolState(filePath);
  const leasedAccountIds = new Set(Object.keys(state.accounts).filter((id) => (
    chatGPTLoginLeaseStatus(id, {
      homesDir,
      ...(options.loginLeaseIdentity ? { identity: options.loginLeaseIdentity } : {}),
      ...(options.loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: options.loginLeaseMaxAgeMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }).active
  )));
  const sources = [
    primaryAuthPath(primaryHome),
    backupAuthPath(switchPath),
  ];
  let currentAccountId;
  for (const source of sources) {
    const identity = authIdentity(source);
    if (!identity) continue;
    let id = accountForAuth(state, source, { homesDir, leasedAccountIds });
    if (!id) {
      const created = createChatGPTSubscriptionAccount({ filePath, homesDir, label: "" });
      id = created.id;
      atomicPrivateCopy(source, chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
      state = readChatGPTAccountPoolState(filePath);
    }
    const account = state.accounts[id];
    if (account?.identity?.accountId && account.identity.accountId !== identity.accountId) {
      throw new Error("The saved ChatGPT account identity does not match its login profile.");
    }
    if (account) {
      const nextIdentity = {
        accountId: identity.accountId,
        ...(identity.email ? { email: identity.email } : {}),
      };
      if (
        account.identity?.accountId !== nextIdentity.accountId
        || account.identity?.email !== nextIdentity.email
      ) {
        account.identity = nextIdentity;
        writeChatGPTAccountPoolState(state, filePath);
        state = readChatGPTAccountPoolState(filePath);
      }
    }
    if (source === primaryAuthPath(primaryHome)) currentAccountId = id;
  }
  let identitiesChanged = false;
  const seenIdentities = new Map();
  for (const [id, account] of Object.entries(state.accounts)) {
    if (leasedAccountIds.has(id)) continue;
    const identity = authIdentity(chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
    if (!identity) continue;
    const bound = account?.identity?.accountId;
    if (bound && bound !== identity.accountId) {
      throw new Error("The saved ChatGPT account identity does not match its login profile.");
    }
    const duplicate = seenIdentities.get(identity.accountId);
    if (duplicate && duplicate !== id) {
      throw new Error("The ChatGPT account identity is registered more than once.");
    }
    seenIdentities.set(identity.accountId, id);
    if (!bound) {
      account.identity = { accountId: identity.accountId, ...(identity.email ? { email: identity.email } : {}) };
      identitiesChanged = true;
    }
  }
  if (identitiesChanged) {
    writeChatGPTAccountPoolState(state, filePath);
    state = readChatGPTAccountPoolState(filePath);
  }
  if (currentAccountId) {
    const profile = readChatGPTProfileSwitchState(switchPath);
    const desired = profile.desired === LEGACY_PRIMARY ? currentAccountId : profile.desired;
    const pending = Boolean(desired && desired !== currentAccountId && profile.pending);
    if (profile.active !== currentAccountId || profile.desired === LEGACY_PRIMARY) {
      writeState({ ...profile, active: currentAccountId, desired, pending }, switchPath);
    }
  }
  return {
    state,
    currentAccountId,
  };
}

export async function ensureChatGPTProfileAccounts(options = {}) {
  assertProfileDiscoveryEnabled();
  return withChatGPTAccountPoolLock(
    () => withProfileAccountLocks(() => {
      assertNoLiveSwitchWriter(options);
      return ensureProfileAccountLocked(options);
    }, options),
    { filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH },
  );
}

async function finalizeChatGPTProfileLoginLocked(accountId, options = {}) {
    recoverInterruptedSwitchLocked(options);
    const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
    const homesDir = options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR;
    const state = readChatGPTAccountPoolState(filePath);
    const account = state.accounts[accountId];
    if (!account || account.state !== "active" || account.paused) {
      throw new Error("The subscription account is not active.");
    }
    const expectedLoginLease = options.expectedLoginLease;
    if (!expectedLoginLease) throw new Error("The ChatGPT login completion lease is required.");
    const loginLeaseMatches = options.loginLeaseMatches || chatGPTLoginLeaseMatches;
    if (!loginLeaseMatches(accountId, expectedLoginLease, { homesDir })) {
      throw new Error("The ChatGPT login completion lease changed before finalization.");
    }
    const loginAuthChanged = options.loginAuthChanged || chatGPTLoginAuthChanged;
    if (!loginAuthChanged(accountId, expectedLoginLease, { homesDir })) {
      const clearLoginLease = options.clearLoginLease || clearChatGPTLoginLease;
      if (!clearLoginLease(accountId, expectedLoginLease, { homesDir })) {
        throw new Error("The ChatGPT login completion lease changed before cancellation cleanup.");
      }
      throw new Error("Codex login closed before this account's credentials changed.");
    }
    const hardenAuth = options.hardenAuth || hardenChatGPTSubscriptionAccountAuth;
    hardenAuth(accountId, { homesDir });
    const identity = authIdentity(chatGPTSubscriptionAccountAuthPath(accountId, { homesDir }));
    if (!identity) throw new Error("The ChatGPT account login profile is invalid after hardening.");
    if (account.identity?.accountId && account.identity.accountId !== identity.accountId) {
      throw new Error("The selected ChatGPT login profile identity does not match its saved account.");
    }
    const duplicate = Object.entries(state.accounts).find(([candidateId, candidate]) => {
      if (candidateId === accountId) return false;
      if (candidate?.identity?.accountId === identity.accountId) return true;
      return authIdentity(chatGPTSubscriptionAccountAuthPath(candidateId, { homesDir }))?.accountId
        === identity.accountId;
    });
    if (duplicate) throw new Error("The ChatGPT account identity is registered more than once.");
    if (!loginLeaseMatches(accountId, expectedLoginLease, { homesDir })) {
      throw new Error("The ChatGPT login completion lease changed before finalization.");
    }
    const finalizedIdentity = authIdentity(chatGPTSubscriptionAccountAuthPath(accountId, { homesDir }));
    if (!finalizedIdentity || finalizedIdentity.accountId !== identity.accountId) {
      throw new Error("The ChatGPT login profile changed during finalization.");
    }
    if (!account.identity?.accountId) {
      account.identity = {
        accountId: finalizedIdentity.accountId,
        ...(finalizedIdentity.email ? { email: finalizedIdentity.email } : {}),
      };
      writeChatGPTAccountPoolState(state, filePath);
    }
    const profile = readChatGPTProfileSwitchState(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH);
    if (profile.active === accountId && codexDesktopRunning(options)) {
      return { ...profile, loginFinalizationPending: true };
    }
    const finalized = profile.active !== accountId
      ? profile
      : await applyLocked(accountId, {
        ...options,
        loginLeaseAccountId: accountId,
        expectedLoginLease,
      });
    return mapProfileMutationPause(finalized, (completed) => {
      const clearLoginLease = options.clearLoginLease || clearChatGPTLoginLease;
      if (!clearLoginLease(accountId, expectedLoginLease, { homesDir })) {
        throw new Error("The ChatGPT login completion lease changed after finalization.");
      }
      return completed;
    }, (error) => { throw error; });
}

export async function finalizeChatGPTProfileLogin(accountId, options = {}) {
  assertProfileDiscoveryEnabled();
  if (!isChatGPTAccountId(accountId)) throw new Error("Account id is invalid.");
  return runProfileMutation(
    () => finalizeChatGPTProfileLoginLocked(accountId, options),
    options,
    [accountId],
  );
}

export async function recoverCompletedChatGPTProfileLogins(options = {}) {
  assertProfileDiscoveryEnabled();
  const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
  const homesDir = options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR;
  return runProfileMutation(async () => {
      const state = readChatGPTAccountPoolState(filePath);
      const recovered = [];
      const failures = [];
      const accountIds = Object.keys(state.accounts).sort();
      const processCandidate = async (index) => {
        if (index >= accountIds.length) return { recovered, failures };
        const accountId = accountIds[index];
        const candidate = chatGPTLoginLeaseCompletionCandidate(accountId, {
          homesDir,
          ...(options.loginLeaseIdentity ? { identity: options.loginLeaseIdentity } : {}),
          ...(options.loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: options.loginLeaseMaxAgeMs }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (!candidate) return processCandidate(index + 1);
        const failed = () => {
          failures.push({
            accountId,
            code: failedLoginDiscardCode(
              readChatGPTAccountPoolState(filePath),
              accountId,
              homesDir,
            ) || "finalization-failed",
          });
          return processCandidate(index + 1);
        };
        try {
          const result = await finalizeChatGPTProfileLoginLocked(accountId, {
            ...options,
            expectedLoginLease: candidate,
          });
          return mapProfileMutationPause(result, (completed) => {
            if (completed.loginFinalizationPending !== true) recovered.push(accountId);
            return processCandidate(index + 1);
          }, failed);
        } catch {
          return failed();
        }
      };
      return processCandidate(0);
    }, options);
}

export async function discardCompletedChatGPTProfileLogin(accountId, options = {}) {
  assertProfileDiscoveryEnabled();
  if (!isChatGPTAccountId(accountId)) throw new Error("Account id is invalid.");
  return withChatGPTAccountPoolLock(() => withProfileMutationLocks(() => {
    const homesDir = options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR;
    const candidate = chatGPTLoginLeaseCompletionCandidate(accountId, {
      homesDir,
      ...(options.loginLeaseIdentity ? { identity: options.loginLeaseIdentity } : {}),
      ...(options.loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: options.loginLeaseMaxAgeMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (!candidate) return false;
    const state = readChatGPTAccountPoolState(options.filePath || CHATGPT_ACCOUNT_POOL_PATH);
    // A valid, unique completion is recovery evidence, not retry debris. It
    // may be waiting for the active Codex app to close and must never be
    // discarded by a direct CLI reset or an account-removal attempt.
    if (!failedLoginDiscardCode(state, accountId, homesDir)) return false;
    const clearLoginLease = options.clearLoginLease || clearChatGPTLoginLease;
    if (!clearLoginLease(accountId, candidate, { homesDir })) {
      throw new Error("The ChatGPT login completion lease changed before retry cleanup.");
    }
    return true;
  }, options, [accountId]), accountPoolLockOptions(options));
}

export function codexDesktopRunning({ platform = process.platform, processList, processListReader } = {}) {
  if (!["darwin", "win32", "linux", "freebsd"].includes(platform)) return true;
  let listing = processList;
  if (listing === undefined) {
    try {
      listing = typeof processListReader === "function"
        ? processListReader(platform)
        : platform === "win32"
          ? execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          : execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return true;
    }
  }
  const patterns = platform === "darwin"
    ? [/\/((?:ChatGPT|Codex)\.app)\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/]
    : platform === "win32"
      ? [/(?:^|[\\/\s",])(?:ChatGPT|Codex)\.exe(?:[\s",]|$)/i]
      : [/(?:^|[\\/])(?:ChatGPT|Codex)(?:[- ]desktop)?(?:\.AppImage)?(?:\s|$)/i];
  return String(listing).split(/\r?\n/).some((line) => patterns.some((pattern) => pattern.test(line)));
}

function validateSelection(selection, { filePath = CHATGPT_ACCOUNT_POOL_PATH, currentAccountId } = {}) {
  const normalized = normalizeSelection(selection);
  if (normalized === LEGACY_PRIMARY) return currentAccountId;
  if (normalized === AUTO) return normalized;
  const state = readChatGPTAccountPoolState(filePath);
  const account = state.accounts[normalized];
  if (!account || account.state !== "active" || account.paused) {
    throw new Error("The selected subscription account is not active.");
  }
  return normalized;
}

function recoverInterruptedSwitchLocked(options) {
  const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
  const state = readChatGPTProfileSwitchState(switchPath);
  removeStagedSwitchTransaction(switchPath);
  if (discardIncompleteUnpublishedTransaction(switchPath, state, options)) return state;
  const transaction = readSwitchTransaction(switchPath);
  if (!transaction) {
    if (state.phase !== "idle") {
      throw new Error(`The ChatGPT profile switch has no durable transaction for phase ${state.phase}.`);
    }
    return state;
  }
  if (state.phase !== "idle" && transaction.writerPid !== undefined) {
    const probe = options.profileWriterIdentityProbe || processStartIdentityProbe;
    const observed = probe(transaction.writerPid);
    const sameWriter = observed?.state === "alive"
      && observed.identity === transaction.writerStartIdentity;
    const unknownWriter = observed?.state === "unknown";
    if (sameWriter || unknownWriter) {
      const error = new Error("A live durable ChatGPT profile switch writer reservation is active.");
      error.code = "chatgpt_profile_switch_reserved";
      throw error;
    }
  }
  if (state.phase === "idle") {
    const completed = !state.pending
      && state.active === transaction.target
      && state.desired === transaction.target;
    const rolledBack = state.pending
      && state.active === transaction.active
      && state.desired === transaction.target;
    const notStarted = switchStatesEqual(state, transaction.previousState)
      && authFilesEqual(
        primaryAuthPath(options.primaryHome),
        transactionAuthPath(switchPath),
      );
    if (!completed && !rolledBack && !notStarted) {
      throw new Error("The idle ChatGPT profile state does not match its durable transaction.");
    }
    removeSwitchTransaction(switchPath);
    return state;
  }
  if (state.phase === "installed") {
    const targetProfile = profileAuthPath(transaction.target, {
      homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
    });
    const targetIdentity = authIdentity(targetProfile);
    const primaryIdentity = authIdentity(primaryAuthPath(options.primaryHome));
    if (
      !targetIdentity
      || targetIdentity.accountId !== transaction.targetAccountId
      || !primaryIdentity
      || primaryIdentity.accountId !== transaction.targetAccountId
    ) {
      restoreSwitchTransaction(transaction, switchPath, options);
      const rolledBack = writeState({
        ...state,
        desired: transaction.target,
        active: transaction.active,
        pending: true,
        phase: "idle",
      }, switchPath);
      removeSwitchTransaction(switchPath);
      return rolledBack;
    }
    const completed = writeState({
      desired: transaction.target,
      active: transaction.target,
      pending: false,
      phase: "idle",
    }, switchPath);
    removeSwitchTransaction(switchPath);
    return completed;
  }
  restoreSwitchTransaction(transaction, switchPath, options);
  const recovered = writeState({
    ...state,
    desired: transaction.target,
    active: transaction.active,
    pending: true,
    phase: "idle",
  }, switchPath);
  removeSwitchTransaction(switchPath);
  return recovered;
}

function assertProfileLoginLeaseInactive(accountId, options = {}) {
  const loginLeaseMatches = options.loginLeaseMatches || chatGPTLoginLeaseMatches;
  if (
    accountId === options.loginLeaseAccountId
    && loginLeaseMatches(accountId, options.expectedLoginLease, {
      homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
    })
  ) return;
  assertChatGPTLoginLeaseInactive(accountId, {
    homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
    ...(options.loginLeaseIdentity ? { identity: options.loginLeaseIdentity } : {}),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: options.loginLeaseMaxAgeMs }),
    message: "Cannot change a ChatGPT profile while its browser sign-in is in progress.",
  });
}

const PROFILE_MUTATION_PAUSE = Symbol("profile-mutation-pause");

function profileMutationPause(wait, resumeLocked, settleWaitError) {
  return { [PROFILE_MUTATION_PAUSE]: true, wait, resumeLocked, settleWaitError };
}

function isProfileMutationPause(value) {
  return value?.[PROFILE_MUTATION_PAUSE] === true;
}

function mapProfileMutationPause(value, onComplete, onError) {
  if (!isProfileMutationPause(value)) return onComplete(value);
  return profileMutationPause(value.wait, async (waitError, context) => {
    try {
      const resumed = await value.resumeLocked(waitError, context);
      return mapProfileMutationPause(resumed, onComplete, onError);
    } catch (error) {
      return onError(error);
    }
  }, value.settleWaitError);
}

async function runProfileMutation(operation, options, extraAccountIds = []) {
  const runLocked = (lockedOperation, resume = false) => withChatGPTAccountPoolLock(
    () => withProfileMutationLocks(lockedOperation, options, extraAccountIds, resume),
    accountPoolLockOptions(options),
  );
  let result = await runLocked(operation);
  while (isProfileMutationPause(result)) {
    let waitError;
    let catalogAlreadySettled = false;
    let catalogSettlementFailure;
    let outerCatalogLockCompleted = false;
    const pause = result;
    try {
      await withProfileCatalogLock(async () => {
        try {
          await pause.wait();
        } catch (error) {
          waitError = error;
          if (pause.settleWaitError) {
            try {
              await pause.settleWaitError(error);
              catalogAlreadySettled = true;
            } catch (settlementError) {
              catalogSettlementFailure = settlementError;
              throw settlementError;
            }
          }
        }
      }, options);
      outerCatalogLockCompleted = true;
    } catch (error) {
      catalogSettlementFailure ||= error;
      // A publication can complete before proper-lockfile reports a release
      // failure. Resume the installed transaction immediately so later
      // recovery cannot mistake a successfully refreshed catalog for stale
      // pre-switch state and roll it back.
      if (!waitError && /catalog was published, but its publication lock could not be released/i.test(String(error?.message || ""))) {
        let resumedSuccessfully = false;
        try {
          result = await runLocked(
            () => pause.resumeLocked(undefined, { catalogAlreadySettled: true }),
            true,
          );
          resumedSuccessfully = true;
        } catch {}
        if (resumedSuccessfully) {
          const settled = new Error(
            "ChatGPT catalog publication settled, but its lock release was not confirmed; retry the operation.",
            { cause: error },
          );
          settled.code = "chatgpt_catalog_settlement_failed";
          throw settled;
        }
      }
    }
    if (!outerCatalogLockCompleted
      || catalogSettlementFailure
      || (waitError && !catalogAlreadySettled)) {
      const error = new Error(
        "ChatGPT catalog rollback settlement failed while publication ownership was held; durable recovery evidence was retained.",
        { cause: catalogSettlementFailure || waitError },
      );
      error.code = "chatgpt_catalog_settlement_failed";
      throw error;
    }
    result = await runLocked(
      () => pause.resumeLocked(waitError, { catalogAlreadySettled }),
      true,
    );
  }
  return result;
}

async function applyLocked(selection, options) {
  const {
    filePath = CHATGPT_ACCOUNT_POOL_PATH,
    homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
    primaryHome = CODEX_HOME,
    switchPath = CHATGPT_PROFILE_SWITCH_PATH,
  } = options;
  const migration = ensureProfileAccountLocked({ filePath, homesDir, primaryHome, switchPath });
  const current = readChatGPTProfileSwitchState(switchPath);
  const active = current.active || migration.currentAccountId;
  const targetSelection = selection === LEGACY_PRIMARY ? migration.currentAccountId : selection;
  if (!active && targetSelection !== AUTO) throw new Error("No logged-in ChatGPT account is available.");
  const target = targetSelection === AUTO ? active : targetSelection;
  const primary = primaryAuthPath(primaryHome);
  const activeProfile = profileAuthPath(active, { homesDir });
  const targetProfile = profileAuthPath(target, { homesDir });
  for (const accountId of new Set([active, target].filter(Boolean))) {
    assertProfileLoginLeaseInactive(accountId, options);
  }
  let sameAccountRefreshPending = false;
  if (target === active && target) {
    ensureAuthFile(primary, "The active");
    ensureAuthFile(targetProfile, "The selected");
    const poolState = readChatGPTAccountPoolState(filePath);
    const targetIdentity = authIdentity(targetProfile);
    const boundIdentity = poolState.accounts[target]?.identity?.accountId;
    if (!targetIdentity) throw new Error("The selected ChatGPT login profile has no verified identity.");
    if (boundIdentity && boundIdentity !== targetIdentity.accountId) {
      throw new Error("The selected ChatGPT login profile identity does not match its saved account.");
    }
    sameAccountRefreshPending = !authFilesEqual(primary, targetProfile);
  }
  if (codexDesktopRunning(options)) {
    return writeState({
      ...current,
      desired: target,
      active,
      pending: Boolean(target && (target !== active || sameAccountRefreshPending)),
      phase: "idle",
    }, switchPath);
  }
  if (target === active && !sameAccountRefreshPending) {
    return writeState({ ...current, desired: target, active, pending: false, phase: "idle" }, switchPath);
  }
  ensureAuthFile(activeProfile, "The active");
  const targetSnapshot = authSnapshot(targetProfile, "The selected");
  const poolState = readChatGPTAccountPoolState(filePath);
  const targetIdentity = targetSnapshot.identity;
  const boundIdentity = poolState.accounts[target]?.identity?.accountId;
  if (!targetIdentity) throw new Error("The selected ChatGPT login profile has no verified identity.");
  if (boundIdentity && boundIdentity !== targetIdentity.accountId) {
    throw new Error("The selected ChatGPT login profile identity does not match its saved account.");
  }
  const catalogsEnabled = catalogHandlingEnabled(options);
  const globalCatalogSnapshot = catalogsEnabled ? snapshotGlobalCatalog(options) : undefined;
  if (catalogsEnabled) snapshotAccountCatalog(active, options);
  let transaction;
  try {
    transaction = writeSwitchTransaction({
      switchPath,
      active,
      target,
      targetIdentity,
      primary,
      catalogsEnabled,
      globalCatalogSnapshot,
      previousState: current,
      afterEvidenceStaged: options.afterSwitchTransactionEvidenceStaged,
      afterManifestStaged: options.afterSwitchTransactionManifestStaged,
    });
    options.afterSwitchTransactionPublished?.();
    writeState({ ...current, desired: target, active, pending: true, phase: "preparing" }, switchPath);
    options.afterSwitchPreparing?.();
    if (target !== active) syncAuthProfile(primary, activeProfile);
    writeState({ ...current, desired: target, active, pending: true, phase: "backed-up" }, switchPath);
    options.afterSwitchBackup?.();
    atomicPrivateContents(targetSnapshot.contents, primary);
    options.afterSwitchInstall?.();
    const assertTargetSnapshotInstalled = () => {
      let targetStillCurrent = false;
      try {
        ensureAuthFile(targetProfile, "The selected");
        ensureAuthFile(primary, "The active");
        targetStillCurrent = privateFileIsProtected(targetProfile)
          && privateFileIsProtected(primary)
          && readFileSync(targetProfile).equals(targetSnapshot.contents)
          && readFileSync(primary).equals(targetSnapshot.contents)
          && authIdentity(primary)?.accountId === targetIdentity.accountId;
      } catch {}
      if (!targetStillCurrent) {
        throw new Error("The selected ChatGPT login profile changed during the native switch.");
      }
    };
    assertTargetSnapshotInstalled();
    const finishInstalled = (capability) => {
      assertTargetSnapshotInstalled();
      if (capability) assertSwitchTransactionCapability(capability, switchPath, options);
      writeState({ desired: target, active: target, pending: false, phase: "installed" }, switchPath);
      options.afterSwitchInstalled?.();
      if (capability) {
        assertSwitchTransactionCapability(capability, switchPath, options, {
          expectedState: { version: VERSION, desired: target, active: target, pending: false, phase: "installed" },
        });
      }
      const completed = writeState({ desired: target, active: target, pending: false, phase: "idle" }, switchPath);
      options.afterSwitchIdleBeforeTransactionRemoval?.();
      if (capability) {
        assertSwitchTransactionCapability(capability, switchPath, options, {
          expectedState: completed,
        });
      }
      removeSwitchTransaction(switchPath);
      return completed;
    };
    const rollback = (error, capability, { catalogAlreadySettled = false } = {}) => {
      if (capability) assertSwitchTransactionCapability(capability, switchPath, options);
      try {
        restoreSwitchTransaction(transaction, switchPath, options, { catalogAlreadySettled });
        const rolledBack = writeState({ ...current, desired: target, active, pending: true, phase: "idle" }, switchPath);
        if (capability) {
          assertSwitchTransactionCapability(capability, switchPath, options, {
            expectedState: rolledBack,
            expectedPrimaryIdentity: transaction.activeAccountId,
          });
        }
        removeSwitchTransaction(switchPath);
      } catch (rollbackError) {
        if (rollbackError?.code === "chatgpt_profile_switch_capability_changed") throw rollbackError;
        writeState({ ...current, desired: target, active, pending: true, phase: "backed-up" }, switchPath);
      }
      throw error;
    };
    if (catalogsEnabled) {
      restoreAccountCatalog(target, options);
      const capability = captureSwitchTransactionCapability(switchPath, options);
      return profileMutationPause(
        () => refreshActiveCatalog(options),
        async (waitError, { catalogAlreadySettled = false } = {}) => {
          // A foreign/replacement transaction is not ours to restore or
          // remove, even if its active/target ids happen to match.
          assertSwitchTransactionCapability(capability, switchPath, options);
          assertProfileLoginLeaseInactive(active, options);
          if (target !== active) assertProfileLoginLeaseInactive(target, options);
          if (waitError) return rollback(waitError, capability, { catalogAlreadySettled });
          try {
            snapshotAccountCatalog(target, options);
            return finishInstalled(capability);
          } catch (error) {
            return rollback(error, capability, { catalogAlreadySettled });
          }
        },
        () => {
          assertSwitchTransactionCapability(capability, switchPath, options);
          options.beforeCatalogErrorSettlement?.();
          restoreGlobalCatalog(transaction.globalCatalogSnapshot, options);
          assertSwitchTransactionCapability(capability, switchPath, options);
        },
      );
    }
    // Catalog publication can await the Codex CLI. Recheck the exact source
    // generation after that asynchronous boundary and immediately before the
    // installed phase becomes durable.
    return finishInstalled();
  } catch (error) {
    // Staging and journal construction do not mutate the primary auth or the
    // global catalog. If construction did not return a complete transaction,
    // leave both and the prior policy byte-for-byte unchanged; recovery will
    // inspect any atomically published journal rather than guessing.
    if (!transaction) throw error;
    try {
      restoreSwitchTransaction(transaction, switchPath, options);
      writeState({ ...current, desired: target, active, pending: true, phase: "idle" }, switchPath);
      removeSwitchTransaction(switchPath);
    } catch {
      writeState({ ...current, desired: target, active, pending: true, phase: "backed-up" }, switchPath);
    }
    throw error;
  }
}

export async function requestChatGPTProfileSwitch(selection, options = {}) {
  assertProfileDiscoveryEnabled();
  return runProfileMutation(() => applyRequestedSelectionLocked(selection, options), options);
}

function accountPoolLockOptions(options) {
  return {
    filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
  };
}

async function applyRequestedSelectionLocked(selection, options) {
  recoverInterruptedSwitchLocked(options);
  const migration = ensureProfileAccountLocked(options);
  const normalized = validateSelection(selection, {
    ...options,
    currentAccountId: migration.currentAccountId,
  });
  return applyLocked(normalized, options);
}

async function restoreAccountTransaction({ pool, profile }, options) {
  const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
  const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
  const current = readChatGPTProfileSwitchState(switchPath);
  if (current.phase !== "idle") {
    throw new Error(`The ChatGPT profile rollback requires recovery from phase ${current.phase}.`);
  }
  if (profile.active && current.active !== profile.active) {
    await applyLocked(profile.active, options);
  }
  writeState(profile, switchPath);
  writeChatGPTAccountPoolState(pool, filePath);
}

/**
 * Select an account and update the native profile under the same cross-process
 * lock. A desktop-open selection is intentionally represented as
 * policy.selectedAccountId === profile.desired with profile.pending === true.
 */
export async function selectChatGPTProfileAccount(selection, options = {}) {
  assertProfileDiscoveryEnabled();
  return runProfileMutation(async () => {
    recoverInterruptedSwitchLocked(options);
    const migration = ensureProfileAccountLocked(options);
    const normalized = validateSelection(selection, {
      ...options,
      currentAccountId: migration.currentAccountId,
    });
    if (normalized === AUTO || normalized === LEGACY_PRIMARY) {
      throw new Error("Select a registered ChatGPT account id.");
    }
    const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
    const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
    const before = {
      pool: readChatGPTAccountPoolState(filePath),
      profile: readChatGPTProfileSwitchState(switchPath),
    };
    const finishSelection = (profile) => {
      const current = readChatGPTAccountPoolState(filePath);
      const account = current.accounts[normalized];
      if (!account || account.state !== "active" || account.paused) {
        throw new Error("The selected subscription account changed while the profile was switching.");
      }
      const selectedProfile = profile.desired || profile.active;
      if (selectedProfile !== normalized) {
        throw new Error("The native profile selection did not reach a consistent state.");
      }
      current.policy.enabled = true;
      current.policy.selectedAccountId = normalized;
      const writePool = options.writeAccountPoolState || writeChatGPTAccountPoolState;
      const pool = writePool(current, filePath);
      return { pool: sanitizeChatGPTAccountPool(pool), profile };
    };
    const rollbackSelection = async (error) => {
      try {
        await restoreAccountTransaction(before, options);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "ChatGPT account selection and rollback both failed.");
      }
      throw error;
    };
    try {
      const profile = await applyLocked(normalized, options);
      return mapProfileMutationPause(profile, finishSelection, rollbackSelection);
    } catch (error) {
      return rollbackSelection(error);
    }
  }, options);
}

/** Remove an account, including any required profile handoff, under one lock. */
export async function removeChatGPTProfileAccount(accountId, options = {}) {
  assertProfileDiscoveryEnabled();
  if (!isChatGPTAccountId(accountId)) throw new Error("Account id is invalid.");
  return runProfileMutation(async () => {
    recoverInterruptedSwitchLocked(options);
    const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
    const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
    const initialPool = readChatGPTAccountPoolState(filePath);
    const initialProfile = readChatGPTProfileSwitchState(switchPath);
    const homesDir = options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR;
    const targetIdentity = authIdentity(chatGPTSubscriptionAccountAuthPath(accountId, { homesDir }));
    const removableIdentityConflict = Boolean(
      targetIdentity
      && initialProfile.active !== accountId
      && initialProfile.desired !== accountId
      && (
        (
          initialPool.accounts[accountId]?.identity?.accountId
          && initialPool.accounts[accountId].identity.accountId !== targetIdentity.accountId
        )
        || Object.entries(initialPool.accounts).some(([candidateId, candidate]) => (
          candidateId !== accountId
          && (
            candidate?.identity?.accountId === targetIdentity.accountId
            || authIdentity(chatGPTSubscriptionAccountAuthPath(candidateId, { homesDir }))?.accountId
              === targetIdentity.accountId
          )
        ))
      ),
    );
    // Normal discovery must reject duplicate identities. Removal is the one
    // operation that can resolve an already-classified conflict, and only
    // while the target is neither active nor desired. Active conflicts remain
    // recoverable through Retry without bypassing native-profile discovery.
    if (!removableIdentityConflict) ensureProfileAccountLocked(options);
    const before = {
      pool: readChatGPTAccountPoolState(filePath),
      profile: readChatGPTProfileSwitchState(switchPath),
    };
    const account = before.pool.accounts[accountId];
    if (!account) throw new Error("Account id is not registered.");
    assertChatGPTLoginLeaseInactive(accountId, {
      homesDir,
      ...(options.loginLeaseIdentity ? { identity: options.loginLeaseIdentity } : {}),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: options.loginLeaseMaxAgeMs }),
    });
    if (before.profile.pending && before.profile.desired === accountId) {
      throw new Error("Cannot remove a ChatGPT account with a pending native profile selection.");
    }
    const finishRemoval = (profile) => {
      const current = readChatGPTAccountPoolState(filePath);
      if (!current.accounts[accountId]) {
        throw new Error("The ChatGPT account changed while it was being removed.");
      }
      const selected = profile.desired || profile.active;
      const removeAccount = options.removeAccount || removeChatGPTSubscriptionAccountLocked;
      const removed = removeAccount(accountId, {
        filePath,
        homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
        ...(selected && selected !== accountId ? { selectedAccountId: selected } : {}),
        ...(options.loginLeaseIdentity ? { loginLeaseIdentity: options.loginLeaseIdentity } : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.loginLeaseMaxAgeMs === undefined ? {} : { loginLeaseMaxAgeMs: options.loginLeaseMaxAgeMs }),
        ...(options.requestLeaseIdentityProbe ? { requestLeaseIdentityProbe: options.requestLeaseIdentityProbe } : {}),
      });
      return {
        removed,
        pool: sanitizeChatGPTAccountPool(readChatGPTAccountPoolState(filePath)),
        profile,
      };
    };
    const rollbackRemoval = async (error) => {
      try {
        await restoreAccountTransaction(before, options);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "ChatGPT account removal and rollback both failed.");
      }
      throw error;
    };
    try {
      let profile = before.profile;
      if (profile.active === accountId) {
        if (codexDesktopRunning(options)) {
          throw new Error("Close Codex before removing the active subscription account.");
        }
        const replacement = Object.values(before.pool.accounts).find(
          (candidate) => candidate.id !== accountId
            && candidate.state === "active"
            && !candidate.paused,
        );
        if (!replacement) throw new Error("Cannot remove the only logged-in ChatGPT account.");
        profile = await applyLocked(replacement.id, options);
        const validateReplacement = (applied) => {
          if (applied.active !== replacement.id || applied.pending) {
            throw new Error("The replacement ChatGPT profile did not become active.");
          }
          return finishRemoval(applied);
        };
        return mapProfileMutationPause(profile, validateReplacement, rollbackRemoval);
      }
      return finishRemoval(profile);
    } catch (error) {
      return rollbackRemoval(error);
    }
  }, options, [accountId]);
}

export async function reconcileChatGPTProfileSwitch(options = {}) {
  assertProfileDiscoveryEnabled();
  return runProfileMutation(async () => {
      // Desired is a mutable policy decision. Read it only after both locks
      // are held; a reconciler that remembers B while a newer selector commits
      // A can otherwise install the stale login after it finally acquires them.
      recoverInterruptedSwitchLocked(options);
      const state = readChatGPTProfileSwitchState(
        options.switchPath || CHATGPT_PROFILE_SWITCH_PATH,
      );
      if (!state.pending && state.phase === "idle") return state;
      return applyRequestedSelectionLocked(state.desired, options);
    }, options);
}

export async function reconcileChatGPTProfileSwitchIfReady(options = {}) {
  assertProfileDiscoveryEnabled();
  const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
  const state = chatGPTProfileSwitchSnapshot(options);
  // This is the safe polling/startup hook: it performs no mutation for settled
  // idle state, and never mutates while Codex is running. Once Codex releases
  // auth, it completes either an earlier explicit pending selection or durable
  // crash recovery from a non-idle transaction phase under both locks.
  if (state.running || (!state.pending && state.phase === "idle" && !transactionArtifactsExist(switchPath))) return state;
  return reconcileChatGPTProfileSwitch(options);
}

export function selectedChatGPTUsageProfile({
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  primaryHome = CODEX_HOME,
  switchPath = CHATGPT_PROFILE_SWITCH_PATH,
} = {}) {
  assertProfileDiscoveryEnabled();
  const pool = readChatGPTAccountPoolState(filePath);
  const profile = readChatGPTProfileSwitchState(switchPath);
  const selection = pool.policy.selectedAccountId || profile.active;
  if (!selection || selection === AUTO || selection === LEGACY_PRIMARY) return { selection: selection || AUTO, home: undefined, pending: profile.pending };
  const account = pool.accounts[selection];
  if (!account || account.state !== "active") return { selection, home: undefined, pending: profile.pending };
  return {
    selection,
    home: path.dirname(chatGPTSubscriptionAccountAuthPath(selection, { homesDir })),
    email: chatGPTSubscriptionAccountStatus(selection, { homesDir }).email,
    pending: profile.pending && profile.desired === selection,
  };
}

export function chatGPTProfileSwitchSnapshot(options = {}) {
  assertProfileDiscoveryEnabled();
  const state = readChatGPTProfileSwitchState(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH);
  return { ...state, running: codexDesktopRunning(options) };
}
