import assert from 'node:assert/strict';
import test from 'node:test';

import { createAlbumBatcher, DEFAULT_ALBUM_WINDOW_MS } from '../src/telegram-album-batcher.mjs';

function upd(id, { album = null, chat = 1, thread = undefined, text = '' } = {}) {
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id: chat },
      ...(thread === undefined ? {} : { message_thread_id: thread }),
      ...(album === null ? {} : { media_group_id: album }),
      ...(text ? { text } : {}),
      photo: album === null ? undefined : [{ file_id: `f${id}` }],
    },
  };
}

function harness({ windowMs = DEFAULT_ALBUM_WINDOW_MS } = {}) {
  let now = 1000;
  return {
    batcher: createAlbumBatcher({ windowMs, now: () => now }),
    advance: (ms) => { now += ms; },
  };
}

test('a plain message is never delayed', () => {
  const { batcher } = harness();
  assert.equal(batcher.plan(upd(1, { text: 'hi' }), []).action, 'single');
});

test('the first album item waits instead of being fed alone', () => {
  const { batcher } = harness();
  const a = upd(1, { album: 'A' });
  const r = batcher.plan(a, [a]);
  assert.equal(r.action, 'wait');
  assert.ok(r.waitMs > 0 && r.waitMs <= DEFAULT_ALBUM_WINDOW_MS);
});

test('items arriving inside the window keep waiting', () => {
  const { batcher, advance } = harness();
  const a = upd(1, { album: 'A' });
  batcher.plan(a, [a]);
  advance(300);
  assert.equal(batcher.plan(a, [a, upd(2, { album: 'A' })]).action, 'wait');
});

test('after the window the album merges in update_id order', () => {
  const { batcher, advance } = harness();
  const a = upd(7, { album: 'A' });
  const b = upd(5, { album: 'A' });
  const c = upd(6, { album: 'A' });
  batcher.plan(a, [a]);
  advance(DEFAULT_ALBUM_WINDOW_MS + 1);
  const r = batcher.plan(a, [a, b, c]);
  assert.equal(r.action, 'merge');
  assert.deepEqual(r.updates.map((u) => u.update_id), [5, 6, 7]);
});

test('the same media_group_id in another chat is never merged in', () => {
  const { batcher, advance } = harness();
  const mine = upd(1, { album: 'A', chat: 111 });
  const other = upd(2, { album: 'A', chat: 222 });
  batcher.plan(mine, [mine]);
  advance(DEFAULT_ALBUM_WINDOW_MS + 1);
  assert.deepEqual(batcher.plan(mine, [mine, other]).updates.map((u) => u.update_id), [1]);
});

test('a different forum topic is never merged in', () => {
  const { batcher, advance } = harness();
  const t1 = upd(1, { album: 'A', chat: 9, thread: 100 });
  const t2 = upd(2, { album: 'A', chat: 9, thread: 200 });
  batcher.plan(t1, [t1]);
  advance(DEFAULT_ALBUM_WINDOW_MS + 1);
  assert.deepEqual(batcher.plan(t1, [t1, t2]).updates.map((u) => u.update_id), [1]);
});

test('the update is not lost when the pending list omits it', () => {
  const { batcher, advance } = harness();
  const a = upd(1, { album: 'A' });
  batcher.plan(a, [a]);
  advance(DEFAULT_ALBUM_WINDOW_MS + 1);
  const r = batcher.plan(a, []);
  assert.equal(r.action, 'merge');
  assert.deepEqual(r.updates.map((u) => u.update_id), [1]);
});

test('forget releases the tracked album', () => {
  const { batcher } = harness();
  const a = upd(1, { album: 'A' });
  batcher.plan(a, [a]);
  assert.equal(batcher.size(), 1);
  batcher.forget('A');
  assert.equal(batcher.size(), 0);
});
