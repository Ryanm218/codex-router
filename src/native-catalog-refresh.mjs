import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHILD_ENV_ALLOWLIST = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"];

// Filesystem and service clocks can differ slightly even on one host. This is
// deliberately small: it tolerates timestamp granularity without admitting an
// old cache as evidence for the current invocation.
export const CATALOG_CLOCK_SKEW_MS = 5_000;

const DEFAULT_FILE_SYSTEM = {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
};

export class NativeCatalogRefreshError extends Error {
  constructor(code) {
    super(`Native catalog acquisition failed (${code}).`);
    this.name = "NativeCatalogRefreshError";
    this.code = code;
  }
}

function fail(code) {
  throw new NativeCatalogRefreshError(code);
}

function unixMode(metadata) {
  return metadata.mode & 0o777;
}

function childEnvironment(source, codexHome) {
  const child = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof source?.[key] === "string") child[key] = source[key];
  }
  child.CODEX_HOME = codexHome;
  return child;
}

function authPreflight(authPath, uid, fileSystem) {
  let metadata;
  try {
    metadata = fileSystem.lstatSync(authPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("AUTH_METADATA_UNAVAILABLE");
  }
  if (!metadata.isFile()) fail("AUTH_NOT_REGULAR");

  let actualPath;
  let expectedPath;
  try {
    actualPath = fileSystem.realpathSync(authPath);
    expectedPath = path.join(
      fileSystem.realpathSync(path.dirname(authPath)),
      path.basename(authPath),
    );
  } catch {
    fail("AUTH_PATH_CHANGED");
  }
  if (actualPath !== expectedPath) fail("AUTH_PATH_CHANGED");
  if (metadata.uid !== uid) fail("AUTH_OWNER_MISMATCH");
  if (unixMode(metadata) !== 0o600) fail("AUTH_MODE_INVALID");
  return { metadata, resolvedPath: actualPath };
}

function parseCandidate(stdout) {
  let candidate;
  try {
    candidate = JSON.parse(stdout);
  } catch {
    fail("STDOUT_INVALID");
  }
  if (!candidate || !Array.isArray(candidate.models) || candidate.models.length === 0) {
    fail("STDOUT_INVALID");
  }
  return candidate;
}

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseClientVersion(child) {
  if (child?.status !== 0) fail("VERSION_FAILED");
  if (typeof child.stderr === "string" && child.stderr.length > 0) {
    fail("VERSION_STDERR");
  }
  const clientVersion = typeof child.stdout === "string" ? child.stdout.trim() : "";
  const prefix = "codex-cli ";
  const cacheVersion = clientVersion.startsWith(prefix)
    ? clientVersion.slice(prefix.length)
    : "";
  if (!SEMANTIC_VERSION_PATTERN.test(cacheVersion)) fail("VERSION_INVALID");
  return { clientVersion, cacheVersion };
}

function parseCache(cachePath, { cacheVersion, uid, startedAt, endedAt }, fileSystem) {
  let metadata;
  try {
    metadata = fileSystem.lstatSync(cachePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail("CACHE_MISSING");
    fail("CACHE_METADATA_UNAVAILABLE");
  }
  if (!metadata.isFile()) fail("CACHE_NOT_REGULAR");
  if (metadata.uid !== uid) fail("CACHE_OWNER_MISMATCH");
  if ((unixMode(metadata) & 0o022) !== 0) fail("CACHE_MODE_INVALID");
  if (
    !Number.isFinite(metadata.mtimeMs) ||
    metadata.mtimeMs < startedAt - CATALOG_CLOCK_SKEW_MS ||
    metadata.mtimeMs > endedAt + CATALOG_CLOCK_SKEW_MS
  ) {
    fail("CACHE_FILE_STALE");
  }

  let cache;
  try {
    cache = JSON.parse(fileSystem.readFileSync(cachePath, "utf8"));
  } catch {
    fail("CACHE_INVALID");
  }
  if (!cache || !Array.isArray(cache.models) || cache.models.length === 0) {
    fail("CACHE_INVALID");
  }
  if (cache.client_version !== cacheVersion) fail("CACHE_VERSION_MISMATCH");
  const fetchedAt = typeof cache.fetched_at === "string"
    ? Date.parse(cache.fetched_at)
    : Number.NaN;
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt < startedAt - CATALOG_CLOCK_SKEW_MS ||
    fetchedAt > endedAt + CATALOG_CLOCK_SKEW_MS
  ) {
    fail("CACHE_FETCH_STALE");
  }
  return cache;
}

function catalogSlugs(models, namespace) {
  const slugs = new Set();
  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      fail(`${namespace}_MODEL_INVALID`);
    }
    if (typeof model.slug !== "string" || !model.slug.trim()) {
      fail(`${namespace}_SLUG_INVALID`);
    }
    if (slugs.has(model.slug)) fail(`${namespace}_SLUG_DUPLICATE`);
    slugs.add(model.slug);
  }
  return slugs;
}

function validateListedModels(models) {
  for (const model of models) {
    if (typeof model.visibility !== "string" || !model.visibility.trim()) {
      fail("CATALOG_MODEL_INVALID");
    }
    if (model.visibility !== "list") continue;
    if (
      typeof model.base_instructions !== "string" ||
      !model.base_instructions.trim() ||
      typeof model.display_name !== "string" ||
      !model.display_name.trim() ||
      !Number.isInteger(model.priority)
    ) {
      fail("CATALOG_MODEL_INVALID");
    }
    const levels = model.supported_reasoning_levels;
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      levels.some(
        (level) =>
          !level ||
          typeof level !== "object" ||
          Array.isArray(level) ||
          typeof level.effort !== "string" ||
          !level.effort.trim() ||
          typeof level.description !== "string" ||
          !level.description.trim(),
      ) ||
      new Set(levels.map((level) => level.effort)).size !== levels.length ||
      typeof model.default_reasoning_level !== "string" ||
      !levels.some((level) => level.effort === model.default_reasoning_level)
    ) {
      fail("CATALOG_REASONING_INVALID");
    }
  }
}

function validateCatalog(candidate, cache, routedSlugs) {
  const candidateSlugs = catalogSlugs(candidate.models, "CATALOG");
  const cacheSlugs = catalogSlugs(cache.models, "CACHE");
  if (
    candidateSlugs.size !== cacheSlugs.size ||
    [...candidateSlugs].some((slug) => !cacheSlugs.has(slug))
  ) {
    fail("CATALOG_SLUG_MISMATCH");
  }
  if ([...candidateSlugs].some((slug) => routedSlugs.has(slug))) {
    fail("CATALOG_ROUTE_COLLISION");
  }
  validateListedModels(candidate.models);
}

function validateTemporaryAuth(authPath, tempAuthPath, fileSystem) {
  let metadata;
  let target;
  try {
    metadata = fileSystem.lstatSync(tempAuthPath);
    target = fileSystem.readlinkSync(tempAuthPath);
  } catch {
    fail("TEMP_AUTH_POSTFLIGHT_INVALID");
  }
  if (!metadata.isSymbolicLink() || target !== authPath) {
    fail("TEMP_AUTH_POSTFLIGHT_INVALID");
  }
}

function validateTemporaryHome(tempHome, uid, before, fileSystem) {
  let after;
  let resolvedPath;
  try {
    after = fileSystem.lstatSync(tempHome);
    resolvedPath = fileSystem.realpathSync(tempHome);
  } catch {
    fail("TEMP_HOME_POSTFLIGHT_CHANGED");
  }
  if (
    !after.isDirectory() ||
    resolvedPath !== before.resolvedPath ||
    after.dev !== before.metadata.dev ||
    after.ino !== before.metadata.ino ||
    after.uid !== uid ||
    unixMode(after) !== 0o700
  ) {
    fail("TEMP_HOME_POSTFLIGHT_CHANGED");
  }
}

function validateCanonicalAuth(authPath, uid, before, fileSystem) {
  let after;
  let actualPath;
  let expectedPath;
  try {
    after = fileSystem.lstatSync(authPath);
    actualPath = fileSystem.realpathSync(authPath);
    expectedPath = path.join(
      fileSystem.realpathSync(path.dirname(authPath)),
      path.basename(authPath),
    );
  } catch {
    fail("AUTH_POSTFLIGHT_CHANGED");
  }
  if (
    !after.isFile() ||
    actualPath !== expectedPath ||
    actualPath !== before.resolvedPath ||
    after.dev !== before.metadata.dev ||
    after.ino !== before.metadata.ino ||
    after.uid !== uid ||
    unixMode(after) !== 0o600
  ) {
    fail("AUTH_POSTFLIGHT_CHANGED");
  }
}

function cleanupGeneratedTree({
  authPath,
  tempAuthPath,
  tempHome,
  tempHomeSnapshot,
  uid,
  fileSystem,
  cleanup,
}) {
  validateTemporaryHome(tempHome, uid, tempHomeSnapshot, fileSystem);
  validateTemporaryAuth(authPath, tempAuthPath, fileSystem);
  try {
    cleanup.unlink(tempAuthPath);
  } catch {
    fail("CLEANUP_UNLINK_FAILED");
  }
  // Revalidate the root immediately before the recursive operation. The
  // expected auth link is already gone, so rm cannot follow it.
  validateTemporaryHome(tempHome, uid, tempHomeSnapshot, fileSystem);
  try {
    cleanup.removeTree(tempHome, { recursive: true, force: true });
  } catch {
    fail("CLEANUP_REMOVE_FAILED");
  }
}

export function acquireNativeCatalog({
  authPath,
  stateDir,
  codexBinary,
  routedSlugs = new Set(),
  uid = process.geteuid(),
  now = Date.now,
  env = process.env,
  runner = spawnSync,
  fileSystem: fileSystemOverrides = {},
  cleanup: cleanupOverrides = {},
}) {
  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...fileSystemOverrides };
  const cleanup = {
    unlink: fileSystem.unlinkSync,
    removeTree: fileSystem.rmSync,
    ...cleanupOverrides,
  };
  const authSnapshot = authPreflight(authPath, uid, fileSystem);
  if (!authSnapshot) return { status: "skipped", reason: "signed-out" };

  fileSystem.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tempHome = fileSystem.mkdtempSync(path.join(stateDir, "native-catalog-"));
  fileSystem.chmodSync(tempHome, 0o700);
  const tempMetadata = fileSystem.lstatSync(tempHome);
  if (!tempMetadata.isDirectory() || tempMetadata.uid !== uid || unixMode(tempMetadata) !== 0o700) {
    fail("TEMP_HOME_INVALID");
  }
  let tempResolvedPath;
  try {
    tempResolvedPath = fileSystem.realpathSync(tempHome);
  } catch {
    fail("TEMP_HOME_INVALID");
  }
  const tempHomeSnapshot = {
    metadata: tempMetadata,
    resolvedPath: tempResolvedPath,
  };

  const tempAuthPath = path.join(tempHome, "auth.json");
  fileSystem.symlinkSync(authPath, tempAuthPath);
  let pendingError;
  let candidate;
  let attestation;
  let clientVersion;
  let cacheVersion;
  try {
    const isolatedEnvironment = childEnvironment(env, tempHome);
    let versionChild;
    try {
      versionChild = runner(codexBinary, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: isolatedEnvironment,
        cwd: tempHome,
      });
    } catch {
      fail("VERSION_FAILED");
    }
    ({ clientVersion, cacheVersion } = parseClientVersion(versionChild));

    const startedAt = now();
    let endedAt = startedAt;
    let child;
    try {
      child = runner(
        codexBinary,
        ["-c", 'cli_auth_credentials_store="file"', "debug", "models"],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
          env: isolatedEnvironment,
          cwd: tempHome,
        },
      );
    } catch {
      fail("CHILD_FAILED");
    } finally {
      endedAt = now();
    }
    if (child?.status !== 0) fail("CHILD_FAILED");
    if (typeof child.stderr === "string" && child.stderr.length > 0) fail("CHILD_STDERR");
    candidate = parseCandidate(child?.stdout);
    const cache = parseCache(
      path.join(tempHome, "models_cache.json"),
      { cacheVersion, uid, startedAt, endedAt },
      fileSystem,
    );
    validateCatalog(candidate, cache, routedSlugs);
    attestation = {
      fetchedAt: cache.fetched_at,
      ...(typeof cache.etag === "string" && cache.etag.length > 0
        ? { etag: cache.etag }
        : {}),
    };
  } catch (error) {
    pendingError = error instanceof NativeCatalogRefreshError
      ? error
      : new NativeCatalogRefreshError("ACQUISITION_FAILED");
  }

  validateTemporaryHome(tempHome, uid, tempHomeSnapshot, fileSystem);
  validateTemporaryAuth(authPath, tempAuthPath, fileSystem);
  try {
    validateCanonicalAuth(authPath, uid, authSnapshot, fileSystem);
  } catch (error) {
    cleanupGeneratedTree({
      authPath,
      tempAuthPath,
      tempHome,
      tempHomeSnapshot,
      uid,
      fileSystem,
      cleanup,
    });
    throw error;
  }
  cleanupGeneratedTree({
    authPath,
    tempAuthPath,
    tempHome,
    tempHomeSnapshot,
    uid,
    fileSystem,
    cleanup,
  });
  if (pendingError) throw pendingError;
  return { status: "acquired", candidate, attestation, clientVersion };
}
