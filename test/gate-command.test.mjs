// Dynamic group authorization.
//
// These commands are the only way a group gets authorized without editing
// config.json, so the checks that matter here are the negative ones: a
// non-owner must not be able to open a group, a bot must not be able to, a
// statically configured group must never be silently rewritten, and a corrupt
// state file must not be treated as "no groups yet" and overwritten.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DYNAMIC_GROUP_CONFIG,
  handleGateCommand,
  parseGateCommand,
  readDynamicGroups,
} from '../src/gate-command.mjs';

const PREFIX = 'codex';
const OWNER_ID = '123456789';

async function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tg-gate-'));
  try {
    return await run(path.join(dir, 'dynamic-groups.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeMessage(text, overrides = {}) {
  return {
    message_id: overrides.messageId || 101,
    chat: {
      id: overrides.chatId || -12345,
      title: overrides.title || 'Test group',
      type: 'supergroup',
    },
    from: { id: overrides.fromId || OWNER_ID, is_bot: overrides.senderIsBot || false },
    text,
  };
}

async function runGate(dynamicGroupsPath, text, overrides = {}) {
  const calls = [];
  const message = makeMessage(text, overrides);
  const handled = await handleGateCommand({
    message,
    rawText: text,
    chatId: String(message.chat.id),
    fromId: String(message.from.id),
    isGroup: overrides.isGroup ?? true,
    senderIsBot: Boolean(message.from.is_bot),
    ownerUserId: OWNER_ID,
    dynamicGroupsPath,
    commandPrefix: PREFIX,
    botName: 'Codex',
    staticGroupConfig: overrides.staticGroupConfig || null,
    sendMessage: async (...args) => { calls.push(args); },
    log: () => {},
  });
  return { handled, calls, groups: readDynamicGroups(dynamicGroupsPath) };
}

test('parseGateCommand only matches a bare command', () => {
  assert.equal(parseGateCommand('/codex_on', PREFIX), 'on');
  assert.equal(parseGateCommand('/codex_off@my_bot', PREFIX), 'off');
  assert.equal(parseGateCommand('/Codex_all', PREFIX), 'all');
  assert.equal(parseGateCommand('/Codex_quiet', PREFIX), 'quiet');
  assert.equal(parseGateCommand('please run /codex_on for me', PREFIX), null);
  assert.equal(parseGateCommand('/codex_on now', PREFIX), null);
  assert.equal(parseGateCommand('/otherbot_on', PREFIX), null);
});

test('the owner can open and close a group, with conservative defaults', async () => {
  await withTempDir(async (dynamicGroupsPath) => {
    let result = await runGate(dynamicGroupsPath, '/codex_on');
    assert.equal(result.handled, true);
    const groupConfig = result.groups['-12345'];
    assert.ok(groupConfig, 'the group was written to the dynamic file');
    assert.equal(groupConfig.requireMention, true);
    assert.equal(groupConfig.allowUnaddressedBotMessages, false);
    assert.equal(
      groupConfig.maxConsecutiveBotMessages,
      DEFAULT_DYNAMIC_GROUP_CONFIG.maxConsecutiveBotMessages,
    );
    assert.match(result.calls[0]?.[1] || '', /Mention-only by default/);

    result = await runGate(dynamicGroupsPath, '/codex_off');
    assert.equal(result.handled, true);
    assert.equal(Boolean(result.groups['-12345']), false);
  });
});

test('the @botname suffix form works', async () => {
  await withTempDir(async (dynamicGroupsPath) => {
    const result = await runGate(dynamicGroupsPath, '/codex_on@my_bot', { chatId: -22222 });
    assert.equal(result.handled, true);
    assert.ok(result.groups['-22222']);
  });
});

test('a non-owner is refused and changes nothing', async () => {
  await withTempDir(async (dynamicGroupsPath) => {
    const result = await runGate(dynamicGroupsPath, '/codex_on', { fromId: '987654321' });
    assert.equal(result.handled, true, 'the command is consumed, not passed through to the model');
    assert.equal(Boolean(result.groups['-12345']), false);
    assert.match(result.calls[0]?.[1] || '', /Only the bridge owner/);
  });
});

test('a bot sender and a private chat never trigger the gate', async () => {
  await withTempDir(async (dynamicGroupsPath) => {
    const fromBot = await runGate(dynamicGroupsPath, '/codex_on', { senderIsBot: true, chatId: -33333 });
    assert.equal(fromBot.handled, false);

    const inPrivate = await runGate(dynamicGroupsPath, '/codex_on', { isGroup: false, chatId: OWNER_ID });
    assert.equal(inPrivate.handled, false);
  });
});

test('a statically configured group is never rewritten by a gate command', async () => {
  await withTempDir(async (dynamicGroupsPath) => {
    const staticGroupConfig = { title: 'Static group' };

    let result = await runGate(dynamicGroupsPath, '/codex_on', { chatId: -44444, staticGroupConfig });
    assert.equal(result.handled, true);
    assert.equal(Boolean(result.groups['-44444']), false, 'no dynamic overlay is created');
    assert.match(result.calls[0]?.[1] || '', /config\.json/);

    result = await runGate(dynamicGroupsPath, '/codex_off', { chatId: -44444, staticGroupConfig });
    assert.equal(result.handled, true);
    assert.match(result.calls[0]?.[1] || '', /only manages dynamically authorized groups/);
  });
});

test('all and quiet toggle requireMention and keep the file at 0600', async () => {
  await withTempDir(async (dynamicGroupsPath) => {
    let result = await runGate(dynamicGroupsPath, '/codex_all', { chatId: -55555 });
    assert.equal(result.handled, true);
    assert.equal(result.groups['-55555']?.requireMention, false);

    result = await runGate(dynamicGroupsPath, '/codex_quiet', { chatId: -55555 });
    assert.equal(result.handled, true);
    assert.equal(result.groups['-55555']?.requireMention, true);

    assert.equal(fs.statSync(dynamicGroupsPath).mode & 0o777, 0o600);
  });
});

test('a corrupt dynamic group file fails closed instead of being overwritten', async () => {
  await withTempDir(async (dynamicGroupsPath) => {
    fs.writeFileSync(dynamicGroupsPath, '{broken json', { mode: 0o600 });

    await assert.rejects(
      () => runGate(dynamicGroupsPath, '/codex_on', { chatId: -66666 }),
      'a mutating command must not treat unreadable state as empty',
    );
    assert.equal(
      fs.readFileSync(dynamicGroupsPath, 'utf8'),
      '{broken json',
      'the corrupt file is left alone rather than replaced with a fresh one',
    );
  });
});
