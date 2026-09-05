import fs from "node:fs";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";

const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 64 * 1024;
const MAX_ACCOUNT_ID_BYTES = 256;
const EXPIRY_SKEW_MS = 120_000;
const SUPPORTED_REQUEST_AUTH_PLATFORMS = new Set(["darwin", "linux", "freebsd"]);

function identityError() {
  return new Error("ChatGPT identity attestation required.");
}

function protectedSessionError() {
  return new Error("Protected ChatGPT session descriptor unavailable.");
}

function currentUserOwns(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function ownerOnlyDirectory(stat) {
  return process.platform === "win32" || (stat.mode & 0o077) === 0;
}

function sameFileIdentity(left, right) {
  return Boolean(left)
    && Boolean(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.isFile() === right.isFile();
}

function sourceIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function readProtectedAuthDocument(codexHome) {
  if (typeof codexHome !== "string" || !path.isAbsolute(codexHome)) {
    throw protectedSessionError();
  }
  const home = path.resolve(codexHome);
  const authPath = path.join(home, "auth.json");
  let descriptor;
  try {
    ensureNoSymlinkParents(home, { label: "ChatGPT account profile" });
    const homeStat = fs.lstatSync(home);
    if (
      homeStat.isSymbolicLink()
      || !homeStat.isDirectory()
      || !currentUserOwns(homeStat)
      || !ownerOnlyDirectory(homeStat)
    ) throw protectedSessionError();

    const before = fs.lstatSync(authPath);
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.size < 1
      || before.size > MAX_AUTH_BYTES
      || !currentUserOwns(before)
      || !privateFileIsProtected(authPath)
    ) throw protectedSessionError();

    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(authPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.size < 1
      || opened.size > MAX_AUTH_BYTES
      || !currentUserOwns(opened)
      || !sameFileIdentity(before, opened)
    ) throw protectedSessionError();

    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (bytesRead <= 0) throw protectedSessionError();
      offset += bytesRead;
    }

    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(authPath);
    if (
      !sameFileIdentity(opened, afterDescriptor)
      || !sameFileIdentity(before, afterPath)
      || !privateFileIsProtected(authPath)
    ) throw protectedSessionError();

    let parsed;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch {
      throw protectedSessionError();
    }
    return { parsed, sourceIdentity: sourceIdentity(opened) };
  } catch (error) {
    if (error?.message === "Protected ChatGPT session descriptor unavailable.") throw error;
    throw protectedSessionError();
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function chatGPTAccountRequestAuthSupported(platform = process.platform) {
  return SUPPORTED_REQUEST_AUTH_PLATFORMS.has(platform) && !discoveryDisabled();
}

function protectedSession(codexHome) {
  if (!chatGPTAccountRequestAuthSupported(process.platform)) throw protectedSessionError();
  const { parsed, sourceIdentity: identity } = readProtectedAuthDocument(codexHome);
  if (parsed?.auth_mode === "apikey") {
    return { authKind: "apikey", accountId: undefined, expired: false, sourceIdentity: identity };
  }
  if (parsed?.auth_mode !== "chatgpt") throw protectedSessionError();
  const accessToken = parsed?.tokens?.access_token;
  const accountId = parsed?.tokens?.account_id;
  if (
    typeof accessToken !== "string"
    || accessToken.length < 1
    || Buffer.byteLength(accessToken) > MAX_ACCESS_TOKEN_BYTES
    || /[\u0000-\u001f\u007f]/.test(accessToken)
    || typeof accountId !== "string"
    || accountId.length < 1
    || Buffer.byteLength(accountId) > MAX_ACCOUNT_ID_BYTES
    || accountId.trim() !== accountId
    || /[\u0000-\u001f\u007f]/.test(accountId)
  ) throw protectedSessionError();
  const expiresAtMs = tokenExpiryMs(accessToken);
  if (expiresAtMs === undefined) throw protectedSessionError();
  return {
    authKind: "chatgpt",
    accountId,
    accessToken,
    expired: expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= Date.now(),
    sourceIdentity: identity,
  };
}

export async function readProtectedChatGPTSessionDescriptor(codexHome) {
  const { authKind, accountId, expired, sourceIdentity: identity } = protectedSession(codexHome);
  return { authKind, accountId, expired, sourceIdentity: identity };
}

export async function attestChatGPTAccount({ codexHome, expectedAccountId } = {}) {
  try {
    const descriptor = protectedSession(codexHome);
    if (
      descriptor.authKind !== "chatgpt"
      || descriptor.expired
      || typeof expectedAccountId !== "string"
      || descriptor.accountId !== expectedAccountId
    ) throw identityError();
    return { accountId: descriptor.accountId, sourceIdentity: descriptor.sourceIdentity };
  } catch {
    throw identityError();
  }
}

export async function snapshotChatGPTRequestAuth({ codexHome, expectedAccountId } = {}) {
  try {
    const descriptor = protectedSession(codexHome);
    if (
      descriptor.authKind !== "chatgpt"
      || descriptor.expired
      || typeof expectedAccountId !== "string"
      || descriptor.accountId !== expectedAccountId
    ) throw identityError();
    return {
      headers: {
        authorization: `Bearer ${descriptor.accessToken}`,
        "chatgpt-account-id": descriptor.accountId,
      },
      accountId: descriptor.accountId,
      sourceIdentity: descriptor.sourceIdentity,
    };
  } catch {
    throw identityError();
  }
}
