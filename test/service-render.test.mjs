import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function render(script, platform, testRoot, target = "codex", sourceRoot = root, extraEnv = {}) {
  const nodeArgs = sourceRoot === root ? [] : ["--preserve-symlinks", "--preserve-symlinks-main"];
  return execFileSync(process.execPath, [...nodeArgs, path.join(sourceRoot, "src", script), "render"], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: path.join(testRoot, "codex home"),
      CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
      MODEL_ROUTER_STATE_DIR: path.join(testRoot, `${target} router state`),
      MODEL_ROUTER_TARGET: target,
      CODEX_ROUTER_SERVICE_PLATFORM: platform,
      XDG_CONFIG_HOME: path.join(testRoot, "xdg config"),
      // A regional Kimi override must be an explicit, allowlisted opt-in,
      // never an accident of the machine running the test.
      KIMI_API_BASE_URL: "",
      ...extraEnv,
    },
  });
}

test("background service definitions render for macOS, Linux, and Windows", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-services-"));
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot);
    assert.match(launchd, /<string>io\.github\.codex-router<\/string>/);
    assert.match(launchd, /CODEX_ROUTER_STATE_DIR/);

    const systemd = render("service-linux.mjs", "linux", testRoot);
    assert.match(systemd, /\[Service\]/);
    assert.match(systemd, /ExecStart=/);
    assert.match(systemd, /Environment="CODEX_ROUTER_STATE_DIR=/);

    const windows = render("service-windows.mjs", "win32", testRoot);
    assert.match(windows, /@echo off\r?\n/);
    assert.match(windows, /set "CODEX_ROUTER_STATE_DIR=/);
    assert.match(windows, /litellm|start\.mjs/);
    // The Python gateway must run with UTF-8 output even when the host
    // console code page is not UTF-8 (see service-windows.mjs).
    assert.match(windows, /set "PYTHONIOENCODING=utf-8"/);
    assert.match(windows, /set "PYTHONUTF8=1"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("KIMI_API_BASE_URL propagates to every background service, and only when explicitly set", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-kimi-endpoint-"));
  const override = "https://regional.invalid/v1";
  const withOverride = { KIMI_API_BASE_URL: override };
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot, "codex", root, withOverride);
    const systemd = render("service-linux.mjs", "linux", testRoot, "codex", root, withOverride);
    const windows = render("service-windows.mjs", "win32", testRoot, "codex", root, withOverride);
    const tray = render("tray-service-macos.mjs", "darwin", testRoot, "codex", root, withOverride);
    assert.ok(launchd.includes(override), "macOS router service must carry the regional override");
    assert.ok(systemd.includes(override), "Linux router service must carry the regional override");
    assert.ok(windows.includes(override), "Windows router service must carry the regional override");
    assert.ok(tray.includes(override), "macOS tray agent must carry the regional override");

    // No override configured: the variable must be entirely absent, not an
    // empty string -- an unset env var and an empty allowlisted one must
    // behave identically for every renderer.
    assert.doesNotMatch(render("service-macos.mjs", "darwin", testRoot), /KIMI_API_BASE_URL/);
    assert.doesNotMatch(render("service-linux.mjs", "linux", testRoot), /KIMI_API_BASE_URL/);
    assert.doesNotMatch(render("service-windows.mjs", "win32", testRoot), /KIMI_API_BASE_URL/);
    assert.doesNotMatch(render("tray-service-macos.mjs", "darwin", testRoot), /KIMI_API_BASE_URL/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test(
  "systemd WorkingDirectory is unquoted and escapes literal specifiers",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-systemd-path-"));
    const linkedRoot = path.join(testRoot, "router %u");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const systemd = render("service-linux.mjs", "linux", testRoot, "codex", linkedRoot);
      const workingDirectory = systemd
        .split(/\r?\n/)
        .find((line) => line.startsWith("WorkingDirectory="));
      assert.equal(
        workingDirectory,
        `WorkingDirectory=${linkedRoot.replaceAll("%", "%%")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
