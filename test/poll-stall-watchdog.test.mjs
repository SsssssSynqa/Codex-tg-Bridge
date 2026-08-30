import assert from 'node:assert/strict';
import test from 'node:test';

import { createPollStallWatchdog, DEFAULT_STALL_MS } from '../src/poll-stall-watchdog.mjs';

function harness({ stallMs = DEFAULT_STALL_MS, checkMs = 15_000 } = {}) {
  let now = 1000;
  const ticks = [];
  const stalls = [];
  const watchdog = createPollStallWatchdog({
    stallMs,
    checkMs,
    now: () => now,
    onStall: (stuckMs) => stalls.push(stuckMs),
    setIntervalFn: (fn) => { ticks.push(fn); return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  return { watchdog, stalls, advance: (ms) => { now += ms; }, tick: () => ticks.forEach((fn) => fn()) };
}

test('a hung getUpdates is detected', () => {
  const { watchdog, stalls, advance, tick } = harness();
  watchdog.start();
  watchdog.beginPoll();
  advance(DEFAULT_STALL_MS + 1);
  tick();
  assert.equal(stalls.length, 1);
});

test('a long reply generation is never mistaken for a stall', () => {
  const { watchdog, stalls, advance, tick } = harness();
  watchdog.start();
  watchdog.beginPoll();
  watchdog.endPoll();          // getUpdates returned; the model is now working
  advance(DEFAULT_STALL_MS * 10);
  tick();
  assert.equal(stalls.length, 0, '在用户等回复的时候绝不能误杀');
});

test('a healthy poll cycle never fires', () => {
  const { watchdog, stalls, advance, tick } = harness();
  watchdog.start();
  for (let i = 0; i < 5; i += 1) {
    watchdog.beginPoll();
    advance(30_000);
    watchdog.endPoll();
    tick();
  }
  assert.equal(stalls.length, 0);
});

test('one hang is reported once, not every tick', () => {
  const { watchdog, stalls, advance, tick } = harness();
  watchdog.start();
  watchdog.beginPoll();
  advance(DEFAULT_STALL_MS + 1);
  tick(); tick(); tick();
  assert.equal(stalls.length, 1);
});
