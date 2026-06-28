#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { CodexAppClient } from './codex-client.mjs';
import { CodexDaemonClient } from './codex-daemon-client.mjs';
import {
  GroupConversationBatcher,
  PriorityTaskQueue,
  isNonConversationalBotMessage,
  isStopInstruction,
  parseBatchReplies,
} from './group-batcher.mjs';
import { SendRateLimiter } from './rate-limit.mjs';
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
  allowedGroups: {},
  codexPath: '/usr/local/bin/codex',
  codexMode: 'spawn',
  daemonSocketPath: '',
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

function writePrivateFile(filePath, value) {
  fs.writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function resolvePath(baseDir, maybePath) {
  if (!maybePath) return maybePath;
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(baseDir, maybePath);
}

function redactSensitiveText(value) {
  return String(value || '').replace(/\b\d+:[A-Za-z0-9_-]{30,}\b/g, '[telegram-token-redacted]');
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
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

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Put it in .env or the process environment.');
  process.exit(1);
}

const allowedUserIds = new Set((config.allowedUserIds || []).map(String));
if (!allowedUserIds.size) {
  console.error('config.allowedUserIds must contain at least one Telegram user id.');
  process.exit(1);
}

const allowedGroups = new Map(Object.entries(config.allowedGroups || {}));
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
const telegramApi = `https://api.telegram.org/bot${token}`;
const checkOnly = args.checkOnly;
let sessionId = readPrivateFile(sessionPath) || null;
let updateOffset = Number(readPrivateFile(offsetPath) || 0);
let botId = '';
let botUsername = '';
const groupHistories = new Map();
const groupBotRuns = new Map();
const modelQueue = new PriorityTaskQueue();
const rateLimiter = new SendRateLimiter({
  enabled: config.rateLimit.enabled,
  minIntervalMs: config.rateLimit.minIntervalMs,
  stateDir: path.join(stateDir, 'rate-limit'),
  log,
});

function batchTimingForGroup(chatId) {
  const groupConfig = allowedGroups.get(String(chatId)) || {};
  return {
    ...globalGroupBatchTiming,
    ...normalizeBatchTiming(groupConfig.batchTiming || {}),
  };
}
// codexMode: 'spawn' (v1, default, backward compatible) spawns a `codex
// app-server --stdio` child per bridge process. State is per-process — if
// you also open Codex.app or `codex --remote` on the same machine they will
// each have their own isolated in-memory thread state.
//
// codexMode: 'daemon' (v2) connects to a long-running `codex app-server
// --listen unix://PATH` daemon (managed e.g. by a launchd plist). The same
// thread can then be attached by the bridge AND a `codex --remote unix://PATH`
// TUI session at the same time, with the daemon broadcasting events to all
// subscribers. Set `daemonSocketPath` (defaults to
// $CODEX_HOME/app-server-control/app-server-control.sock) to override.
const codexMode = config.codexMode === 'daemon' ? 'daemon' : 'spawn';
const defaultDaemonSocket = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  'app-server-control/app-server-control.sock',
);
const daemonSocketPath = config.daemonSocketPath
  ? resolvePath(bridgeRoot, config.daemonSocketPath)
  : defaultDaemonSocket;

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
      // If the underlying client fell back from thread/resume to thread/start
      // (e.g. the rollout for the previous thread was missing on disk), save
      // the old session id so /resume can still recover it later.
      if (sessionId && sessionId !== threadId) {
        log(`Codex thread switched: old ${sessionId} -> new ${threadId} (saving old to session.previous.txt)`);
        writePrivateFile(previousSessionPath, sessionId);
      }
      sessionId = threadId;
      writePrivateFile(sessionPath, threadId);
      log(`Codex ${codexMode} ready; session ${threadId}`);
    },
    onThreadChange: (info) => {
      // daemon-client emits this immediately before swapping thread ids on a
      // resume failure, so the bridge can preserve the previous id even if
      // the eventual onReady call doesn't run for any reason.
      if (info?.previousThreadId) {
        log(`Codex thread fallback (reason=${info.reason}); saving previous thread ${info.previousThreadId}`);
        writePrivateFile(previousSessionPath, info.previousThreadId);
      }
    },
    onSecurityEvent: (event) => {
      const params = event.params || {};
      const command = Array.isArray(params.command) ? params.command.join(' ') : params.command;
      const summary = redactSensitiveText(command || params.reason || params.method || params.grantRoot || '');
      log(`tool approval ${event.kind} decision=${event.decision}${summary ? ` summary=${summary.slice(0, 240)}` : ''}`);
    },
  };

  if (codexMode === 'daemon') {
    log(`Codex mode: daemon (socket=${daemonSocketPath})`);
    return new CodexDaemonClient({ ...sharedOpts, socketPath: daemonSocketPath });
  }
  log(`Codex mode: spawn (codexPath=${codexPath})`);
  return new CodexAppClient({ ...sharedOpts, codexPath });
}

const codex = checkOnly ? null : makeCodexClient();

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
  return chunks.length ? chunks : ['(Codex produced no sendable text.)'];
}

async function sendMessage(chatId, text, replyToMessageId = null, options = {}) {
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
  }
  return true;
}

function buildPrivatePrompt(text, images = [], files = []) {
  const payload = {
    mode: 'TG_PRIVATE',
    botName: config.botName,
    ownerName: config.ownerName,
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

function numberOption(value, fallback, min = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

function mentionContextOptions(groupConfig = {}) {
  return {
    ...config.mentionContext,
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

function recentGroupContext(chatId, options) {
  if (options.enabled === false) return [];
  const count = Math.floor(numberOption(options.messageCount, 10, 0));
  if (!count) return [];
  return [...(groupHistories.get(String(chatId)) || [])].slice(-count);
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

function buildGroupPrompt(text, context, images = [], files = []) {
  const sender = context.senderName || context.senderUsername || 'unknown sender';
  const payload = {
    mode: 'TG_GROUP_MESSAGE',
    botName: config.botName,
    ownerName: config.ownerName,
    chatId: context.chatId,
    chatTitle: context.chatTitle || 'group',
    profile: context.groupProfile || null,
    sender,
    username: context.senderUsername || null,
    senderIsBot: context.senderIsBot,
    images: images.length,
    files: files.length,
    recentContext: context.recentContext || [],
    text,
  };
  return [
    'TG_GROUP_MESSAGE',
    'Follow the Telegram bridge protocol from AGENTS.md. Reply with the Telegram message body only.',
    JSON.stringify(payload),
  ].join('\n');
}

async function askCodex(text, context, images = [], files = []) {
  const prompt = context.isGroup
    ? buildGroupPrompt(text, context, images, files)
    : buildPrivatePrompt(text, images, files);
  const result = await codex.ask(
    prompt,
    images,
    { toolMode: context.isGroup ? 'read-only' : (privateToolsEnabled ? 'private-tools' : 'read-only') },
  );
  sessionId = result.threadId;
  return result.reply;
}

function buildGroupBatchPrompt(batch, { superseding }) {
  const chatTitle = batch.at(-1)?.chatTitle || 'group';
  const chatId = String(batch.at(-1)?.chatId || '');
  const groupConfig = allowedGroups.get(chatId) || {};
  const imageCount = batch.reduce((sum, message) => sum + (message.images || []).length, 0);
  const fileCount = batch.reduce((sum, message) => sum + (message.files || []).length, 0);
  const messages = batch.map((message) => ({
    messageId: message.messageId,
    sentAt: new Date(message.sentAt || message.receivedAt).toISOString(),
    sender: message.senderName,
    username: message.senderUsername || null,
    senderIsBot: message.senderIsBot,
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
  const currentMessageIds = new Set(batch.map((message) => Number(message.messageId)));
  const recentContext = [];
  const seenContextIds = new Set();
  for (const message of batch) {
    for (const entry of message.recentContext || []) {
      const entryId = Number(entry.messageId);
      if (currentMessageIds.has(entryId) || seenContextIds.has(entryId)) continue;
      seenContextIds.add(entryId);
      recentContext.push(entry);
    }
  }
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
    recentContext,
    messages,
  };

  return [
    'TG_GROUP_BATCH',
    'Follow the Telegram bridge protocol from AGENTS.md. Strict JSON only: {"replies":[{"text":"...","replyToMessageId":123|null}]}',
    JSON.stringify(payload),
  ].join('\n');
}

async function generateGroupReplies(batch, options) {
  const chatId = batch.at(-1).chatId;
  const typing = setInterval(() => {
    telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  typing.unref();

  try {
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' });
    const images = batch.flatMap((message) => message.images || []);
    const result = await modelQueue.run(
      () => codex.ask(buildGroupBatchPrompt(batch, options), images, { toolMode: 'read-only' }),
      0,
    );
    sessionId = result.threadId;
    return parseBatchReplies(result.reply, batch.map((message) => message.messageId));
  } finally {
    clearInterval(typing);
  }
}

async function notifyGroupFailure(chatId, error, batch) {
  const source = batch.at(-1)?.chatTitle || chatId;
  const targetUserId = [...allowedUserIds][0];
  await sendMessage(
    targetUserId,
    `[bridge-status] ${config.botName} failed to generate a group reply for "${source}". This batch was stopped and bot-triggered replies are paused briefly. Error: ${error.message}`,
  );
}

const groupBatcher = new GroupConversationBatcher({
  getTiming: batchTimingForGroup,
  generateReplies: generateGroupReplies,
  sendReply: async (chatId, reply, batch, shouldSend) => {
    const fallbackMessageId = [...batch].reverse().find((message) => !message.senderIsBot)?.messageId
      || batch.at(-1)?.messageId
      || null;
    return sendMessage(
      chatId,
      reply.text,
      reply.replyToMessageId || fallbackMessageId,
      { shouldSend },
    );
  },
  notifyFailure: notifyGroupFailure,
  log,
  timing: config.batchTiming,
});

async function processPrivateMessage(message, text, context, images = [], files = []) {
  const chatId = String(message.chat.id);
  const fromId = String(message.from.id);
  log(`authorized private message chat=${chatId} from=${fromId}`);

  if (/^\/start$/i.test(text)) {
    await sendMessage(chatId, `${config.botName} is online.`);
    return;
  }

  if (/^\/status$/i.test(text)) {
    await sendMessage(
      chatId,
      `${config.botName} bridge online | session: ${sessionId || 'not created yet'} | groups: ${[...allowedGroups.keys()].length}`,
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

  if (/^\/new$/i.test(text)) {
    if (sessionId) writePrivateFile(previousSessionPath, sessionId);
    sessionId = await modelQueue.run(() => codex.newThread(), 20);
    await sendMessage(chatId, 'A fresh Codex session is ready. The previous session id was preserved locally.');
    return;
  }

  const resumeMatch = text.match(/^\/(?:resume|attach)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (resumeMatch) {
    const targetThreadId = resumeMatch[1].toLowerCase();
    if (sessionId && sessionId !== targetThreadId) writePrivateFile(previousSessionPath, sessionId);
    sessionId = await modelQueue.run(() => codex.resumeThread(targetThreadId), 20);
    await sendMessage(chatId, `Switched to Codex thread: ${sessionId}`);
    return;
  }

  const typing = setInterval(() => {
    telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  typing.unref();

  try {
    const startedAt = Date.now();
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' });
    const reply = await modelQueue.run(() => askCodex(text, context, images, files), 10);
    await sendMessage(chatId, reply);
    log(`private reply sent chat=${chatId} from=${fromId} elapsed_ms=${Date.now() - startedAt}`);
  } catch (error) {
    log(`private handling failed chat=${chatId}: ${error.message}`);
    await sendMessage(chatId, `${config.botName} failed to reply. The error was logged locally; please try again.`);
  } finally {
    clearInterval(typing);
  }
}

async function handleMessage(message) {
  const rawText = getTelegramMessageText(message);
  const messageHasAttachments = hasTelegramAttachments(message);
  if (!message || (!rawText && !messageHasAttachments)) return;

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
  let recentContextForReply = [];

  if (isPrivate) {
    if (!allowedUserIds.has(fromId)) {
      log(`ignore unauthorized private message from=${fromId || '?'}`);
      return;
    }
  } else if (isGroup) {
    groupConfig = allowedGroups.get(chatId);
    if (!groupConfig) {
      log(`ignore unauthorized group chat=${chatId || '?'} from=${fromId || '?'}`);
      return;
    }

    groupMentionContext = mentionContextOptions(groupConfig);
    const groupAllowedUsers = new Set((groupConfig.allowedUserIds || config.allowedUserIds).map(String));
    const allowHumanMember = !senderIsBot && groupConfig.allowAllHumanUsers === true;
    const allowBotMember = senderIsBot && groupConfig.allowAllBotUsers === true;
    const senderCanTrigger = groupAllowedUsers.has(fromId) || allowHumanMember || allowBotMember;
    const shouldRecordDeliveredMessage = (
      groupMentionContext.recordAllDeliveredMessages === true
      || senderCanTrigger
    );
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
      return;
    }

    if (!senderCanTrigger) {
      rememberPassiveGroupMessage();
      log(`ignore unauthorized group member chat=${chatId} from=${fromId || '?'}`);
      return;
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
    const addressedToThisBot = mentioned || repliedToBot || addressedCommand;

    if (
      groupConfig.requireMention !== false
      && !mentioned
      && !repliedToBot
      && !addressedCommand
      && !allowUnaddressedBot
      && !stopInstruction
    ) {
      rememberPassiveGroupMessage();
      return;
    }

    recentContextForReply = addressedToThisBot
      ? recentGroupContext(chatId, groupMentionContext)
      : [];
    shouldRememberCurrentGroupMessage = shouldRecordDeliveredMessage;

    if (senderIsBot) {
      const previousRun = groupBotRuns.get(chatId) || 0;
      const nextRun = previousRun + 1;
      groupBotRuns.set(chatId, nextRun);
      if (nextRun > Number(groupConfig.maxConsecutiveBotMessages || 8)) {
        rememberPassiveGroupMessage();
        log(`pause consecutive bot conversation chat=${chatId} from=${fromId} count=${nextRun}`);
        return;
      }
    }
  } else {
    return;
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
    return;
  }

  const context = {
    isGroup,
    chatId,
    chatTitle: message.chat?.title || groupConfig?.title || '',
    senderIsBot,
    senderUsername,
    senderName,
    groupProfile: groupConfig?.profile || '',
    recentContext: recentContextForReply,
  };

  if (isPrivate) {
    await processPrivateMessage(message, text, context, images, files);
    return;
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
  groupBatcher.enqueue({
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
    recentContext: recentContextForReply,
  });
}

async function checkConnection() {
  const me = await telegram('getMe');
  botId = String(me.id);
  botUsername = String(me.username || '');
  console.log(`Telegram OK: @${me.username} (${me.id})`);
}

async function poll() {
  await checkConnection();
  log(
    `${config.botName} Telegram bridge started; private users ${[...allowedUserIds].join(',')}; groups ${[...allowedGroups.keys()].join(',') || 'none'}; session ${sessionId || 'new'}`,
  );

  for (;;) {
    try {
      const updates = await telegram('getUpdates', {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        updateOffset = update.update_id + 1;
        writePrivateFile(offsetPath, String(updateOffset));
        handleMessage(update.message).catch((error) => {
          log(`update ${update.update_id} dispatch failed: ${error.message}`);
        });
      }
    } catch (error) {
      log(`poll failed; retrying in 3s: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

if (args.testPrompt) {
  askCodex(args.testPrompt, { isGroup: false }, [])
    .then((reply) => {
      console.log(reply);
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
