import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableTransportError, withTransportRetry } from '../src/telegram-transport-retry.mjs';

test('transport faults are retryable, real Telegram answers are not', () => {
  assert.equal(isRetryableTransportError(new Error('fetch failed')), true);
  assert.equal(isRetryableTransportError(new Error('The operation was aborted due to timeout')), true);
  assert.equal(isRetryableTransportError(new Error('socket hang up')), true);

  const badRequest = new Error('chat not found');
  badRequest.status = 400;
  assert.equal(isRetryableTransportError(badRequest), false, '真实回答不许被重试盖住');

  const rateLimited = new Error('Too Many Requests');
  rateLimited.status = 429;
  assert.equal(isRetryableTransportError(rateLimited), false, '429 归上游限流器管');

  const serverError = new Error('Bad Gateway');
  serverError.status = 502;
  assert.equal(isRetryableTransportError(serverError), true);
});

test('a burst of transport faults still delivers', async () => {
  let attempts = 0;
  const result = await withTransportRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('fetch failed');
    return 'delivered';
  }, { sleep: async () => {} });
  assert.equal(result, 'delivered');
  assert.equal(attempts, 3);
});

test('a real Telegram error surfaces immediately without retrying', async () => {
  let attempts = 0;
  const boom = new Error('chat not found');
  boom.status = 400;
  await assert.rejects(withTransportRetry(async () => {
    attempts += 1;
    throw boom;
  }, { sleep: async () => {} }));
  assert.equal(attempts, 1);
});

test('retries are bounded and the last error is surfaced', async () => {
  let attempts = 0;
  await assert.rejects(withTransportRetry(async () => {
    attempts += 1;
    throw new Error('fetch failed');
  }, { maxAttempts: 4, sleep: async () => {} }), /fetch failed/);
  assert.equal(attempts, 4);
});
