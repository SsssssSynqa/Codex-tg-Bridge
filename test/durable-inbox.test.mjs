// Crash-recovery behaviour of the durable update inbox.
//
// Delivery is deliberately at-least-once: an update is only marked done after
// Telegram has accepted every reply, so a crash replays instead of dropping a
// message. What these tests pin down is the other half of that promise — a
// replay must not re-run the model, must not resend an already acknowledged
// reply, and must not repeat a thread switch or a restart.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deliverDurablePrivateReply, DurableUpdateInbox } from '../src/durable-update-inbox.mjs';
import { GroupConversationBatcher } from '../src/group-batcher.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codex-tg-${prefix}-`));
}

const INSTANT_TIMING = {
  singleMessageMs: 0,
  sameSenderIdleMs: 0,
  sameSenderMaxMs: 0,
  multiSenderIdleMs: 0,
  multiSenderMaxMs: 0,
};

test('only unfinished updates replay after a restart', () => {
  const dir = tempDir('inbox');
  const journal = path.join(dir, 'updates.jsonl');
  const rawArchive = path.join(dir, 'raw.jsonl');
  const inbox = new DurableUpdateInbox(journal, { compactBytes: 1, keepDone: 2, rawArchivePath: rawArchive });
  inbox.recordReceived({ update_id: 10, message: { text: 'a' } });
  inbox.recordReceived({ update_id: 11, message: { text: 'b' } });
  inbox.markDone(10);

  const reloaded = new DurableUpdateInbox(journal, { compactBytes: 1024, keepDone: 2 });
  assert.deepEqual(reloaded.pendingUpdates().map((update) => update.update_id), [11]);
  assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  assert.equal(fs.statSync(rawArchive).mode & 0o777, 0o600);
  // The raw archive is append-only and never compacted, so every accepted
  // update stays recoverable even after the operational journal is trimmed.
  assert.deepEqual(
    fs.readFileSync(rawArchive, 'utf8').trim().split('\n').map((line) => JSON.parse(line).updateId),
    [10, 11],
  );
});

test('retry backoff preserves order and dead letters can be requeued', () => {
  const dir = tempDir('retry');
  const inbox = new DurableUpdateInbox(path.join(dir, 'updates.jsonl'));
  inbox.recordReceived({ update_id: 20, message: { text: 'first' } });
  inbox.recordReceived({ update_id: 21, message: { text: 'second' } });

  const retry = inbox.markRetry(20, 'offline', { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000 });
  assert.deepEqual(inbox.pendingUpdates(retry.nextAttemptAt - 1), [], 'nothing is due before the backoff expires');
  assert.deepEqual(inbox.pendingUpdates(retry.nextAttemptAt).map((u) => u.update_id), [20, 21]);

  const dead = inbox.markRetry(20, 'still offline', { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000 });
  assert.equal(dead.dead, true);
  assert.deepEqual(inbox.deadUpdates().map((entry) => entry.updateId), [20]);
  assert.equal(inbox.requeueDead(20), true);
  assert.deepEqual(inbox.pendingUpdates().map((u) => u.update_id), [20, 21]);
});

test('group crash replay preserves membership, replies and per-reply acks', () => {
  const dir = tempDir('group-replay');
  const journal = path.join(dir, 'updates.jsonl');
  const inbox = new DurableUpdateInbox(journal, { compactBytes: 1024 * 1024 });
  for (const updateId of [30, 31, 32]) {
    inbox.recordReceived({ update_id: updateId, message: { text: `u${updateId}` } });
  }
  inbox.markGroupBatch({
    batchId: 'group-batch-30-31',
    chatId: '-100',
    updateIds: [30, 31],
    preparedMessages: [
      { chatId: '-100', messageId: 300, text: 'a', _durableUpdateId: 30 },
      { chatId: '-100', messageId: 301, text: 'b', _durableUpdateId: 31 },
    ],
  });
  inbox.markGroupBatchReplies(
    'group-batch-30-31',
    [{ text: 'first', replyToMessageId: 300 }, { text: 'second', replyToMessageId: 301 }],
    'locked-thread',
  );
  inbox.markGroupReplyAck('group-batch-30-31', 0);
  inbox.compactIfNeeded(true);

  const reloaded = new DurableUpdateInbox(journal);
  const [batch] = reloaded.pendingGroupBatches();
  assert.deepEqual(batch.updateIds, [30, 31]);
  assert.deepEqual(batch.preparedMessages.map((message) => message._durableUpdateId), [30, 31]);
  assert.equal(batch.threadId, 'locked-thread');
  assert.equal(batch.ackedReplyIndexes.has(0), true, 'reply 0 must not be sent twice');
  // Update 32 must not leap over the batch that is still being recovered,
  // otherwise recovery would regroup an old batch with newer input.
  assert.deepEqual(reloaded.pendingUpdates(), []);
  reloaded.markGroupBatchDone(batch.batchId);
  assert.deepEqual(reloaded.pendingUpdates().map((update) => update.update_id), [32]);
});

test('a dead group batch requeues atomically from any member update', () => {
  const dir = tempDir('group-dead');
  const inbox = new DurableUpdateInbox(path.join(dir, 'updates.jsonl'));
  inbox.recordReceived({ update_id: 40, message: { text: 'a' } });
  inbox.recordReceived({ update_id: 41, message: { text: 'b' } });
  inbox.markGroupBatch({
    batchId: 'group-batch-dead',
    chatId: '-100',
    updateIds: [40, 41],
    preparedMessages: [
      { chatId: '-100', messageId: 400, text: 'a', _durableUpdateId: 40 },
      { chatId: '-100', messageId: 401, text: 'b', _durableUpdateId: 41 },
    ],
  });
  const dead = inbox.markGroupBatchRetry('group-batch-dead', 'offline', {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });

  assert.equal(dead.dead, true);
  assert.deepEqual(inbox.deadUpdates().map((entry) => entry.updateId), [40, 41]);
  assert.equal(inbox.requeueDead(41), true, 'requeueing one member restores the whole batch');
  assert.deepEqual(inbox.pendingGroupBatches().map((batch) => batch.updateIds), [[40, 41]]);
});

test('a crash after generation reuses the persisted reply instead of asking the model again', async () => {
  const dir = tempDir('private-replay');
  const journal = path.join(dir, 'updates.jsonl');
  const inbox = new DurableUpdateInbox(journal);
  inbox.recordReceived({ update_id: 50, message: { text: 'hello' } });

  let modelCalls = 0;
  let sendCalls = 0;
  const generate = async () => {
    modelCalls += 1;
    return { reply: 'persisted model reply', threadId: 'locked-thread' };
  };

  await assert.rejects(
    deliverDurablePrivateReply({
      inbox,
      updateId: 50,
      chatId: 'owner',
      generate,
      send: async () => {
        sendCalls += 1;
        // Telegram accepted the text, but the response was lost before the
        // bridge could persist the send ack.
        throw new Error('response lost after accept');
      },
    }),
    /response lost/,
  );

  const beforeSend = new DurableUpdateInbox(journal).privateDelivery(50);
  assert.equal(beforeSend.reply, 'persisted model reply');
  assert.equal(beforeSend.threadId, 'locked-thread');
  assert.equal(beforeSend.sent, false);

  const replay = new DurableUpdateInbox(journal);
  await deliverDurablePrivateReply({
    inbox: replay,
    updateId: 50,
    chatId: 'owner',
    generate,
    send: async () => {
      sendCalls += 1;
      return { message_id: 500 };
    },
  });
  replay.compactIfNeeded(true);

  const afterAck = new DurableUpdateInbox(journal).privateDelivery(50);
  assert.equal(afterAck.sent, true);
  assert.equal(afterAck.sendResult.message_id, 500);

  await deliverDurablePrivateReply({
    inbox: new DurableUpdateInbox(journal),
    updateId: 50,
    chatId: 'owner',
    generate,
    send: async () => { sendCalls += 1; },
  });

  assert.equal(modelCalls, 1, 'the model must never run a second time for the same update');
  assert.equal(sendCalls, 2, 'a rare outbound duplicate is possible, a duplicate model turn is not');
});

test('/new replay recovers the recorded result instead of switching thread twice', () => {
  const dir = tempDir('new-operation');
  const journal = path.join(dir, 'updates.jsonl');
  const inbox = new DurableUpdateInbox(journal);
  inbox.recordReceived({ update_id: 60, message: { text: '/new' } });
  inbox.beginOperation(60, 'new-thread', { previousThreadId: 'old-thread' });
  inbox.completeOperation(60, { threadId: 'new-thread' });
  inbox.compactIfNeeded(true);

  const recovered = new DurableUpdateInbox(journal).operation(60);
  assert.equal(recovered.status, 'result');
  assert.equal(recovered.result.threadId, 'new-thread');
});

test('/restart_bridge replay consumes the completed handoff without a restart loop', () => {
  const dir = tempDir('restart-operation');
  const journal = path.join(dir, 'updates.jsonl');
  const inbox = new DurableUpdateInbox(journal);
  inbox.recordReceived({ update_id: 70, message: { text: '/restart_bridge' } });
  inbox.beginOperation(70, 'restart-bridge', { chatId: 'owner', force: false });
  inbox.markPrivateGenerated(70, {
    reply: '🔄 Restarting the bridge...',
    threadId: 'locked-thread',
    chatId: 'owner',
  });
  inbox.markPrivateSendAck(70, { message_id: 700 });
  inbox.completeOperation(70, { ackMessageId: 700, handoffWritten: true });
  inbox.compactIfNeeded(true);

  const replacementProcess = new DurableUpdateInbox(journal);
  assert.equal(replacementProcess.operation(70).status, 'result');
  assert.equal(replacementProcess.privateDelivery(70).sendResult.message_id, 700);
  replacementProcess.markDone(70);
  assert.deepEqual(replacementProcess.pendingUpdates(), []);
});

test('group completion resolves only after the send and the commit hook', async () => {
  const order = [];
  const batcher = new GroupConversationBatcher({
    timing: INSTANT_TIMING,
    generateReplies: async () => [{ text: 'ok', replyToMessageId: 1 }],
    sendReply: async (_chatId, _reply, _batch, _shouldSend, metadata) => {
      order.push(`send:${metadata.replyIndex}`);
      return true;
    },
    onBatchComplete: async () => { order.push('commit'); },
    log: () => {},
  });

  const queued = batcher.enqueue({ chatId: '-1', messageId: 1, senderId: 'u', senderIsBot: false, text: 'x' });
  await queued.completion;
  assert.deepEqual(order, ['send:0', 'commit']);
});

test('a send failure rejects the durable completion so the update is retried', async () => {
  const batcher = new GroupConversationBatcher({
    timing: INSTANT_TIMING,
    generateReplies: async () => [{ text: 'ok', replyToMessageId: 1 }],
    sendReply: async () => { throw new Error('offline send failure'); },
    log: () => {},
  });

  const queued = batcher.enqueue({ chatId: '-1', messageId: 1, senderId: 'u', senderIsBot: false, text: 'x' });
  await assert.rejects(queued.completion, /offline send failure/);
});
