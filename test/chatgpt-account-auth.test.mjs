import assert from "node:assert/strict";
import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const MODULE_URL = new URL("../src/chatgpt-account-auth.mjs", import.meta.url);
const MAX_AUTH_BYTES = 1024 * 1024;
const SECRET = `header.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.sig`;

function fixture(document, { mode = 0o600 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-account-auth-"));
  const codexHome = path.join(root, "profile");
  mkdirSync(codexHome, { mode: 0o700 });
  const authPath = path.join(codexHome, "auth.json");
  writeFileSync(authPath, JSON.stringify(document), { mode });
  chmodSync(authPath, mode);
  return { root, codexHome, authPath };
}

function chatGPTAuth({ accountId = "chatgpt-account-a", accessToken = SECRET } = {}) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken,
      account_id: accountId,
      refresh_token: "synthetic-refresh-secret-never-report",
    },
  };
}

async function authModule() {
  return import(MODULE_URL);
}

test("protected ChatGPT identity attestation never returns credential material", async () => {
  const options = fixture(chatGPTAuth());
  try {
    const {
      attestChatGPTAccount,
      readProtectedChatGPTSessionDescriptor,
      snapshotChatGPTRequestAuth,
    } = await authModule();
    const descriptor = await readProtectedChatGPTSessionDescriptor(options.codexHome);
    assert.equal(descriptor.authKind, "chatgpt");
    assert.equal(descriptor.accountId, "chatgpt-account-a");
    assert.deepEqual(Object.keys(descriptor).sort(), ["accountId", "authKind", "expired", "sourceIdentity"]);
    assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(SECRET));

    const attestation = await attestChatGPTAccount({
      codexHome: options.codexHome,
      expectedAccountId: "chatgpt-account-a",
    });
    assert.deepEqual(Object.keys(attestation).sort(), ["accountId", "sourceIdentity"]);
    assert.doesNotMatch(JSON.stringify(attestation), new RegExp(SECRET));

    const snapshot = await snapshotChatGPTRequestAuth({
      codexHome: options.codexHome,
      expectedAccountId: "chatgpt-account-a",
    });
    assert.deepEqual(Object.keys(snapshot).sort(), ["accountId", "headers", "sourceIdentity"]);
    assert.deepEqual(snapshot.headers, {
      authorization: `Bearer ${SECRET}`,
      "chatgpt-account-id": "chatgpt-account-a",
    });
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("API-key native descriptors cannot attest a ChatGPT account", async () => {
  const apiKey = "synthetic-api-key-never-report";
  const options = fixture({ auth_mode: "apikey", OPENAI_API_KEY: apiKey });
  try {
    const { attestChatGPTAccount } = await authModule();
    await assert.rejects(
      attestChatGPTAccount({ codexHome: options.codexHome, expectedAccountId: "chatgpt-account-a" }),
      (error) => /chatgpt identity attestation required/i.test(error.message)
        && !error.message.includes(apiKey),
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("exact ChatGPT account mismatch fails without exposing either credential", async () => {
  const options = fixture(chatGPTAuth());
  try {
    const { snapshotChatGPTRequestAuth } = await authModule();
    await assert.rejects(
      snapshotChatGPTRequestAuth({ codexHome: options.codexHome, expectedAccountId: "chatgpt-account-b" }),
      (error) => /chatgpt identity attestation required/i.test(error.message)
        && !error.message.includes(SECRET),
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("a ChatGPT token without a numeric expiry cannot attest", async () => {
  const options = fixture(chatGPTAuth({ accessToken: "synthetic-token-without-expiry" }));
  try {
    const { attestChatGPTAccount } = await authModule();
    await assert.rejects(
      attestChatGPTAccount({ codexHome: options.codexHome, expectedAccountId: "chatgpt-account-a" }),
      /chatgpt identity attestation required/i,
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});

test("discovery-disabled account auth fails before profile filesystem access", async (t) => {
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY;
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  let inspected = false;
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, "lstatSync", function (...args) {
    inspected = true;
    return originalLstatSync.apply(this, args);
  });
  try {
    const { attestChatGPTAccount } = await authModule();
    await assert.rejects(
      attestChatGPTAccount({
        codexHome: path.join(os.tmpdir(), "must-not-be-read"),
        expectedAccountId: "chatgpt-account-a",
      }),
      /chatgpt identity attestation required/i,
    );
    assert.equal(inspected, false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previous;
  }
});

test("Windows account auth is explicit-switch-only and cannot be overridden by callers", { concurrency: false }, async (t) => {
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  let inspected = false;
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, "lstatSync", function (...args) {
    inspected = true;
    return originalLstatSync.apply(this, args);
  });
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const { attestChatGPTAccount, chatGPTAccountRequestAuthSupported } = await authModule();
    assert.equal(chatGPTAccountRequestAuthSupported("win32"), false);
    await assert.rejects(
      attestChatGPTAccount({
        codexHome: path.join(os.tmpdir(), "must-not-be-read"),
        expectedAccountId: "chatgpt-account-a",
        platform: "darwin",
      }),
      /chatgpt identity attestation required/i,
    );
    assert.equal(inspected, false);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (previous === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previous;
  }
});

test("unsupported non-Windows platforms fail before filesystem access", { concurrency: false }, async (t) => {
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  let inspected = false;
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, "lstatSync", function (...args) {
    inspected = true;
    return originalLstatSync.apply(this, args);
  });
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "sunos" });
    const { attestChatGPTAccount, chatGPTAccountRequestAuthSupported } = await authModule();
    assert.equal(chatGPTAccountRequestAuthSupported("sunos"), false);
    await assert.rejects(
      attestChatGPTAccount({
        codexHome: path.join(os.tmpdir(), "must-not-be-read"),
        expectedAccountId: "chatgpt-account-a",
      }),
      /chatgpt identity attestation required/i,
    );
    assert.equal(inspected, false);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (previous === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previous;
  }
});

test("a group-readable auth file cannot attest", async () => {
  if (process.platform === "win32") return;
  const { attestChatGPTAccount } = await authModule();
  const unsafe = fixture(chatGPTAuth(), { mode: 0o644 });
  try {
    await assert.rejects(
      attestChatGPTAccount({ codexHome: unsafe.codexHome, expectedAccountId: "chatgpt-account-a" }),
      /chatgpt identity attestation required/i,
    );
  } finally {
    rmSync(unsafe.root, { recursive: true, force: true });
  }
});

test("a valid auth document over the one-megabyte bound cannot attest", async () => {
  const { attestChatGPTAccount } = await authModule();
  const oversizedDocument = { ...chatGPTAuth(), padding: "x".repeat(MAX_AUTH_BYTES) };
  const oversized = fixture(oversizedDocument);
  try {
    await assert.rejects(
      attestChatGPTAccount({ codexHome: oversized.codexHome, expectedAccountId: "chatgpt-account-a" }),
      /chatgpt identity attestation required/i,
    );
  } finally {
    rmSync(oversized.root, { recursive: true, force: true });
  }
});

test("a symlinked auth file cannot attest", async () => {
  if (process.platform === "win32") return;
  const { attestChatGPTAccount } = await authModule();
  const linked = fixture(chatGPTAuth());
  try {
    const external = path.join(linked.root, "external-auth.json");
    renameSync(linked.authPath, external);
    symlinkSync(external, linked.authPath);
    await assert.rejects(
      attestChatGPTAccount({ codexHome: linked.codexHome, expectedAccountId: "chatgpt-account-a" }),
      /chatgpt identity attestation required/i,
    );
  } finally {
    rmSync(linked.root, { recursive: true, force: true });
  }
});

test("a protected auth file replaced during its read cannot attest", async (t) => {
  const options = fixture(chatGPTAuth());
  const replacement = `${options.authPath}.replacement`;
  writeFileSync(replacement, JSON.stringify(chatGPTAuth()), { mode: 0o600 });
  let replaced = false;
  const originalReadSync = fs.readSync;
  t.mock.method(fs, "readSync", function (...args) {
    const bytesRead = originalReadSync.apply(this, args);
    if (!replaced) {
      replaced = true;
      renameSync(options.authPath, `${options.authPath}.before`);
      renameSync(replacement, options.authPath);
      chmodSync(options.authPath, 0o600);
    }
    return bytesRead;
  });
  try {
    const { attestChatGPTAccount } = await authModule();
    await assert.rejects(
      attestChatGPTAccount({ codexHome: options.codexHome, expectedAccountId: "chatgpt-account-a" }),
      /chatgpt identity attestation required/i,
    );
  } finally {
    rmSync(options.root, { recursive: true, force: true });
  }
});
