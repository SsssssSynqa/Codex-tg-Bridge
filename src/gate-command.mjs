// Dynamic group authorization ("gate commands").
//
// Without this, adding the bot to a new group means editing config.json and
// restarting the bridge. These four owner-only commands let the owner authorize
// a group from inside the group itself, in real time:
//
//   /<prefix>_on     authorize this group (conservative defaults: mention-only)
//   /<prefix>_off    remove this group's dynamic authorization
//   /<prefix>_all    read every message in this group (requireMention: false)
//   /<prefix>_quiet  back to mention-only (requireMention: true)
//
// `<prefix>` comes from config (`gateCommandPrefix`, defaulting to `botName`),
// so a bot named "Codex" answers to /codex_on.
//
// Dynamic authorizations live in their own file (.dynamic-groups.json, 0600)
// and are a separate layer from `allowedGroups` in config.json. These commands
// never edit config.json, and never remove a statically configured group.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DYNAMIC_GROUP_CONFIG = Object.freeze({
  requireMention: true,
  allowUnaddressedBotMessages: false,
  maxConsecutiveBotMessages: 2,
});

export function normalizeGatePrefix(prefix) {
  const cleaned = String(prefix || '').trim().replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  return cleaned || 'bot';
}

export function makeGateCommandPattern(prefix) {
  return new RegExp(`^\\/${normalizeGatePrefix(prefix)}_(on|off|all|quiet)(?:@\\w+)?\\s*$`, 'i');
}

export function parseGateCommand(rawText, prefix) {
  const match = String(rawText || '').trim().match(makeGateCommandPattern(prefix));
  return match ? match[1].toLowerCase() : null;
}

export function readDynamicGroups(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readDynamicGroupsForWrite(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('dynamic groups file is not a JSON object');
  }
  return parsed;
}

export function writeDynamicGroups(filePath, groups) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(groups, null, 2), { encoding: 'utf8', mode: 0o600 });
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

function dynamicGroupConfig(previous, title) {
  return {
    title,
    enabledAt: new Date().toISOString(),
    requireMention: previous?.requireMention ?? DEFAULT_DYNAMIC_GROUP_CONFIG.requireMention,
    allowUnaddressedBotMessages: previous?.allowUnaddressedBotMessages
      ?? DEFAULT_DYNAMIC_GROUP_CONFIG.allowUnaddressedBotMessages,
    maxConsecutiveBotMessages: previous?.maxConsecutiveBotMessages
      || DEFAULT_DYNAMIC_GROUP_CONFIG.maxConsecutiveBotMessages,
  };
}

/**
 * Returns true when the message was a gate command and has been consumed, so
 * the caller must not fall through to normal group routing.
 */
export async function handleGateCommand({
  message,
  rawText,
  chatId,
  fromId,
  isGroup,
  senderIsBot,
  ownerUserId,
  dynamicGroupsPath,
  commandPrefix = 'bot',
  botName = 'The bot',
  staticGroupConfig = null,
  sendMessage,
  log = () => {},
}) {
  const prefix = normalizeGatePrefix(commandPrefix);
  const action = parseGateCommand(rawText, prefix);
  if (!action || !isGroup || senderIsBot) return false;

  const replyTo = message?.message_id || null;
  const chatTitle = message?.chat?.title || chatId;

  if (String(fromId) !== String(ownerUserId)) {
    log(`[gate] non-owner attempted /${prefix}_${action} chat=${chatId} from=${fromId}`);
    await sendMessage(chatId, 'Only the bridge owner can change this setting.', replyTo).catch(() => {});
    return true;
  }

  // Commands that mutate the file fail closed on corruption. Silently treating
  // malformed JSON as {} here would erase every previously authorized group.
  const groups = readDynamicGroupsForWrite(dynamicGroupsPath);
  const existingDynamic = groups[chatId];

  if (action === 'all' || action === 'quiet') {
    if (staticGroupConfig) {
      log(`[gate] /${prefix}_${action} hit a statically configured group chat=${chatId} (${chatTitle}); config.json untouched`);
      await sendMessage(
        chatId,
        `This group is configured in config.json. Change \`requireMention\` there and run /reload_config.`,
        replyTo,
      ).catch(() => {});
      return true;
    }
    const base = existingDynamic || dynamicGroupConfig(null, chatTitle);
    groups[chatId] = { ...base, title: chatTitle, requireMention: action === 'quiet' };
    writeDynamicGroups(dynamicGroupsPath, groups);
    log(`[gate] ${action} chat=${chatId} (${chatTitle}) requireMention=${groups[chatId].requireMention}`);
    await sendMessage(chatId, action === 'all'
      ? `${botName} will now read every message in this group. Send /${prefix}_quiet to go back to mention-only.`
      : `${botName} is back to mention-only — mention or reply to me to get an answer.`, replyTo).catch(() => {});
    return true;
  }

  if (action === 'on') {
    if (staticGroupConfig) {
      log(`[gate] /${prefix}_on hit a statically configured group chat=${chatId} (${chatTitle})`);
      await sendMessage(
        chatId,
        `${botName} is already configured for this group in config.json; no dynamic gate needed.`,
        replyTo,
      ).catch(() => {});
      return true;
    }

    groups[chatId] = dynamicGroupConfig(existingDynamic, chatTitle);
    writeDynamicGroups(dynamicGroupsPath, groups);
    log(`[gate] enabled chat=${chatId} (${chatTitle}) requireMention=${groups[chatId].requireMention} maxBot=${groups[chatId].maxConsecutiveBotMessages}`);
    await sendMessage(
      chatId,
      `${botName} is live in this group (authorized by the owner). Mention-only by default — I will not jump into the conversation on my own.`,
      replyTo,
    ).catch(() => {});
    return true;
  }

  if (staticGroupConfig) {
    log(`[gate] /${prefix}_off hit a statically configured group chat=${chatId} (${chatTitle}); config.json untouched`);
    await sendMessage(
      chatId,
      `This group is configured in config.json. /${prefix}_off only manages dynamically authorized groups.`,
      replyTo,
    ).catch(() => {});
    return true;
  }

  if (existingDynamic) {
    delete groups[chatId];
    writeDynamicGroups(dynamicGroupsPath, groups);
    log(`[gate] disabled chat=${chatId} (${chatTitle})`);
    await sendMessage(chatId, `${botName} is now off in this group.`, replyTo).catch(() => {});
  } else {
    log(`[gate] /${prefix}_off hit a group with no dynamic authorization chat=${chatId} (${chatTitle})`);
    await sendMessage(chatId, `${botName} is not dynamically enabled in this group.`, replyTo).catch(() => {});
  }
  return true;
}
