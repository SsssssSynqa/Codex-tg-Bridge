#!/usr/bin/env node

// Telegram <-> Codex bridge.
//
// One Telegram bot, one persistent Codex thread. Private chats, group chats,
// and (in daemon mode) a `codex --remote` terminal session all talk to the
// same thread, so the conversation is continuous no matter where it happens.
//
// The pieces that are easy to miss when reading top to bottom:
//   - Durable inbox: every Telegram update is fsync'd before the poll offset
//     advances, so a crash replays instead of dropping messages.
//   - Delta group context: each (chat, thread) pair remembers the last message
//     id it has already seen, and only newer messages are sent as context.
//   - Approval forwarding: requests that are neither clearly safe nor clearly
//     dangerous become a Telegram card with Approve/Decline buttons.
//   - Desktop sync (opt-in): rewrites the thread's row in the Codex Desktop
//     sidebar so a bridge conversation is findable there.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexAppClient } from './codex-client.mjs';
import { CodexDaemonClient } from './codex-daemon-client.mjs';
import { syncDesktopMetadata } from './desktop-sync.mjs';
import { deliverDurablePrivateReply, DurableUpdateInbox } from './durable-update-inbox.mjs';
import { handleGateCommand, normalizeGatePrefix, readDynamicGroups } from './gate-command.mjs';
import {
  GroupConversationBatcher,
  PriorityTaskQueue,
  isNonConversationalBotMessage,
  isStopInstruction,
  parseBatchReplies,
} from './group-batcher.mjs';
import { SendRateLimiter } from './rate-limit.mjs';
import { redactSensitiveText } from './redact.mjs';
import {
  buildMessageTextWithAttachments,
  downloadTelegramAttachments,
  getTelegramMessageEntities,
  getTelegramMessageText,
  hasTelegramAttachments,
} from './telegram-image-utils.mjs';

const DEFAULT_CONFIG = Object.freeze({
  botName: 'Codex',
  ownerName: 'the authorized user',
  allowedUserIds: [],
  ownerUserId: '',
  allowedGroups: {},
  mentionPatterns: [],
  gateCommandPrefix: '',
  codexPath: '/usr/local/bin/codex',
  codexMode: 'spawn',
  daemonSocketPath: '',
  daemonLaunchdLabel: 'com.example.codex-daemon',
  workdir: process.cwd(),
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  serviceTier: 'fast',
  privateToolsEnabled: false,
  toolWritableRoots: [],
  toolNetworkAccess: false,
  timeoutMs: 600000,
  imageMaxBytes: 10 * 1024 * 1024,
  fileMaxBytes: 20 * 1024 * 1024,
  attachmentTextMaxChars: 12000,
  desktopSync: false,
  liveLogEnabled: false,
  liveLogMaxChars: 6000,
  outboxEnabled: false,
  outboxPollMs: 1000,
  approvalTimeoutMs: 60000,
  groupQueueMaxPerChat: 100,
  privateQueueMax: 50,
  updateMaxInFlight: 100,
  updateJournalCompactBytes: 8 * 1024 * 1024,
  updateMaxAttempts: 12,
  updateRetryBaseMs: 3000,
  updateRetryMaxMs: 5 * 60 * 1000,
  mentionContext: {
    enabled: true,
    messageCount: 10,
    maxStoredMessages: 50,
    maxMessageChars: 800,
    recordAllDeliveredMessages: true,
  },
  rateLimit: {
    enabled: true,
    minIntervalMs: 10000,
  },
  batchTiming: {},
});

// Structured output for group turns: at most two replies, each optionally
// quoting a message id. Malformed output is dropped rather than published.
const GROUP_REPLY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['replies'],
  properties: {
    replies: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'replyToMessageId'],
        properties: {
          text: { type: 'string' },
          replyToMessageId: { type: ['integer', 'null'] },
        },
      },
    },
  },
});

function parseArgs(argv) {
  const args = { configPath: 'config.json', checkOnly: false, testPrompt: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') args.configPath = argv[++index];
    else if (arg === '--check') args.checkOnly = true;
    else if (arg === '--test') args.testPrompt = argv.slice(index + 1).join(' ') || 'Say hello in one sentence.';
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readEnvFile(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {}
}

function readPrivateFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

// Atomic + fsync'd. Session ids and poll offsets must survive a crash or power
// loss intact; a half-written offset would replay or skip real messages.
function writePrivateFile(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
  let directoryFd;
  try {
    directoryFd = fs.openSync(directory, 'r');
    fs.fsyncSync(directoryFd);
  } catch {
    // Directory fsync is not supported on every filesystem.
  } finally {
    if (directoryFd != null) fs.closeSync(directoryFd);
  }
}

function resolvePath(baseDir, maybePath) {
  if (!maybePath) return maybePath;
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(baseDir, maybePath);
}

function log(message) {
  console.log(`${new Date().toISOString()} ${redactSensitiveText(message)}`);
}

const args = parseArgs(process.argv);
const configPath = path.resolve(args.configPath);
const bridgeRoot = path.dirname(configPath);
readEnvFile(path.join(bridgeRoot, '.env'));

const config = {
  ...DEFAULT_CONFIG,
  ...readJson(configPath),
};
config.rateLimit = { ...DEFAULT_CONFIG.rateLimit, ...(config.rateLimit || {}) };
config.batchTiming = { ...DEFAULT_CONFIG.batchTiming, ...(config.batchTiming || {}) };
config.mentionContext = { ...DEFAULT_CONFIG.mentionContext, ...(config.mentionContext || {}) };

const batchTimingKeys = [
  'singleMessageMs',
  'sameSenderIdleMs',
  'sameSenderMaxMs',
  'multiSenderIdleMs',
  'multiSenderMaxMs',
];

function normalizeBatchTiming(value = {}) {
  return Object.fromEntries(
    batchTimingKeys
      .map((key) => [key, Number(value?.[key])])
      .filter(([, number]) => Number.isFinite(number) && number >= 0),
  );
}

// The token never has to live in a file: put it in the environment, in .env,
// or (macOS) in the Keychain and reference it from config.
function readBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  if (!config.keychainService || !config.keychainAccount) return '';
  try {
    return execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', config.keychainAccount, '-s', config.keychainService, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    throw new Error(
      `Telegram token not found in Keychain: service=${config.keychainService} account=${config.keychainAccount}`,
    );
  }
}

const token = readBotToken();
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Put it in .env, the process environment, or the macOS Keychain.');
  process.exit(1);
}

const allowedUserIds = new Set((config.allowedUserIds || []).map(String));
if (!allowedUserIds.size) {
  console.error('config.allowedUserIds must contain at least one Telegram user id.');
  process.exit(1);
}

// Owner-only surfaces (ops commands, approval buttons, gate commands) answer
// to exactly one id. It defaults to the first allowed user.
const ownerUserId = String(config.ownerUserId || [...allowedUserIds][0]);
const gateCommandPrefix = normalizeGatePrefix(config.gateCommandPrefix || config.botName);

const allowedGroups = new Map(Object.entries(config.allowedGroups || {}));
const mentionPatterns = (config.mentionPatterns || []).map(String).filter(Boolean);
const mentionPatternsLower = mentionPatterns.map((value) => value.toLowerCase()).filter(Boolean);
const mentionContextGlobal = { ...config.mentionContext };
const globalGroupBatchTiming = normalizeBatchTiming(config.batchTiming || {});
const workdir = resolvePath(bridgeRoot, config.workdir);
const codexPath = config.codexPath || 'codex';
const timeoutMs = Number(config.timeoutMs || DEFAULT_CONFIG.timeoutMs);
const privateToolsEnabled = config.privateToolsEnabled === true;
const toolWritableRoots = Array.isArray(config.toolWritableRoots) && config.toolWritableRoots.length
  ? config.toolWritableRoots.map((root) => resolvePath(bridgeRoot, root))
  : [workdir];
const stateDir = resolvePath(bridgeRoot, config.stateDir || '.state');
const imageCacheDir = resolvePath(bridgeRoot, config.imageCacheDir || 'telegram-images');
const fileCacheDir = resolvePath(bridgeRoot, config.fileCacheDir || 'telegram-files');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const sessionPath = path.join(stateDir, 'session.txt');
const previousSessionPath = path.join(stateDir, 'session.previous.txt');
const offsetPath = path.join(stateDir, 'offset.txt');
const dynamicGroupsPath = path.join(stateDir, 'dynamic-groups.json');
const groupContextCursorsPath = path.join(stateDir, 'group-context-cursors.json');
const updateInboxPath = path.join(stateDir, 'telegram-updates.journal.jsonl');
const updateRawArchivePath = path.join(stateDir, 'telegram-updates.raw.jsonl');
const liveLogPath = path.join(stateDir, 'telegram-live.jsonl');
const outboxPath = path.join(stateDir, 'outbox.jsonl');
const outboxOffsetPath = path.join(stateDir, 'outbox.offset');
const restartStatePath = path.join(stateDir, 'restart-state.json');

const telegramApi = `https://api.telegram.org/bot${token}`;
const checkOnly = args.checkOnly;
let sessionId = readPrivateFile(sessionPath) || null;
let updateOffset = Number(readPrivateFile(offsetPath) || 0);
let outboxOffset = Number(readPrivateFile(outboxOffsetPath) || 0);
let botId = '';
let botUsername = '';
const groupHistories = new Map();
const groupBotRuns = new Map();
const modelQueue = new PriorityTaskQueue();
const privateMessageQueue = new PriorityTaskQueue({ maxSize: Number(config.privateQueueMax || 50) });
const rateLimiter = new SendRateLimiter({
  enabled: config.rateLimit.enabled,
  minIntervalMs: config.rateLimit.minIntervalMs,
  stateDir: path.join(stateDir, 'rate-limit'),
  log,
});
const durableInbox = new DurableUpdateInbox(updateInboxPath, {
  compactBytes: Number(config.updateJournalCompactBytes || DEFAULT_CONFIG.updateJournalCompactBytes),
  rawArchivePath: updateRawArchivePath,
});
const inFlightUpdates = new Map();
const inFlightGroupBatches = new Set();
let durableDispatchPromise = null;
let processingOutbox = false;
// Set by /restart_daemon; consumed by the client's onReady callback.
let pendingDaemonRestartChat = null;
// token -> { resolve, timer, chatId, messageId, summaryText, method, isNewProto }
const pendingApprovals = new Map();

function batchTimingForGroup(chatId) {
  const groupConfig = groupConfigFor(chatId) || {};
  return {
    ...globalGroupBatchTiming,
    ...normalizeBatchTiming(groupConfig.batchTiming || {}),
  };
}

// Static config.json groups win over dynamically authorized ones. This lookup
// runs on every send and every batch tick, so the dynamic file is cached and
// only re-parsed when its mtime changes — that still picks up an edit made by
// hand while the bridge is running.
let dynamicGroups = {};
let dynamicGroupsMtimeMs = -1;

function refreshDynamicGroups(force = false) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dynamicGroupsPath).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (!force && mtimeMs === dynamicGroupsMtimeMs) return;
  dynamicGroupsMtimeMs = mtimeMs;
  dynamicGroups = readDynamicGroups(dynamicGroupsPath);
}

refreshDynamicGroups(true);

function groupConfigFor(chatId) {
  return allowedGroups.get(String(chatId)) || dynamicGroups[String(chatId)] || null;
}

function numberOption(value, fallback, min = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

function mentionContextOptions(groupConfig = {}) {
  return {
    ...mentionContextGlobal,
    ...(groupConfig.mentionContext || {}),
  };
}

function truncateText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function passiveHistoryText(rawText, messageHasAttachments, options) {
  const text = truncateText(rawText, numberOption(options.maxMessageChars, 800, 80));
  if (text) return messageHasAttachments ? `${text} [sent attachment(s)]` : text;
  return messageHasAttachments ? '[sent attachment(s)]' : '';
}

function rememberGroupMessage(message, options) {
  if (options.enabled === false) return;
  const maxMessageChars = numberOption(options.maxMessageChars, 800, 80);
  const text = truncateText(message.text, maxMessageChars);
  if (!text) return;

  const key = String(message.chatId);
  const history = groupHistories.get(key) || [];
  history.push({
    messageId: message.messageId,
    sentAt: message.sentAt,
    sender: message.senderName,
    username: message.senderUsername || null,
    senderIsBot: message.senderIsBot,
    text,
  });

  const requestedCount = numberOption(options.messageCount, 10, 0);
  const maxStoredMessages = Math.max(
    Math.floor(numberOption(options.maxStoredMessages, 50, 1)),
    Math.floor(requestedCount),
  );
  if (history.length > maxStoredMessages) history.splice(0, history.length - maxStoredMessages);
  groupHistories.set(key, history);
}

function messageHitsMentionPatterns(rawText) {
  if (!mentionPatternsLower.length) return false;
  const lower = String(rawText || '').toLowerCase();
  return mentionPatternsLower.some((pattern) => lower.includes(pattern));
}

// ---------------------------------------------------------------------------
// Delta group context
//
// Re-sending the same recent messages on every mention wastes tokens and makes
// the model re-read what it already answered. Each (chatId, threadId) pair
// keeps a cursor of the highest message id it has processed, and only newer
// messages travel as context. The cursor advances only after every reply in a
// batch has been accepted by Telegram, so a failure replays the same context.
// ---------------------------------------------------------------------------

const groupContextCursors = new Map();
try {
  if (fs.existsSync(groupContextCursorsPath)) {
    const raw = JSON.parse(fs.readFileSync(groupContextCursorsPath, 'utf8'));
    for (const [key, value] of Object.entries(raw || {})) {
      if (typeof value === 'number' && Number.isFinite(value) && key.includes('::')) {
        groupContextCursors.set(key, value);
      }
    }
  }
} catch (error) {
  console.error(`could not load ${groupContextCursorsPath}; starting with empty cursors: ${error.message}`);
}

function saveGroupContextCursors() {
  writePrivateFile(groupContextCursorsPath, JSON.stringify(Object.fromEntries(groupContextCursors.entries())));
}

function recentGroupContextDelta(chatId, threadId, options, currentBatchMessageIds = new Set()) {
  const empty = { messages: [], previousContextThroughMessageId: null, omitted: false };
  if (options.enabled === false) return empty;
  const configuredCount = Math.max(0, Math.floor(numberOption(options.messageCount, 10, 0)));
  if (!configuredCount) return empty;
  const maxStored = Math.max(
    Math.floor(numberOption(options.maxStoredMessages, 50, 1)),
    configuredCount,
  );
  const history = groupHistories.get(String(chatId)) || [];
  const cursor = groupContextCursors.get(`${chatId}::${threadId || ''}`) || 0;
  // Every unseen message is delivered, not just the newest N: a small display
  // window must never silently swallow older context the model has not read.
  const messages = history
    .filter((message) => Number(message.messageId) > cursor)
    .filter((message) => !currentBatchMessageIds.has(Number(message.messageId)))
    .slice(0, maxStored);
  return {
    messages,
    previousContextThroughMessageId: cursor > 0 ? cursor : null,
    // With no cursor the earlier messages truly did not happen for this thread;
    // with one, they happened and were already delivered.
    omitted: cursor > 0,
  };
}

function advanceGroupContextCursor(chatId, threadId, batchMessageIds) {
  if (!threadId) return;
  const key = `${chatId}::${threadId}`;
  const newCursor = batchMessageIds.reduce((max, id) => Math.max(max, Number(id) || 0), 0);
  if (!newCursor) return;
  const oldCursor = groupContextCursors.get(key) || 0;
  if (newCursor <= oldCursor) return;
  groupContextCursors.set(key, newCursor);
  try {
    saveGroupContextCursors();
  } catch (error) {
    log(`could not persist ${groupContextCursorsPath}: ${error.message} (in-memory cursor updated)`);
  }
}

// ---------------------------------------------------------------------------
// Codex client
// ---------------------------------------------------------------------------

// codexMode: 'spawn' (v1, default) spawns a `codex app-server --stdio` child
// per bridge process. State is per-process: Codex.app or `codex --remote` on
// the same machine each get their own isolated thread state.
//
// codexMode: 'daemon' (v2) connects to a long-running `codex app-server
// --listen unix://PATH` daemon. The bridge and a `codex --remote unix://PATH`
// TUI then share one thread, and the daemon broadcasts events to both.
const codexMode = config.codexMode === 'daemon' ? 'daemon' : 'spawn';
const defaultDaemonSocket = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  'app-server-control/app-server-control.sock',
);
const daemonSocketPath = config.daemonSocketPath
  ? resolvePath(bridgeRoot, config.daemonSocketPath)
  : defaultDaemonSocket;

function syncThreadToDesktop(threadId, preview) {
  if (config.desktopSync !== true || !threadId) return;
  syncDesktopMetadata({
    threadId,
    title: `${config.botName} via Telegram`,
    preview: String(preview || '').slice(0, 200),
    cwd: workdir,
    log,
  });
}

function makeCodexClient() {
  const sharedOpts = {
    workdir,
    threadId: sessionId,
    model: config.model || DEFAULT_CONFIG.model,
    effort: config.reasoningEffort || DEFAULT_CONFIG.reasoningEffort,
    serviceTier: config.serviceTier || DEFAULT_CONFIG.serviceTier,
    timeoutMs,
    toolWritableRoots,
    toolNetworkAccess: config.toolNetworkAccess === true,
    log,
    onReady: (threadId) => {
      // Only an explicit /new or /resume may change the locked thread. Clients
      // fail closed on resume errors, so an unexpected change is a security
      // event rather than a routine fallback.
      if (sessionId && sessionId !== threadId) {
        log(`Codex thread switched: ${sessionId} -> ${threadId} (previous id saved)`);
        writePrivateFile(previousSessionPath, sessionId);
      }
      sessionId = threadId;
      writePrivateFile(sessionPath, threadId);
      log(`Codex ${codexMode} ready; session ${threadId}`);
      syncThreadToDesktop(threadId, '(bridge started, waiting for the first message)');
      if (pendingDaemonRestartChat) {
        const target = pendingDaemonRestartChat;
        pendingDaemonRestartChat = null;
        sendMessage(target, '✅ Codex daemon restarted and the bridge reconnected.')
          .catch((error) => log(`daemon restart notice failed: ${error.message}`));
      }
    },
    onThreadChange: (info) => {
      if (info?.previousThreadId) {
        log(`Codex thread could not be resumed (reason=${info.reason}); keeping ${info.previousThreadId} locked`);
      }
      if (info?.blocked) {
        sendMessage(
          ownerUserId,
          `⚠️ The locked thread ${info.previousThreadId} could not be resumed. The bridge failed closed and did not`
          + ' create a replacement thread. Use /resume <thread-id> or /new to decide explicitly.',
        ).catch((error) => log(`fail-closed notice failed: ${error.message}`));
      }
    },
    onSecurityEvent: (event) => {
      const params = event.params || {};
      const command = Array.isArray(params.command) ? params.command.join(' ') : params.command;
      const summary = redactSensitiveText(
        command || params.error || params.reason || params.method || params.grantRoot || '',
      );
      log(`tool approval ${event.kind} decision=${event.decision}${summary ? ` summary=${summary.slice(0, 240)}` : ''}`);
    },
  };

  if (codexMode === 'daemon') {
    log(`Codex mode: daemon (socket=${daemonSocketPath})`);
    return new CodexDaemonClient({
      ...sharedOpts,
      socketPath: daemonSocketPath,
      requestUserApproval: forwardApprovalToTelegram,
      onDisconnect: (reason) => clearPendingApprovals(`daemon ${reason}`),
    });
  }
  log(`Codex mode: spawn (codexPath=${codexPath})`);
  return new CodexAppClient({ ...sharedOpts, codexPath });
}

const codex = checkOnly ? null : makeCodexClient();

// ---------------------------------------------------------------------------
// Telegram I/O
// ---------------------------------------------------------------------------

async function telegram(method, params = {}) {
  const response = await fetch(`${telegramApi}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40000),
  });
  const data = await response.json();

  if (!response.ok || !data.ok) {
    const description = String(data.description || response.statusText || 'unknown error');
    throw new Error(`Telegram ${method} failed: ${description}`);
  }

  return data.result;
}

function splitTelegramText(text, limit = 4000) {
  const chunks = [];
  let rest = String(text || '');

  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.6)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }

  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [`(${config.botName} produced no sendable text.)`];
}

function truncateLiveText(value, maxChars = Number(config.liveLogMaxChars || 6000)) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function compactLiveAttachment(attachment) {
  return {
    fileName: attachment.fileName || path.basename(attachment.path || '') || null,
    mimeType: attachment.mimeType || null,
    width: attachment.width || null,
    height: attachment.height || null,
    fileSize: attachment.fileSize || null,
    source: attachment.source || null,
    path: attachment.path || null,
  };
}

// Optional local transcript of everything in and out. Off by default: it is
// plaintext chat content sitting on disk.
function appendLiveLog(event) {
  if (config.liveLogEnabled !== true) return;
  try {
    fs.appendFileSync(
      liveLogPath,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), sessionId, ...event })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.chmodSync(liveLogPath, 0o600);
  } catch (error) {
    log(`live log write failed: ${error.message}`);
  }
}

const DICE_EMOJI = ['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'];

async function sendMessage(chatId, text, replyToMessageId = null, options = {}) {
  const groupConfig = groupConfigFor(chatId);
  // Some groups read better without quote-replies (it keeps two bots from
  // building a visible reply chain at each other).
  if (groupConfig?.disableReplyQuote === true) replyToMessageId = null;

  // A reply that is exactly one dice emoji becomes a real Telegram dice roll.
  if (DICE_EMOJI.includes(String(text ?? '').trim())) {
    const params = { chat_id: chatId, emoji: String(text).trim() };
    if (replyToMessageId) params.reply_parameters = { message_id: replyToMessageId };
    const result = await rateLimiter.run(
      chatId,
      () => telegram('sendDice', params),
      { shouldSend: options.shouldSend },
    );
    return !result?.skipped;
  }

  const chunks = splitTelegramText(text);
  for (const [index, chunk] of chunks.entries()) {
    const params = { chat_id: chatId, text: chunk };
    if (index === 0 && replyToMessageId) {
      params.reply_parameters = { message_id: replyToMessageId };
    }
    const result = await rateLimiter.run(
      chatId,
      () => telegram('sendMessage', params),
      { shouldSend: options.shouldSend },
    );
    if (result?.skipped) return false;
    appendLiveLog({
      direction: 'out',
      chatId: String(chatId),
      messageId: result?.message_id || null,
      replyToMessageId: index === 0 ? replyToMessageId : null,
      chunkIndex: index,
      chunkCount: chunks.length,
      text: truncateLiveText(chunk),
    });
  }
  return true;
}

async function reactToMessage(chatId, messageId, emoji) {
  await telegram('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  });
}

// Optional outbox: append {"chatId": "...", "text": "..."} lines to
// .state/outbox.jsonl and the bridge sends them. Handy for cron jobs and
// scripts that want to reach the same chat without a second bot token.
async function processOutbox() {
  if (config.outboxEnabled !== true || processingOutbox) return;
  processingOutbox = true;

  try {
    if (!fs.existsSync(outboxPath)) return;

    const lines = fs.readFileSync(outboxPath, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (outboxOffset > lines.length) outboxOffset = 0;

    for (let index = outboxOffset; index < lines.length; index += 1) {
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch (error) {
        log(`outbox line ${index + 1} is not valid JSON, skipped: ${error.message}`);
        outboxOffset = index + 1;
        writePrivateFile(outboxOffsetPath, String(outboxOffset));
        continue;
      }

      const text = String(event.text || '').trim();
      if (!text) {
        log(`outbox line ${index + 1} has no text, skipped`);
        outboxOffset = index + 1;
        writePrivateFile(outboxOffsetPath, String(outboxOffset));
        continue;
      }

      const chatId = String(event.chatId || ownerUserId || '');
      if (!chatId) {
        log(`outbox line ${index + 1} has no chat id to send to`);
        return;
      }

      await sendMessage(chatId, text);
      log(`outbox sent line=${index + 1} chat=${chatId}`);
      outboxOffset = index + 1;
      writePrivateFile(outboxOffsetPath, String(outboxOffset));
    }
  } finally {
    processingOutbox = false;
  }
}

function secureRuntimeFiles() {
  for (const filePath of [
    liveLogPath,
    updateInboxPath,
    updateRawArchivePath,
    `${updateRawArchivePath}.offset`,
    outboxPath,
  ]) {
    try { if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildPrivatePrompt(text, context, images = [], files = []) {
  const payload = {
    mode: 'TG_PRIVATE',
    botName: config.botName,
    ownerName: config.ownerName,
    sender: context.senderName || context.senderUsername || 'unknown sender',
    username: context.senderUsername || null,
    images: images.length,
    files: files.length,
    toolMode: {
      enabled: privateToolsEnabled,
      writableRoots: privateToolsEnabled ? toolWritableRoots : [],
      networkAccess: privateToolsEnabled && config.toolNetworkAccess === true,
    },
    text,
  };
  return [
    'TG_PRIVATE',
    'Follow the Telegram bridge protocol from AGENTS.md. Reply with the Telegram message body only.',
    JSON.stringify(payload),
  ].join('\n');
}

function buildGroupBatchPrompt(batch, { superseding, recentContextDelta = null }) {
  const chatTitle = batch.at(-1)?.chatTitle || 'group';
  const chatId = String(batch.at(-1)?.chatId || '');
  const groupConfig = groupConfigFor(chatId) || {};
  const imageCount = batch.reduce((sum, message) => sum + (message.images || []).length, 0);
  const fileCount = batch.reduce((sum, message) => sum + (message.files || []).length, 0);
  const messages = batch.map((message) => ({
    messageId: message.messageId,
    sentAt: new Date(message.sentAt || message.receivedAt).toISOString(),
    sender: message.senderName,
    username: message.senderUsername || null,
    senderIsBot: message.senderIsBot,
    contextOnly: message.contextOnly === true,
    text: message.text,
    images: (message.images || []).map((image) => ({
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      fileSize: image.fileSize,
    })),
    files: (message.files || []).map((file) => ({
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      source: file.source,
      path: file.path,
      textPreviewStatus: file.textPreviewStatus,
    })),
  }));
  // contextWindow tells the model that anything older was deliberately left
  // out because it already read it — not that nothing happened before.
  const payload = {
    mode: 'TG_GROUP_BATCH',
    botName: config.botName,
    ownerName: config.ownerName,
    chatId,
    chatTitle,
    profile: groupConfig.profile || null,
    superseding,
    imageCount,
    fileCount,
    contextWindow: {
      mode: 'delta_since_last_group_turn',
      previousContextThroughMessageId: recentContextDelta?.previousContextThroughMessageId ?? null,
      omittedPreviouslySentMessages: Boolean(recentContextDelta?.omitted),
    },
    recentContextDelta: recentContextDelta?.messages || [],
    messages,
  };

  return [
    'TG_GROUP_BATCH',
    'Follow the Telegram bridge protocol from AGENTS.md. Strict JSON only:'
    + ' {"replies":[{"text":"...","replyToMessageId":123|null}],"react":"👀"|null}',
    JSON.stringify(payload),
  ].join('\n');
}

async function askCodex(text, context, images = [], files = []) {
  const result = await codex.ask(
    buildPrivatePrompt(text, context, images, files),
    images,
    { toolMode: privateToolsEnabled ? 'private-tools' : 'read-only' },
  );
  sessionId = result.threadId;
  syncThreadToDesktop(
    result.threadId,
    `[private] ${context.senderName || context.senderUsername || '?'}: ${String(text).slice(0, 100)}`,
  );
  return { reply: result.reply, threadId: result.threadId };
}

// ---------------------------------------------------------------------------
// Group batches
// ---------------------------------------------------------------------------

function serializeDurableGroupMessage(message) {
  return {
    chatId: String(message.chatId || ''),
    chatTitle: String(message.chatTitle || ''),
    messageId: Number(message.messageId),
    text: String(message.text || ''),
    images: structuredClone(message.images || []),
    files: structuredClone(message.files || []),
    senderId: String(message.senderId || ''),
    senderIsBot: message.senderIsBot === true,
    senderUsername: String(message.senderUsername || ''),
    senderName: String(message.senderName || ''),
    sentAt: Number(message.sentAt || 0),
    receivedAt: Number(message.receivedAt || Date.now()),
    _durableUpdateId: Number(message._durableUpdateId),
  };
}

function durableGroupBatchId(chatId, updateIds) {
  const range = `${Math.min(...updateIds)}-${Math.max(...updateIds)}`;
  return `${chatId}:${range}:${crypto.randomUUID()}`;
}

function durableBatchIdFromMessages(batch) {
  const ids = [...new Set(batch.map((message) => message._durableGroupBatchId).filter(Boolean))];
  if (ids.length !== 1) throw new Error(`group batch durable ownership ambiguous ids=${ids.join(',') || 'none'}`);
  return ids[0];
}

async function generateGroupReplies(batch, options) {
  const chatId = batch.at(-1).chatId;
  const updateIds = batch.map((message) => Number(message._durableUpdateId));
  if (!updateIds.length || updateIds.some((updateId) => !Number.isSafeInteger(updateId))) {
    throw new Error(`group batch is missing durable update ids chat=${chatId}`);
  }
  const durableBatchId = options.replayBatchId || durableGroupBatchId(chatId, updateIds);
  if (!options.replayBatchId) {
    durableInbox.markGroupBatch({
      batchId: durableBatchId,
      chatId,
      updateIds,
      preparedMessages: batch.map(serializeDurableGroupMessage),
    });
  }
  for (const message of batch) message._durableGroupBatchId = durableBatchId;

  const typing = setInterval(() => {
    telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  typing.unref();

  try {
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const images = batch.flatMap((message) => message.images || []);
    const groupConfig = groupConfigFor(chatId) || {};
    const contextOptions = mentionContextOptions(groupConfig);
    const currentBatchMessageIds = new Set(batch.map((m) => Number(m.messageId)).filter(Number.isFinite));
    const recentContextDelta = recentGroupContextDelta(
      chatId,
      sessionId,
      contextOptions,
      currentBatchMessageIds,
    );
    const result = await modelQueue.run(
      () => codex.ask(buildGroupBatchPrompt(batch, { ...options, recentContextDelta }), images, {
        toolMode: 'read-only',
        outputSchema: GROUP_REPLY_SCHEMA,
      }),
      0,
    );
    // Pin the exact thread that generated this batch: an explicit /new or
    // /resume can land between generation and the Telegram send.
    for (const message of batch) message._processedThreadId = result.threadId;
    sessionId = result.threadId;
    const lastMessage = batch.at(-1);
    syncThreadToDesktop(
      result.threadId,
      `[${lastMessage?.chatTitle || chatId}] ${lastMessage?.senderName || '?'}: ${String(lastMessage?.text || '').slice(0, 100)}`,
    );
    const replies = parseBatchReplies(result.reply, batch.map((message) => message.messageId));
    durableInbox.markGroupBatchReplies(durableBatchId, replies, result.threadId);
    return replies;
  } finally {
    clearInterval(typing);
  }
}

async function notifyGroupFailure(chatId, error, batch) {
  const source = batch.at(-1)?.chatTitle || chatId;
  await sendMessage(
    ownerUserId,
    `[bridge-status] ${config.botName} failed to generate a group reply for "${source}". This batch was stopped and`
    + ` bot-triggered replies are paused briefly. Error: ${redactSensitiveText(error.message)}`,
  );
}

const groupBatcher = new GroupConversationBatcher({
  getTiming: batchTimingForGroup,
  generateReplies: generateGroupReplies,
  sendReply: async (chatId, reply, batch, shouldSend, { replyIndex } = {}) => {
    const durableBatchId = durableBatchIdFromMessages(batch);
    if (!Number.isInteger(replyIndex) || replyIndex < 0) {
      throw new Error(`group batch replyIndex is invalid batch=${durableBatchId}`);
    }
    if (durableInbox.isGroupReplyAcked(durableBatchId, replyIndex)) {
      log(`group reply already acked, not resending batch=${durableBatchId} reply=${replyIndex}`);
      return true;
    }
    const fallbackMessageId = [...batch].reverse().find((message) => !message.senderIsBot)?.messageId
      || batch.at(-1)?.messageId
      || null;
    const sent = await sendMessage(
      chatId,
      reply.text,
      reply.replyToMessageId || fallbackMessageId,
      { shouldSend },
    );
    if (sent) durableInbox.markGroupReplyAck(durableBatchId, replyIndex);
    return sent;
  },
  onReact: reactToMessage,
  notifyFailure: notifyGroupFailure,
  onBatchComplete: async (chatId, batch) => {
    const processedThreadIds = [...new Set(batch.map((message) => message._processedThreadId).filter(Boolean))];
    if (processedThreadIds.length !== 1) {
      throw new Error(`group batch thread ownership ambiguous chat=${chatId}`);
    }
    advanceGroupContextCursor(chatId, processedThreadIds[0], batch.map((message) => message.messageId));
    durableInbox.markGroupBatchDone(durableBatchIdFromMessages(batch));
  },
  maxPendingMessages: Number(config.groupQueueMaxPerChat || 100),
  log,
  timing: config.batchTiming,
});

// ---------------------------------------------------------------------------
// Owner-only ops commands
// ---------------------------------------------------------------------------

// Hot-swaps the parts of config.json that can change safely in place. Static
// fields (codexMode, model, timeoutMs, keychain*) still need a restart.
function reloadConfig() {
  const next = readJson(configPath);
  if (!Array.isArray(next.allowedUserIds)) throw new Error('allowedUserIds must be an array');
  if (!next.allowedGroups || typeof next.allowedGroups !== 'object') throw new Error('allowedGroups must be an object');
  const nextUsers = next.allowedUserIds.map(String).filter(Boolean);
  if (!nextUsers.length) throw new Error('allowedUserIds must not be empty');
  const nextGroups = Object.entries(next.allowedGroups).map(([chatId, group]) => {
    if (!/^-?\d+$/.test(chatId) || !group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error(`allowedGroups.${chatId} is invalid`);
    }
    const normalized = { ...group };
    if (normalized.maxConsecutiveBotMessages != null) {
      const limit = Number(normalized.maxConsecutiveBotMessages);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error(`${chatId}.maxConsecutiveBotMessages is invalid`);
      }
      normalized.maxConsecutiveBotMessages = limit;
    }
    if (normalized.batchTiming != null) normalized.batchTiming = normalizeBatchTiming(normalized.batchTiming);
    return [chatId, normalized];
  });
  const nextPatterns = (next.mentionPatterns || []).map(String).map((value) => value.trim()).filter(Boolean);
  const nextMentionContext = { ...DEFAULT_CONFIG.mentionContext, ...(next.mentionContext || {}) };
  for (const key of ['messageCount', 'maxStoredMessages', 'maxMessageChars']) {
    const value = Number(nextMentionContext[key]);
    if (!Number.isInteger(value) || value < 0 || value > 100000) throw new Error(`mentionContext.${key} is invalid`);
    nextMentionContext[key] = value;
  }
  if (nextMentionContext.maxStoredMessages < nextMentionContext.messageCount) {
    throw new Error('mentionContext.maxStoredMessages must not be smaller than messageCount');
  }
  const nextBatchTiming = normalizeBatchTiming(next.batchTiming || {});

  // Commit only after every field has parsed and validated.
  allowedUserIds.clear();
  for (const userId of nextUsers) allowedUserIds.add(userId);
  allowedGroups.clear();
  for (const [chatId, group] of nextGroups) allowedGroups.set(chatId, group);
  mentionPatterns.length = 0;
  mentionPatterns.push(...nextPatterns);
  mentionPatternsLower.length = 0;
  mentionPatternsLower.push(...mentionPatterns.map((value) => value.toLowerCase()).filter(Boolean));
  for (const key of Object.keys(mentionContextGlobal)) delete mentionContextGlobal[key];
  Object.assign(mentionContextGlobal, nextMentionContext);
  for (const key of Object.keys(globalGroupBatchTiming)) delete globalGroupBatchTiming[key];
  Object.assign(globalGroupBatchTiming, nextBatchTiming);
  return {
    groups: allowedGroups.size,
    mentionPatterns: mentionPatterns.length,
    mentionContextMessageCount: mentionContextGlobal.messageCount,
  };
}

async function handleReloadConfig(message, durableUpdateId = null) {
  const chatId = String(message.chat.id);
  if (String(message.from.id) !== ownerUserId) {
    await sendMessage(chatId, '❌ /reload_config is owner-only.');
    return;
  }
  const operation = durableUpdateId == null
    ? { status: 'intent' }
    : durableInbox.beginOperation(durableUpdateId, 'reload-config', {});
  let reply;
  if (operation.status === 'result') {
    reply = String(operation.result.reply || '✅ Config reload already completed.');
  } else {
    try {
      const summary = reloadConfig();
      reply = [
        '✅ Config reloaded in place',
        `  groups: ${summary.groups}`,
        `  mention patterns: ${summary.mentionPatterns}`,
        `  group context window: ${summary.mentionContextMessageCount}`,
        '(codexMode / model / timeoutMs / keychain* keep their old values; use /restart_bridge for those)',
      ].join('\n');
      log(`/reload_config done groups=${summary.groups} patterns=${summary.mentionPatterns}`);
    } catch (error) {
      reply = `❌ Reload failed, the previous config is still active: ${error.message}`;
      log(`/reload_config failed: ${error.message}`);
    }
    if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { reply });
  }
  await sendDurablePrivateText(durableUpdateId, chatId, reply);
}

function activeTurnInfo() {
  const running = modelQueue.running ? 1 : 0;
  const queued = modelQueue.tasks.length;
  return { running, queued, total: running + queued };
}

async function handleRestartBridge(message, { force = false, durableUpdateId = null } = {}) {
  const chatId = String(message.chat.id);
  if (String(message.from.id) !== ownerUserId) {
    await sendMessage(chatId, '❌ /restart_bridge is owner-only.');
    return;
  }
  const info = activeTurnInfo();
  if (!force && info.total > 0) {
    await sendMessage(
      chatId,
      `⚠️ ${info.total} turn(s) in flight (running=${info.running} queued=${info.queued}).`
      + ' Use /force_restart_bridge to interrupt them.',
    );
    return;
  }
  if (force) clearPendingApprovals('bridge force restart');
  const operation = durableUpdateId == null
    ? { status: 'intent' }
    : durableInbox.beginOperation(durableUpdateId, 'restart-bridge', { chatId, force });
  if (operation.status === 'result') {
    // The previous process made the handoff durable and then died before its
    // update could be marked done. This *is* the replacement process: consume
    // the update instead of restarting again.
    durableInbox.markDone(durableUpdateId);
    log(`restart-bridge operation already completed; not looping update=${durableUpdateId}`);
    return;
  }
  const ack = await sendDurablePrivateText(
    durableUpdateId,
    chatId,
    force ? '🔄 Restarting the bridge (forced)...' : '🔄 Restarting the bridge...',
    { rawTelegram: true },
  );
  if (!ack?.message_id) throw new Error('restart acknowledgement has no message_id');
  // Short-lived handoff: the next process edits that same message so the owner
  // sees the restart complete instead of a message that just stops updating.
  try {
    writePrivateFile(restartStatePath, JSON.stringify({
      chat_id: chatId,
      message_id: ack.message_id,
      timestamp: Date.now(),
      trigger: 'bridge',
      force,
    }));
  } catch (error) {
    log(`could not write ${restartStatePath}: ${error.message} (restart continues, only the ack edit is lost)`);
  }
  if (durableUpdateId != null) {
    try {
      // This command terminates the process, so its normal completion promise
      // can never settle. Persist done once the acknowledgement and handoff
      // are durable, before exiting.
      durableInbox.completeOperation(durableUpdateId, { ackMessageId: ack.message_id, handoffWritten: true });
      durableInbox.markDone(durableUpdateId);
    } catch (error) {
      await telegram('editMessageText', {
        chat_id: chatId,
        message_id: ack.message_id,
        text: `❌ Bridge not restarted: could not commit durable state for update ${durableUpdateId}`,
      }).catch(() => {});
      throw error;
    }
  }
  log(`/restart_bridge force=${force} -> exit(0); the process manager restarts it`);
  codex?.close();
  process.exit(0);
}

async function handleRestartDaemon(message, { force = false, durableUpdateId = null } = {}) {
  const chatId = String(message.chat.id);
  if (String(message.from.id) !== ownerUserId) {
    await sendMessage(chatId, '❌ /restart_daemon is owner-only.');
    return;
  }
  if (codexMode !== 'daemon') {
    await sendMessage(chatId, 'This bridge runs in spawn mode; there is no daemon to restart.');
    return;
  }
  if (process.platform !== 'darwin') {
    await sendMessage(chatId, '/restart_daemon uses launchctl and only works on macOS. Restart the daemon manually.');
    return;
  }
  const info = activeTurnInfo();
  if (!force && info.total > 0) {
    await sendMessage(
      chatId,
      `⚠️ ${info.total} turn(s) in flight. Use /force_restart_daemon`
      + ' (the bridge reconnects automatically, but those turns are lost).',
    );
    return;
  }
  // A non-forced daemon restart also clears approvals via onDisconnect; this
  // covers the forced path, where in-flight turns die immediately.
  if (force) clearPendingApprovals('daemon force restart');
  const operation = durableUpdateId == null
    ? { status: 'intent' }
    : durableInbox.beginOperation(durableUpdateId, 'restart-daemon', { chatId, force });
  if (operation.status === 'result') {
    log(`restart-daemon operation already completed; skipping duplicate kickstart update=${durableUpdateId}`);
    return;
  }
  pendingDaemonRestartChat = chatId;
  await sendDurablePrivateText(
    durableUpdateId,
    chatId,
    force
      ? '🔄 Restarting the Codex daemon (forced); the bridge will reconnect...'
      : '🔄 Restarting the Codex daemon; the bridge will reconnect...',
  );
  // Detached: the bridge stays up and the daemon client's reconnect loop takes
  // the new daemon. onReady then posts the confirmation.
  const child = spawn(
    '/bin/launchctl',
    ['kickstart', '-k', `gui/${process.getuid()}/${config.daemonLaunchdLabel || DEFAULT_CONFIG.daemonLaunchdLabel}`],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { kickstartSpawned: true });
  log(`/restart_daemon force=${force} -> detached launchctl kickstart`);
}

// ---------------------------------------------------------------------------
// Approval forwarding (Telegram inline keyboard)
// ---------------------------------------------------------------------------

const APPROVAL_TOKEN_RE = /^apr:([0-9a-f]{8}):(accept|decline)$/;

function truncateForKeyboard(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function approvalSummaryText({ method, reason, summary }) {
  const reasonText = ({
    'network-requested': '🌐 the command asked for network access',
    'cwd-outside-roots': '📂 working directory is outside the writable roots',
    'paths-outside-roots': '📂 file paths are outside the writable roots',
    'command-writes-outside-roots': '📂 the command writes outside the writable roots',
    'manual-confirmation-required': '🔐 not on the read-only allowlist, needs your confirmation',
    'external-client-turn': '🖥️ from a terminal session attached to the same thread',
  })[reason] || reason;

  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const paths = (summary.filePaths || []).slice(0, 5);
    const overflow = (summary.filePaths || []).length - paths.length;
    return [
      `❓ ${config.botName} wants to write files (${reasonText})`,
      summary.grantRoot ? `  grantRoot: ${truncateForKeyboard(redactSensitiveText(summary.grantRoot), 120)}` : '',
      ...paths.map((p) => `  • ${truncateForKeyboard(redactSensitiveText(p), 120)}`),
      overflow > 0 ? `  ...and ${overflow} more` : '',
    ].filter(Boolean).join('\n');
  }

  const targetsOutsideRoots = summary.targetsOutsideRoots || [];
  return [
    `❓ ${config.botName} wants to run a command (${reasonText})`,
    `  command: ${truncateForKeyboard(redactSensitiveText(summary.command), 200)}`,
    `  cwd: ${truncateForKeyboard(redactSensitiveText(summary.cwd), 200)}`,
    summary.networkRequested ? '  🌐 network access requested' : '',
    ...targetsOutsideRoots.slice(0, 3).map((t) => `  ⚠️ writes: ${truncateForKeyboard(redactSensitiveText(t), 150)}`),
    targetsOutsideRoots.length > 3 ? `  ...and ${targetsOutsideRoots.length - 3} more write targets` : '',
  ].filter(Boolean).join('\n');
}

// Invalidate cards that can no longer be answered, so a late tap does not try
// to reply on a dead connection or to a request id that no longer exists.
function clearPendingApprovals(reason) {
  if (pendingApprovals.size === 0) return;
  const tokens = [...pendingApprovals.keys()];
  log(`clearing ${tokens.length} pending approval(s): ${reason}`);
  for (const token of tokens) {
    const pending = pendingApprovals.get(token);
    if (!pending) continue;
    pendingApprovals.delete(token);
    clearTimeout(pending.timer);
    telegram('editMessageText', {
      chat_id: pending.chatId,
      message_id: pending.messageId,
      text: `${pending.summaryText}\n\n⚠️ ${reason} — this request is no longer valid. Retry it to get a new card.`,
    }).catch(() => {});
    try { pending.resolve('decline'); } catch {}
  }
}

async function forwardApprovalToTelegram(info) {
  const approvalToken = crypto.randomBytes(4).toString('hex');
  const summaryText = approvalSummaryText(info);
  const timeoutSeconds = Math.round(Number(config.approvalTimeoutMs || DEFAULT_CONFIG.approvalTimeoutMs) / 1000);
  const ack = await telegram('sendMessage', {
    chat_id: ownerUserId,
    text: summaryText,
    reply_markup: JSON.stringify({
      // Two buttons only. There is deliberately no "approve for the rest of
      // this turn": every forwarded request needs its own tap.
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `apr:${approvalToken}:accept` },
        { text: '❌ Decline', callback_data: `apr:${approvalToken}:decline` },
      ]],
    }),
  });
  log(`approval forwarded token=${approvalToken} method=${info.method} reason=${info.reason} msg=${ack.message_id}`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingApprovals.get(approvalToken);
      if (!pending) return;
      pendingApprovals.delete(approvalToken);
      telegram('editMessageText', {
        chat_id: pending.chatId,
        message_id: pending.messageId,
        text: `${pending.summaryText}\n\n⏱️ No answer within ${timeoutSeconds}s — declined automatically.`,
      }).catch(() => {});
      log(`approval token=${approvalToken} timed out -> auto decline`);
      resolve('decline');
    }, Number(config.approvalTimeoutMs || DEFAULT_CONFIG.approvalTimeoutMs));
    pendingApprovals.set(approvalToken, {
      resolve,
      timer,
      chatId: ownerUserId,
      messageId: ack.message_id,
      summaryText,
      method: info.method,
      isNewProto: info.isNewProto,
    });
  });
}

async function handleCallbackQuery(callback) {
  const callbackQueryId = callback.id;
  const fromId = String(callback.from?.id || '');
  const data = String(callback.data || '');

  if (fromId !== ownerUserId) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: '❌ Only the owner can answer approvals.',
    }).catch(() => {});
    log(`callback_query from non-owner=${fromId} rejected`);
    return;
  }
  const match = data.match(APPROVAL_TOKEN_RE);
  if (!match) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: '⚠️ Invalid approval token.',
    }).catch(() => {});
    return;
  }
  const [, approvalToken, action] = match;
  const pending = pendingApprovals.get(approvalToken);
  if (!pending) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: '⚠️ This approval already timed out or was answered.',
      show_alert: true,
    }).catch(() => {});
    return;
  }
  pendingApprovals.delete(approvalToken);
  clearTimeout(pending.timer);
  const labelMap = { accept: '✅ Approved', decline: '❌ Declined' };
  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: labelMap[action] || action,
  }).catch(() => {});
  await telegram('editMessageText', {
    chat_id: pending.chatId,
    message_id: pending.messageId,
    text: `${pending.summaryText}\n\n${labelMap[action] || action}`,
  }).catch(() => {});
  pending.resolve(action);
  log(`approval token=${approvalToken} answered=${action}`);
}

// ---------------------------------------------------------------------------
// Private chat
// ---------------------------------------------------------------------------

async function sendDurablePrivateText(
  durableUpdateId,
  chatId,
  text,
  { threadId = sessionId, rawTelegram = false } = {},
) {
  if (durableUpdateId == null) {
    if (rawTelegram) return telegram('sendMessage', { chat_id: chatId, text });
    await sendMessage(chatId, text);
    return null;
  }

  let delivery = durableInbox.privateDelivery(durableUpdateId);
  if (!delivery) {
    delivery = durableInbox.markPrivateGenerated(durableUpdateId, { reply: text, threadId, chatId });
  }
  if (delivery.sent) {
    log(`durable private reply already acked, not resending update=${durableUpdateId}`);
    return delivery.sendResult;
  }

  let sendResult = null;
  if (rawTelegram) {
    sendResult = await telegram('sendMessage', { chat_id: chatId, text: delivery.reply });
  } else {
    await sendMessage(chatId, delivery.reply);
  }
  durableInbox.markPrivateSendAck(durableUpdateId, sendResult);
  return sendResult;
}

async function processPrivateMessage(message, text, context, images = [], files = [], durableUpdateId = null) {
  const chatId = String(message.chat.id);
  const fromId = String(message.from.id);
  log(`authorized private message chat=${chatId} from=${fromId}`);

  if (/^\/start$/i.test(text)) {
    await sendMessage(chatId, `${config.botName} is online.`);
    return;
  }

  if (/^\/status$/i.test(text)) {
    const inboxStats = durableInbox.stats();
    const deadIds = durableInbox.deadUpdates().slice(0, 10).map((entry) => entry.updateId);
    await sendMessage(
      chatId,
      [
        `${config.botName} bridge online | mode: ${codexMode}`,
        `thread: ${sessionId || 'not created yet'}`,
        `groups: ${allowedGroups.size} static + ${Object.keys(dynamicGroups).length} dynamic`,
        `updates: pending=${inboxStats.pending} (backoff=${inboxStats.delayed}) in-flight=${inFlightUpdates.size}`
        + ` group-replay=${inFlightGroupBatches.size} dead=${inboxStats.dead}`,
        deadIds.length ? `dead ids: ${deadIds.join(', ')}${inboxStats.dead > deadIds.length ? '...' : ''}` : '',
      ].filter(Boolean).join('\n'),
    );
    return;
  }

  if (/^\/session$/i.test(text)) {
    await sendMessage(chatId, `Current Codex thread: ${sessionId || 'not created yet'}`);
    return;
  }

  if (/^\/tools$/i.test(text)) {
    await sendMessage(
      chatId,
      [
        `Private tool mode: ${privateToolsEnabled ? 'enabled' : 'disabled'}`,
        `Writable roots: ${toolWritableRoots.join(', ')}`,
        `Network access: ${config.toolNetworkAccess === true ? 'enabled' : 'disabled'}`,
        'Group chats are always read-only.',
      ].join('\n'),
    );
    return;
  }

  const retryUpdateMatch = text.match(/^\/retry_update\s+(\d+)$/i);
  if (retryUpdateMatch) {
    if (fromId !== ownerUserId) {
      await sendMessage(chatId, '❌ /retry_update is owner-only.');
      return;
    }
    const updateId = Number(retryUpdateMatch[1]);
    const operation = durableUpdateId == null
      ? { status: 'intent' }
      : durableInbox.beginOperation(durableUpdateId, 'retry-update', { targetUpdateId: updateId });
    let reply;
    if (operation.status === 'result') {
      reply = String(operation.result.reply);
    } else {
      const requeued = durableInbox.requeueDead(updateId);
      const recoveredPriorSuccess = !requeued && durableInbox.updateState(updateId) === 'received';
      reply = requeued || recoveredPriorSuccess
        ? `✅ update ${updateId} moved back from the dead-letter queue.`
        : `update ${updateId} is not in the dead-letter queue, or its original record is unavailable.`;
      if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { reply });
      if (requeued || recoveredPriorSuccess) {
        dispatchDurableUpdates().catch((error) => log(`manual retry dispatch failed update=${updateId}: ${error.message}`));
      }
    }
    await sendDurablePrivateText(durableUpdateId, chatId, reply);
    return;
  }

  if (/^\/new$/i.test(text)) {
    const operation = durableUpdateId == null
      ? { status: 'intent', payload: { previousThreadId: sessionId } }
      : durableInbox.beginOperation(durableUpdateId, 'new-thread', { previousThreadId: sessionId });
    if (operation.status === 'result') {
      sessionId = String(operation.result.threadId);
    } else {
      const previousThreadId = operation.payload.previousThreadId || null;
      const persistedThreadId = readPrivateFile(sessionPath) || null;
      if (persistedThreadId && persistedThreadId !== previousThreadId) {
        // onReady persists the new id synchronously. If the process died after
        // the switch but before the operation result, recover that exact id
        // rather than creating a second replacement thread.
        sessionId = persistedThreadId;
      } else {
        if (previousThreadId) writePrivateFile(previousSessionPath, previousThreadId);
        sessionId = await modelQueue.run(() => codex.newThread(), 20);
      }
      if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { threadId: sessionId });
    }
    await sendDurablePrivateText(
      durableUpdateId,
      chatId,
      `A fresh Codex thread is ready: ${sessionId}\nThe previous thread id was saved for /resume.`,
      { threadId: sessionId },
    );
    return;
  }

  const resumeMatch = text.match(/^\/(?:resume|attach)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (resumeMatch) {
    const targetThreadId = resumeMatch[1].toLowerCase();
    const operation = durableUpdateId == null
      ? { status: 'intent', payload: { targetThreadId, previousThreadId: sessionId } }
      : durableInbox.beginOperation(durableUpdateId, 'resume-thread', {
        targetThreadId,
        previousThreadId: sessionId,
      });
    if (operation.status === 'result') {
      sessionId = String(operation.result.threadId);
    } else {
      const persistedThreadId = readPrivateFile(sessionPath) || null;
      if (persistedThreadId === operation.payload.targetThreadId) {
        sessionId = persistedThreadId;
      } else {
        if (sessionId && sessionId !== targetThreadId) writePrivateFile(previousSessionPath, sessionId);
        sessionId = await modelQueue.run(() => codex.resumeThread(targetThreadId), 20);
      }
      if (durableUpdateId != null) durableInbox.completeOperation(durableUpdateId, { threadId: sessionId });
    }
    await sendDurablePrivateText(durableUpdateId, chatId, `Switched to Codex thread: ${sessionId}`, { threadId: sessionId });
    return;
  }

  if (/^\/reload_config$/i.test(text)) {
    await handleReloadConfig(message, durableUpdateId);
    return;
  }
  const restartBridgeMatch = text.match(/^\/(force_)?restart_bridge$/i);
  if (restartBridgeMatch) {
    await handleRestartBridge(message, { force: Boolean(restartBridgeMatch[1]), durableUpdateId });
    return;
  }
  const restartDaemonMatch = text.match(/^\/(force_)?restart_daemon$/i);
  if (restartDaemonMatch) {
    await handleRestartDaemon(message, { force: Boolean(restartDaemonMatch[1]), durableUpdateId });
    return;
  }

  const typing = setInterval(() => {
    telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  typing.unref();

  try {
    const startedAt = Date.now();
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    if (durableUpdateId == null) {
      const generated = await modelQueue.run(() => askCodex(text, context, images, files), 10);
      await sendMessage(chatId, generated.reply);
    } else {
      await deliverDurablePrivateReply({
        inbox: durableInbox,
        updateId: durableUpdateId,
        chatId,
        generate: () => modelQueue.run(() => askCodex(text, context, images, files), 10),
        send: async (reply) => {
          await sendMessage(chatId, reply);
          return null;
        },
        onReplay: (delivery) => {
          log(`crash replay using the persisted reply update=${durableUpdateId} thread=${delivery.threadId || '?'}`);
          if (delivery.sent) log(`crash replay skipping an already acked send update=${durableUpdateId}`);
        },
      });
    }
    log(`private reply sent chat=${chatId} from=${fromId} elapsed_ms=${Date.now() - startedAt}`);
  } catch (error) {
    log(`private handling failed chat=${chatId}: ${error.message}`);
    throw error;
  } finally {
    clearInterval(typing);
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handleMessage(message, durableUpdateId = null) {
  const rawText = getTelegramMessageText(message);
  const messageHasAttachments = hasTelegramAttachments(message);
  if (!message || (!rawText && !messageHasAttachments)) return {};

  const fromId = String(message.from?.id || '');
  const chatId = String(message.chat?.id || '');
  const senderIsBot = Boolean(message.from?.is_bot);
  const senderUsername = String(message.from?.username || '');
  const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
    || senderUsername
    || fromId;
  const sentAt = Number(message.date || 0) * 1000 || Date.now();
  const isPrivate = message.chat?.type === 'private';
  const isGroup = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
  let groupConfig = null;
  let groupMentionContext = null;
  let shouldRememberCurrentGroupMessage = false;

  if (isPrivate) {
    if (!allowedUserIds.has(fromId)) {
      log(`ignore unauthorized private message from=${fromId || '?'}`);
      return {};
    }
  } else if (isGroup) {
    refreshDynamicGroups();
    const staticGroupConfig = allowedGroups.get(chatId) || null;
    // Gate commands run before the authorization check: /<prefix>_on is how a
    // group gets authorized in the first place.
    if (!senderIsBot && await handleGateCommand({
      message,
      rawText,
      chatId,
      fromId,
      isGroup,
      senderIsBot,
      ownerUserId,
      dynamicGroupsPath,
      commandPrefix: gateCommandPrefix,
      botName: config.botName,
      staticGroupConfig,
      sendMessage,
      log,
    })) {
      refreshDynamicGroups(true);
      return {};
    }

    groupConfig = staticGroupConfig || dynamicGroups[chatId] || null;
    if (!groupConfig) {
      log(`ignore unauthorized group chat=${chatId || '?'} from=${fromId || '?'}`);
      return {};
    }

    groupMentionContext = mentionContextOptions(groupConfig);
    const groupAllowedUsers = new Set((groupConfig.allowedUserIds || config.allowedUserIds).map(String));
    const allowHumanMember = !senderIsBot && groupConfig.allowAllHumanUsers === true;
    const allowBotMember = senderIsBot && groupConfig.allowAllBotUsers === true;
    const senderCanTrigger = groupAllowedUsers.has(fromId) || allowHumanMember || allowBotMember;
    const shouldRecordDeliveredMessage = groupMentionContext.recordAllDeliveredMessages === true || senderCanTrigger;
    const rememberPassiveGroupMessage = () => {
      if (!shouldRecordDeliveredMessage) return;
      rememberGroupMessage({
        chatId,
        messageId: message.message_id,
        text: passiveHistoryText(rawText, messageHasAttachments, groupMentionContext),
        senderIsBot,
        senderUsername,
        senderName,
        sentAt,
      }, groupMentionContext);
    };

    if (senderIsBot && isNonConversationalBotMessage(rawText)) {
      log(`ignore bridge/status bot message chat=${chatId} from=${fromId}`);
      return {};
    }

    if (!senderCanTrigger) {
      rememberPassiveGroupMessage();
      log(`ignore unauthorized group member chat=${chatId} from=${fromId || '?'}`);
      return {};
    }

    if (!senderIsBot) groupBotRuns.set(chatId, 0);

    const entities = getTelegramMessageEntities(message);
    const mentioned = entities.some((entity) => {
      if (entity.type !== 'mention') return false;
      return rawText
        .slice(entity.offset, entity.offset + entity.length)
        .toLowerCase() === `@${botUsername.toLowerCase()}`;
    });
    const repliedToBot = String(message.reply_to_message?.from?.id || '') === botId;
    const addressedCommand = new RegExp(
      `^\\/(?:start|status|new)@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    ).test(rawText);
    const allowUnaddressedBot = senderIsBot && groupConfig.allowUnaddressedBotMessages === true;
    const stopInstruction = !senderIsBot && isStopInstruction(rawText);
    // Being called by name counts as being addressed, not just an @mention.
    const mentionPatternHit = !senderIsBot && messageHitsMentionPatterns(rawText);

    if (
      groupConfig.requireMention !== false
      && !mentioned
      && !repliedToBot
      && !addressedCommand
      && !allowUnaddressedBot
      && !stopInstruction
      && !mentionPatternHit
    ) {
      rememberPassiveGroupMessage();
      return {};
    }

    shouldRememberCurrentGroupMessage = shouldRecordDeliveredMessage;

    if (senderIsBot) {
      const previousRun = groupBotRuns.get(chatId) || 0;
      const nextRun = previousRun + 1;
      groupBotRuns.set(chatId, nextRun);
      if (nextRun > Number(groupConfig.maxConsecutiveBotMessages || 8)) {
        rememberPassiveGroupMessage();
        log(`pause consecutive bot conversation chat=${chatId} from=${fromId} count=${nextRun}`);
        return {};
      }
    }
  } else {
    return {};
  }

  const mentionPattern = botUsername
    ? new RegExp(`@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    : null;
  const captionOrText = (mentionPattern ? rawText.replace(mentionPattern, '') : rawText).trim();
  const { images, files, notes: attachmentNotes } = await downloadTelegramAttachments(message, {
    token,
    imageCacheDir,
    fileCacheDir,
    log,
    maxImageBytes: Number(config.imageMaxBytes || DEFAULT_CONFIG.imageMaxBytes),
    maxFileBytes: Number(config.fileMaxBytes || DEFAULT_CONFIG.fileMaxBytes),
    maxPreviewChars: Number(config.attachmentTextMaxChars || DEFAULT_CONFIG.attachmentTextMaxChars),
  });
  const text = buildMessageTextWithAttachments(captionOrText, images, files, attachmentNotes);
  if (!text && !images.length && !files.length) {
    if (isGroup && shouldRememberCurrentGroupMessage) {
      rememberGroupMessage({
        chatId,
        messageId: message.message_id,
        text: passiveHistoryText(rawText, messageHasAttachments, groupMentionContext),
        senderIsBot,
        senderUsername,
        senderName,
        sentAt,
      }, groupMentionContext);
    }
    return {};
  }

  const context = {
    isGroup,
    chatId,
    chatTitle: message.chat?.title || groupConfig?.title || '',
    senderIsBot,
    senderUsername,
    senderName,
    groupProfile: groupConfig?.profile || '',
  };

  appendLiveLog({
    direction: 'in',
    chatType: isPrivate ? 'private' : 'group',
    chatId,
    chatTitle: context.chatTitle || null,
    messageId: message.message_id || null,
    sentAt: new Date(sentAt).toISOString(),
    senderId: fromId,
    senderName,
    senderUsername: senderUsername || null,
    senderIsBot,
    text: truncateLiveText(text),
    images: images.map(compactLiveAttachment),
    files: files.map(compactLiveAttachment),
  });

  if (isPrivate) {
    return {
      completion: privateMessageQueue.run(
        () => processPrivateMessage(message, text, context, images, files, durableUpdateId),
        10,
      ),
    };
  }

  if (shouldRememberCurrentGroupMessage) {
    rememberGroupMessage({
      chatId,
      messageId: message.message_id,
      text,
      senderIsBot,
      senderUsername,
      senderName,
      sentAt,
    }, groupMentionContext);
  }

  log(`authorized group message chat=${chatId} from=${fromId} sender=${senderUsername || senderName} bot=${senderIsBot}`);
  const queued = groupBatcher.enqueue({
    chatId,
    chatTitle: context.chatTitle,
    messageId: message.message_id,
    text,
    images,
    files,
    senderId: fromId,
    senderIsBot,
    senderUsername,
    senderName,
    sentAt,
    receivedAt: Date.now(),
    _durableUpdateId: Number(durableUpdateId),
  });
  return { completion: queued.completion };
}

async function checkConnection() {
  const me = await telegram('getMe');
  botId = String(me.id);
  botUsername = String(me.username || '');
  console.log(`Telegram OK: @${me.username} (${me.id})`);
}

// ---------------------------------------------------------------------------
// Durable dispatch
// ---------------------------------------------------------------------------

async function prepareTelegramUpdate(update) {
  if (update.callback_query) {
    return { completion: handleCallbackQuery(update.callback_query) };
  }
  if (update.message) return (await handleMessage(update.message, Number(update.update_id))) || {};
  return {};
}

function updateRetryOptions() {
  return {
    maxAttempts: Math.max(1, Number(config.updateMaxAttempts || DEFAULT_CONFIG.updateMaxAttempts)),
    baseDelayMs: Math.max(250, Number(config.updateRetryBaseMs || DEFAULT_CONFIG.updateRetryBaseMs)),
    maxDelayMs: Math.max(1000, Number(config.updateRetryMaxMs || DEFAULT_CONFIG.updateRetryMaxMs)),
  };
}

function recordUpdateFailure(update, error, phase) {
  const updateId = Number(update.update_id);
  const errorText = redactSensitiveText(error?.message || String(error || 'unknown'));
  const groupBatch = durableInbox.groupBatchForUpdate(updateId);
  if (groupBatch?.state === 'dead') {
    log(`group batch ${groupBatch.batchId} is already dead-lettered; not counting update=${updateId} again`);
    return;
  }
  let retry;
  try {
    retry = groupBatch
      ? durableInbox.markGroupBatchRetry(groupBatch.batchId, errorText, updateRetryOptions())
      : durableInbox.markRetry(updateId, errorText, updateRetryOptions());
  } catch (journalError) {
    log(`update ${updateId} failed during ${phase}, and the retry state could not be written: ${journalError.message}`);
    return;
  }

  if (retry.alreadyScheduled) return;

  if (retry.dead) {
    log(`update ${updateId} failed during ${phase} and moved to dead-letter (attempts=${retry.attempts}): ${errorText}`);
    sendMessage(
      ownerUserId,
      `⚠️ Telegram update ${updateId} failed ${retry.attempts} times and moved to the dead-letter queue; the original`
      + ` record is retained. Use /retry_update ${updateId} to try again. Phase: ${phase}\nError: ${errorText}`,
    ).catch((noticeError) => log(`dead-letter notice failed update=${updateId}: ${noticeError.message}`));
    return;
  }

  log(`update ${updateId} failed during ${phase}, retry=${retry.attempts} next=${new Date(retry.nextAttemptAt).toISOString()}: ${errorText}`);
  const privateChatId = update.message?.chat?.type === 'private' ? String(update.message.chat.id || '') : '';
  if (retry.attempts === 1 && privateChatId && allowedUserIds.has(privateChatId)) {
    sendMessage(privateChatId, 'That did not go through. Your message is queued for a local retry — no need to resend it.')
      .catch((noticeError) => log(`retry notice failed update=${updateId}: ${noticeError.message}`));
  } else if (retry.attempts === 1) {
    sendMessage(
      ownerUserId,
      `⚠️ Telegram update ${updateId} did not complete and is queued for a local retry; no need to resend. Phase: ${phase}`,
    ).catch((noticeError) => log(`first retry notice failed update=${updateId}: ${noticeError.message}`));
  }
}

async function replayDurableGroupBatch(record) {
  const batch = record.preparedMessages.map((message) => ({
    ...message,
    _durableGroupBatchId: record.batchId,
  }));
  if (
    !batch.length
    || batch.some((message) => {
      const updateId = Number(message._durableUpdateId);
      return !Number.isSafeInteger(updateId) || updateId < 0;
    })
  ) {
    throw new Error(`durable group batch ${record.batchId} has invalid contents`);
  }

  let replies = record.replies;
  let threadId = record.threadId;
  if (replies == null) {
    replies = await generateGroupReplies(batch, { superseding: false, replayBatchId: record.batchId });
    const refreshed = durableInbox.groupBatchForUpdate(record.updateIds[0]);
    threadId = refreshed?.threadId || batch[0]?._processedThreadId || null;
  } else {
    for (const message of batch) message._processedThreadId = threadId;
  }

  const chatId = String(record.chatId || batch.at(-1)?.chatId || '');
  for (const [replyIndex, reply] of replies.slice(0, 2).entries()) {
    if (durableInbox.isGroupReplyAcked(record.batchId, replyIndex)) {
      log(`crash replay skipping an acked reply batch=${record.batchId} reply=${replyIndex}`);
      continue;
    }
    const fallbackMessageId = [...batch].reverse().find((message) => !message.senderIsBot)?.messageId
      || batch.at(-1)?.messageId
      || null;
    const sent = await sendMessage(
      chatId,
      reply.text,
      reply.replyToMessageId || fallbackMessageId,
      { shouldSend: () => true },
    );
    if (!sent) throw new Error(`crash replay send skipped batch=${record.batchId} reply=${replyIndex}`);
    durableInbox.markGroupReplyAck(record.batchId, replyIndex);
  }

  if (!threadId) throw new Error(`crash replay has no threadId batch=${record.batchId}`);
  advanceGroupContextCursor(chatId, threadId, batch.map((message) => message.messageId));
  durableInbox.markGroupBatchDone(record.batchId);
  log(`crash replay done batch=${record.batchId} updates=${record.updateIds.join(',')}`);
}

function recordGroupBatchReplayFailure(record, error) {
  const errorText = redactSensitiveText(error?.message || String(error || 'unknown'));
  let retry;
  try {
    retry = durableInbox.markGroupBatchRetry(record.batchId, errorText, updateRetryOptions());
  } catch (journalError) {
    log(`group batch ${record.batchId} replay failed, and the retry state could not be written: ${journalError.message}`);
    return;
  }
  if (retry.alreadyScheduled) return;
  if (retry.dead) {
    log(`group batch ${record.batchId} replay failed and moved to dead-letter: ${errorText}`);
    sendMessage(
      ownerUserId,
      `⚠️ Telegram group batch ${record.batchId} failed ${retry.attempts} times and moved to the dead-letter queue;`
      + ` the original record is retained. Use /retry_update ${record.updateIds[0]} to try again.\nError: ${errorText}`,
    ).catch((noticeError) => log(`group dead-letter notice failed batch=${record.batchId}: ${noticeError.message}`));
    return;
  }
  log(`group batch ${record.batchId} replay failed, retry=${retry.attempts} next=${new Date(retry.nextAttemptAt).toISOString()}: ${errorText}`);
  if (retry.attempts === 1) {
    sendMessage(
      ownerUserId,
      `⚠️ Telegram group batch ${record.batchId} did not complete and is queued for a local retry; no need to resend.`,
    ).catch((noticeError) => log(`group replay notice failed batch=${record.batchId}: ${noticeError.message}`));
  }
}

async function replayPendingDurableGroupBatches() {
  for (const record of durableInbox.pendingGroupBatches()) {
    // A live in-process batcher run owns these promises. Exact replay is only
    // for crash/retry recovery, never a second concurrent sender while the
    // original generation or delivery is still running.
    if (record.updateIds.some((updateId) => inFlightUpdates.has(updateId))) break;
    if (inFlightGroupBatches.has(record.batchId)) continue;
    inFlightGroupBatches.add(record.batchId);
    try {
      await replayDurableGroupBatch(record);
    } catch (error) {
      recordGroupBatchReplayFailure(record, error);
      break;
    } finally {
      inFlightGroupBatches.delete(record.batchId);
    }
  }
}

async function runDurableDispatch() {
  await replayPendingDurableGroupBatches();
  const maxInFlight = Math.max(1, Number(config.updateMaxInFlight || DEFAULT_CONFIG.updateMaxInFlight));
  for (const update of durableInbox.pendingUpdates()) {
    const updateId = Number(update.update_id);
    if (inFlightUpdates.has(updateId)) continue;
    if (inFlightUpdates.size >= maxInFlight) break;

    let prepared;
    try {
      // Preparation is deliberately ordered: authorization, attachment
      // download and enqueue happen in update_id order. The long-running
      // model/send work is represented by `completion`, so later updates can
      // still join the same group batch.
      prepared = await prepareTelegramUpdate(update);
    } catch (error) {
      recordUpdateFailure(update, error, 'prepare');
      break;
    }

    const completion = Promise.resolve(prepared?.completion);
    const tracked = completion
      .then(() => {
        durableInbox.markDone(updateId);
      })
      .catch((error) => {
        recordUpdateFailure(update, error, 'completion');
      })
      .finally(() => {
        inFlightUpdates.delete(updateId);
      });
    inFlightUpdates.set(updateId, tracked);
  }
}

function dispatchDurableUpdates() {
  if (durableDispatchPromise) return durableDispatchPromise;
  durableDispatchPromise = runDurableDispatch().finally(() => {
    durableDispatchPromise = null;
  });
  return durableDispatchPromise;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function finishPendingRestartAck() {
  try {
    if (!fs.existsSync(restartStatePath)) return;
    const state = JSON.parse(fs.readFileSync(restartStatePath, 'utf8'));
    const age = Date.now() - Number(state.timestamp || 0);
    if (age < 30000 && state.chat_id && state.message_id && state.trigger === 'bridge') {
      await telegram('editMessageText', {
        chat_id: state.chat_id,
        message_id: state.message_id,
        text: `✅ Bridge restarted (${(age / 1000).toFixed(1)}s${state.force ? ', forced' : ''})`,
      }).catch((error) => log(`restart ack edit failed: ${error.message}`));
      log(`restart ack edited chat=${state.chat_id} msg=${state.message_id} age=${age}ms`);
    } else {
      log(`restart state is stale or invalid (age=${age}ms); skipping the ack edit`);
    }
    fs.unlinkSync(restartStatePath);
  } catch (error) {
    log(`restart state check failed: ${error.message}`);
  }
}

async function poll() {
  secureRuntimeFiles();
  const maintenanceTimer = setInterval(() => {
    secureRuntimeFiles();
    durableInbox.compactIfNeeded();
  }, 24 * 60 * 60 * 1000);
  maintenanceTimer.unref();

  await checkConnection();
  log(
    `${config.botName} Telegram bridge started; private users ${[...allowedUserIds].join(',')};`
    + ` groups ${[...allowedGroups.keys()].join(',') || 'none'}; session ${sessionId || 'new'}`,
  );
  await finishPendingRestartAck();

  if (config.outboxEnabled === true) {
    const outboxTimer = setInterval(() => {
      processOutbox().catch((error) => log(`outbox processing failed: ${error.message}`));
    }, Number(config.outboxPollMs || DEFAULT_CONFIG.outboxPollMs));
    outboxTimer.unref();
    await processOutbox();
  }

  const durableRetryTimer = setInterval(() => {
    dispatchDurableUpdates().catch((error) => log(`durable retry dispatch failed: ${error.message}`));
  }, Math.max(1000, Math.min(30000, Number(config.updateRetryBaseMs || DEFAULT_CONFIG.updateRetryBaseMs))));
  durableRetryTimer.unref();
  await dispatchDurableUpdates();

  for (;;) {
    try {
      const updates = await telegram('getUpdates', {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });

      for (const update of updates) {
        // Durable acceptance has to happen before the Telegram offset moves:
        // otherwise a crash here loses the update for good.
        durableInbox.recordReceived(update);
        updateOffset = Math.max(updateOffset, Number(update.update_id) + 1);
        writePrivateFile(offsetPath, String(updateOffset));
      }
      await dispatchDurableUpdates();
    } catch (error) {
      log(`poll failed; retrying in 3s: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

if (args.testPrompt) {
  askCodex(args.testPrompt, { isGroup: false, senderName: config.ownerName }, [])
    .then((generated) => {
      console.log(generated.reply);
      codex.close();
      process.exit(0);
    })
    .catch((error) => {
      console.error(error.message);
      codex?.close();
      process.exit(1);
    });
} else if (checkOnly) {
  checkConnection().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  poll().catch((error) => {
    console.error(error.message);
    codex?.close();
    process.exit(1);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    codex?.close();
    process.exit(0);
  });
}
