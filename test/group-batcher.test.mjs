import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GroupConversationBatcher,
  parseBatchReplies,
} from '../src/group-batcher.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('parseBatchReplies accepts strict JSON replies', () => {
  assert.deepEqual(
    parseBatchReplies('{"replies":[{"text":"combined","replyToMessageId":12}]}', [12]),
    [{ text: 'combined', replyToMessageId: 12 }],
  );
});

test('per-chat timing override can hold a first message for a larger batch', async () => {
  const batches = [];
  const batcher = new GroupConversationBatcher({
    timing: {
      singleMessageMs: 5,
      sameSenderIdleMs: 5,
      sameSenderMaxMs: 10,
      multiSenderIdleMs: 5,
      multiSenderMaxMs: 10,
    },
    getTiming: (chatId) => chatId === '-slow'
      ? {
          singleMessageMs: 30,
          sameSenderIdleMs: 5,
          sameSenderMaxMs: 50,
          multiSenderIdleMs: 5,
          multiSenderMaxMs: 50,
        }
      : null,
    log: () => {},
    generateReplies: async (batch) => {
      batches.push(batch.map((message) => message.text));
      return [{ text: 'combined', replyToMessageId: null }];
    },
    sendReply: async () => true,
  });

  batcher.enqueue({
    chatId: '-slow',
    messageId: 1,
    senderId: 'human',
    senderIsBot: false,
    text: 'A',
  });

  await sleep(12);
  assert.deepEqual(batches, []);

  batcher.enqueue({
    chatId: '-slow',
    messageId: 2,
    senderId: 'human',
    senderIsBot: false,
    text: 'B',
  });

  await sleep(80);
  assert.deepEqual(batches, [['A', 'B']]);
});
