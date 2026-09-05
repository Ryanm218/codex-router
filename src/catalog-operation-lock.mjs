import { mkdirSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { STATE_DIR } from "./paths.mjs";

// Safe acquisition performs a 10-second version probe followed by the
// 30-second model request. A waiting writer gets another five seconds for
// process scheduling and lock handoff before reporting a stable retry error.
export const CATALOG_ACQUISITION_TIMEOUT_MS = 10_000 + 30_000;
const DEFAULT_WAIT_MS = CATALOG_ACQUISITION_TIMEOUT_MS + 5_000;
const DEFAULT_RETRY_MS = 100;
const DEFAULT_STALE_MS = 120_000;
const DEFAULT_UPDATE_MS = 10_000;

export async function withCatalogOperationLock(
  operation,
  {
    stateDir = STATE_DIR,
    waitMs = DEFAULT_WAIT_MS,
    retryMs = DEFAULT_RETRY_MS,
    staleMs = DEFAULT_STALE_MS,
    updateMs = DEFAULT_UPDATE_MS,
    mkdir = mkdirSync,
    lock = lockfile.lock,
  } = {},
) {
  mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, "catalog-operation");
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  let release;
  try {
    release = await lock(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      waitMs,
      stale: staleMs,
      update: updateMs,
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
      const retryError = new Error(
        "Another catalog operation is still running; retry shortly.",
        { cause: error },
      );
      retryError.code = "catalog_operation_locked";
      throw retryError;
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    await release();
  }
}
