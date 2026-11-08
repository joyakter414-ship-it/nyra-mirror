// Keeps dual WhatsApp linked-device sessions in Cloudflare R2, encrypted with SESSION_SECRET.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { brain } from "./brain.js";

const BASE_AUTH_DIR = process.env.AUTH_DIR || "./auth";
const SECRET = process.env.SESSION_SECRET || "default_nyra_session_secret_32chars_long_minimum!";
const KEY = createHash("sha256").update(SECRET).digest();

export function getAuthDir(accountId) {
  return join(BASE_AUTH_DIR, accountId);
}

function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decrypt(blob) {
  const decipher = createDecipheriv("aes-256-gcm", KEY, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

export async function restoreSession(accountId, log) {
  const dir = getAuthDir(accountId);
  if (existsSync(join(dir, "creds.json"))) return true;

  try {
    const blob = await brain("GET", `/api/gateway/session?account=${accountId}`, { raw: true });
    if (!blob) return false;

    const files = JSON.parse(gunzipSync(decrypt(blob)).toString("utf8"));
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content))
    );
    log.info(`[${accountId}] Restored WhatsApp session from R2 (${Object.keys(files).length} files).`);
    return true;
  } catch (err) {
    log.warn(`[${accountId}] Remote session not found or decrypt failed. Fresh scan needed.`);
    return false;
  }
}

const timers = new Map();
const firstDirtyTimes = new Map();
let running = Promise.resolve();

export function backupNow(accountId, log) {
  const timer = timers.get(accountId);
  if (timer) clearTimeout(timer);
  timers.delete(accountId);
  firstDirtyTimes.delete(accountId);

  const dir = getAuthDir(accountId);
  running = running.then(async () => {
    if (!existsSync(join(dir, "creds.json"))) return;
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const files = {};
    await Promise.all(
      names.map(async (n) => {
        files[n] = await readFile(join(dir, n), "utf8");
      })
    );
    await brain("POST", `/api/gateway/session?account=${accountId}`, {
      body: encrypt(gzipSync(JSON.stringify(files))),
    });
    log.debug(`[${accountId}] Session backed up to R2 (${names.length} files).`);
  }).catch((err) => log.error(`[${accountId}] Session backup failed: ${err.message}`));

  return running;
}

export function scheduleBackup(accountId, log) {
  const now = Date.now();
  if (!firstDirtyTimes.has(accountId)) firstDirtyTimes.set(accountId, now);
  const first = firstDirtyTimes.get(accountId);

  const timer = timers.get(accountId);
  if (timer) clearTimeout(timer);

  const wait = Math.max(0, Math.min(5000, first + 30000 - now));
  timers.set(
    accountId,
    setTimeout(() => backupNow(accountId, log), wait)
  );
}

export async function wipeSession(accountId, log) {
  const timer = timers.get(accountId);
  if (timer) clearTimeout(timer);
  timers.delete(accountId);
  firstDirtyTimes.delete(accountId);

  const dir = getAuthDir(accountId);
  await rm(dir, { recursive: true, force: true });
  await brain("DELETE", `/api/gateway/session?account=${accountId}`).catch(() => {});
}
