import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {}
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function readNumber(filePath) {
  try {
    return Number(fs.readFileSync(filePath, 'utf8').trim() || 0);
  } catch {
    return 0;
  }
}

function writeNumber(filePath, value) {
  fs.writeFileSync(filePath, String(value), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

async function acquireLock(lockPath, { staleMs = 30000, retryMs = 100 } = {}) {
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      return () => {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) fs.unlinkSync(lockPath);
      } catch {}
      await sleep(retryMs);
    }
  }
}

export class SendRateLimiter {
  constructor({
    enabled = true,
    minIntervalMs = 0,
    stateDir = path.join(os.homedir(), '.telegram-codex-bridge', 'rate-limit'),
    log = () => {},
  } = {}) {
    this.enabled = Boolean(enabled) && Number(minIntervalMs) > 0;
    this.minIntervalMs = Number(minIntervalMs || 0);
    this.stateDir = stateDir;
    this.log = log;
    if (this.enabled) ensureDir(this.stateDir);
  }

  async run(chatId, send, { shouldSend } = {}) {
    if (!this.enabled) return send();

    const key = safeName(chatId);
    const lockPath = path.join(this.stateDir, `${key}.lock`);
    const statePath = path.join(this.stateDir, `${key}.last-send`);
    const release = await acquireLock(lockPath);
    try {
      const lastSend = readNumber(statePath);
      const waitMs = Math.max(0, lastSend + this.minIntervalMs - Date.now());
      if (waitMs > 0) {
        this.log(`rate limit wait chat=${chatId} wait_ms=${waitMs}`);
        await sleep(waitMs);
      }
      if (shouldSend && !shouldSend()) return { skipped: true };
      const result = await send();
      writeNumber(statePath, Date.now());
      return result;
    } finally {
      release();
    }
  }
}
