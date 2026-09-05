import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createRefreshHarness(t, {
  platform = "Darwin",
  controlStatus = 0,
  controlOutput = '{"status":"updated","nativeModels":9}',
} = {}) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "refresh-catalog-script-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const binDir = path.join(fixtureRoot, "bin");
  const fakeBinDir = path.join(fixtureRoot, "fake-bin");
  const tracePath = path.join(fixtureRoot, "trace.log");
  mkdirSync(binDir);
  mkdirSync(fakeBinDir);
  writeFileSync(tracePath, "");

  const refreshPath = path.join(binDir, "refresh-catalog");
  copyFileSync(path.join(root, "bin", "refresh-catalog"), refreshPath);
  chmodSync(refreshPath, 0o755);

  const controlPath = path.join(binDir, "control");
  writeFileSync(
    controlPath,
    `#!/bin/sh
printf 'control:%s\n' "$*" >> "$TRACE_PATH"
if [ "$CONTROL_STATUS" -ne 0 ]; then
  printf '%s\n' 'RAW_CONTROL_FAILURE_SENTINEL' >&2
  exit "$CONTROL_STATUS"
fi
printf '%s\n' "$CONTROL_OUTPUT"
`,
  );
  chmodSync(controlPath, 0o755);

  const unamePath = path.join(fakeBinDir, "uname");
  writeFileSync(unamePath, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_UNAME_PLATFORM\"\n");
  chmodSync(unamePath, 0o755);

  const nodePath = path.join(fakeBinDir, "node");
  writeFileSync(
    nodePath,
    `#!/bin/sh
printf 'node:%s\n' "$*" >> "$TRACE_PATH"
exit 97
`,
  );
  chmodSync(nodePath, 0o755);

  const run = () => spawnSync(refreshPath, [], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: {
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
      TRACE_PATH: tracePath,
      FAKE_UNAME_PLATFORM: platform,
      CONTROL_STATUS: String(controlStatus),
      CONTROL_OUTPUT: controlOutput,
    },
  });
  const trace = () => readFileSync(tracePath, "utf8");
  return { run, trace };
}

for (const [status, nativeModels, message] of [
  ["updated", 9, "Model catalog refreshed for the next Codex launch.\n"],
  ["unchanged", 8, "Model catalog is already current.\n"],
  ["skipped", 0, "Model catalog refresh skipped because Codex is signed out.\n"],
]) {
  test(`macOS refresh preserves the narrow ${status} result and emits fixed copy`, (t) => {
    const harness = createRefreshHarness(t, {
      controlOutput: JSON.stringify({ status, nativeModels }),
    });

    const result = harness.run();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, message);
    assert.equal(result.stderr, "");
    assert.equal(harness.trace(), "control:catalog-refresh\n");
  });
}

test("a failed safe refresh emits only fixed failure copy", (t) => {
  const harness = createRefreshHarness(t, { controlStatus: 23 });

  const result = harness.run();

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Catalog refresh failed; the previous catalog remains active.\n",
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RAW_CONTROL_FAILURE_SENTINEL/);
  assert.equal(harness.trace(), "control:catalog-refresh\n");
});

for (const [name, controlOutput] of [
  ["invalid JSON", "RAW_INVALID_CONTROL_RESULT_SENTINEL"],
  ["an unknown status", '{"status":"other","nativeModels":9}'],
  ["an extra field", '{"status":"updated","nativeModels":9,"extra":true}'],
  ["a negative count", '{"status":"updated","nativeModels":-1}'],
  ["a non-integer count", '{"status":"updated","nativeModels":1.5}'],
]) {
  test(`macOS refresh rejects ${name} without rendering control output`, (t) => {
    const harness = createRefreshHarness(t, { controlOutput });

    const result = harness.run();

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Catalog refresh failed; the previous catalog remains active.\n",
    );
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RAW_INVALID_CONTROL_RESULT_SENTINEL/);
    assert.equal(harness.trace(), "control:catalog-refresh\n");
  });
}

test("unsupported platforms fail with manual refresh guidance", (t) => {
  const harness = createRefreshHarness(t, { platform: "Linux" });

  const result = harness.run();

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /supported only on macOS/i);
  assert.match(result.stderr, /refresh.*Codex.*catalog/i);
  assert.equal(harness.trace(), "");
});
