// Codex Desktop thread metadata sync.
//
// Threads created by a headless `codex app-server` (which is what this bridge
// drives) do show up in Codex Desktop's sidebar, but with a machine-generated
// title and the raw prompt as the preview, and they sink to the bottom of the
// recency list. This module rewrites that row so a human can find the bridge
// thread in Desktop and read it like any other conversation.
//
// Implementation notes:
//   - Uses the system `sqlite3` CLI instead of a native binding, to keep the
//     project dependency-free and avoid node-gyp rebuilds across Node versions.
//   - `execFileSync` does not expand `~`, so paths go through os.homedir().
//   - User-supplied text is encoded as a hex blob and CAST back to TEXT, so it
//     never passes through the sqlite dot-command parser.
//
// This pokes at Codex's own local state database. It is best-effort by design:
// every failure path degrades to "the Desktop row just isn't prettied up".
// If a Codex release changes that schema, the column probe below disables the
// sync instead of writing garbage.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
const SQLITE_BIN = '/usr/bin/sqlite3';
const SQLITE_BUSY_TIMEOUT_MS = 2000;

const REQUIRED_COLUMNS = ['id', 'title', 'preview', 'cwd', 'updated_at_ms', 'recency_at', 'recency_at_ms'];

let schemaChecked = false;
let schemaOk = false;

/** SQL text literal with no user-controlled parser metacharacters. */
export function sqlText(value) {
  const hex = Buffer.from(String(value ?? ''), 'utf8').toString('hex');
  return `CAST(X'${hex}' AS TEXT)`;
}

export function buildDesktopMetadataSql({ threadId, title, preview, cwd, nowMs = Date.now() }) {
  const nowSec = Math.floor(nowMs / 1000);
  return [
    `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`,
    'UPDATE threads',
    `  SET title = ${sqlText(title)},`,
    `      preview = ${sqlText(preview)},`,
    `      cwd = ${sqlText(cwd)},`,
    `      updated_at_ms = ${nowMs},`,
    `      recency_at_ms = ${nowMs},`,
    `      recency_at = ${nowSec}`,
    `WHERE id = ${sqlText(threadId)};`,
  ].join('\n');
}

function processFailure(error) {
  const code = error?.status ?? error?.code ?? 'unknown';
  const signal = error?.signal ? ` signal=${error.signal}` : '';
  return `exit=${code}${signal}`;
}

/** Probe the threads table once; cache the verdict for the process lifetime. */
function ensureSchema(log) {
  if (schemaChecked) return schemaOk;
  schemaChecked = true;
  try {
    const out = execFileSync(SQLITE_BIN, [STATE_DB, '-bail', 'PRAGMA table_info(threads);'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cols = out.split('\n').map((l) => l.split('|')[1]).filter(Boolean);
    const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
    if (missing.length) {
      log?.(`desktop-sync: threads table is missing ${missing.join(',')}; sync skipped`);
      return false;
    }
    schemaOk = true;
    return true;
  } catch (error) {
    // Locking/startup races are transient; allow the next message to probe again.
    schemaChecked = false;
    log?.(`desktop-sync: could not probe state db ${processFailure(error)}`);
    return false;
  }
}

/** Microsecond-precision ISO string (matches the existing session_index.jsonl format). */
function isoMicros(date = new Date()) {
  const base = date.toISOString().replace('Z', '');
  return `${base}000Z`;
}

/**
 * Give a Codex thread a readable row in the Desktop sidebar.
 *
 * @param {object} args
 * @param {string} args.threadId   thread id to sync (required)
 * @param {string} args.title      display title (e.g. "Codex via Telegram")
 * @param {string} args.preview    latest message preview (e.g. "[private] alice: hi")
 * @param {string} args.cwd        working directory (same cwd the app-server runs with)
 * @param {function} [args.log]    optional logger
 */
export function syncDesktopMetadata({ threadId, title, preview, cwd, log }) {
  if (!threadId) return;
  if (!ensureSchema(log)) return;

  const nowMs = Date.now();
  const sql = buildDesktopMetadataSql({ threadId, title, preview, cwd, nowMs });

  try {
    execFileSync(SQLITE_BIN, [STATE_DB, '-bail'], {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // sqlite can echo its stdin on parser failures; never put stderr/error.message
    // into a world-readable process log because preview contains private chat text.
    log?.(`desktop-sync: UPDATE threads failed ${processFailure(error)}`);
    return;
  }

  // session_index.jsonl: append one record (mode 0600 to prevent permission drift).
  try {
    const entry = JSON.stringify({
      id: threadId,
      thread_name: title,
      updated_at: isoMicros(new Date(nowMs)),
    });
    fs.appendFileSync(SESSION_INDEX, `${entry}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(SESSION_INDEX, 0o600);
  } catch (error) {
    log?.(`desktop-sync: session_index.jsonl append failed ${processFailure(error)}`);
  }
}

/** Locate the rollout file backing a thread id. */
export function findRolloutPath(threadId) {
  if (!threadId) return null;
  const sessionsDir = path.join(CODEX_HOME, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  const stack = [sessionsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return full;
    }
  }
  return null;
}
