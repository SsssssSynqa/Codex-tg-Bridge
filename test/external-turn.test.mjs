// Approval routing for turns the bridge did not start.
//
// In daemon mode a `codex --remote` terminal session shares the thread with
// the bridge, so the bridge receives approval requests belonging to whoever is
// sitting at that terminal. Declining those on their behalf silently breaks
// their session; approving them would lend the bridge's authority to a client
// it cannot vouch for. Both are wrong: they get forwarded to the owner.
//
// These tests drive the real respondToServerRequest without opening a socket.

import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDaemonClient } from '../src/codex-daemon-client.mjs';

const WORKDIR = '/srv/workspace/project';
const ROOTS = ['/srv/workspace'];

function makeClient() {
  const client = Object.create(CodexDaemonClient.prototype);
  client.workdir = WORKDIR;
  client.toolWritableRoots = ROOTS;
  client.turnModes = new Map();
  client.activeTurnMode = null;
  client.events = [];
  client.responses = [];
  client.forwards = [];
  client.logSecurityEvent = (kind, params, decision) => client.events.push({ kind, decision });
  client.sendResponse = (id, result) => client.responses.push(result);
  client.requestUserApproval = (info) => {
    client.forwards.push(info);
    return Promise.resolve('decline');
  };
  return client;
}

const commandRequest = (turnId, command, extra = {}) => ({
  id: 1,
  method: 'item/commandExecution/requestApproval',
  params: { turnId, command, cwd: WORKDIR, ...extra },
});

test('an external turn is forwarded, not silently declined', async () => {
  const client = makeClient();
  client.respondToServerRequest(commandRequest('tui-turn-1', "/bin/zsh -lc 'open /home/user/.codex'"));

  assert.equal(client.forwards.length, 1);
  assert.equal(client.forwards[0].reason, 'external-client-turn');
  assert.equal(client.responses.length, 0, 'must not answer synchronously');
  assert.match(client.forwards[0].summary.command, /open/);
  assert.equal(typeof client.forwards[0].summary.cwd, 'string');

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(client.responses, [{ decision: 'decline' }], 'owner declined, so decline goes back');
});

test('an external turn running a dangerous command is still refused outright', () => {
  const client = makeClient();
  client.respondToServerRequest(commandRequest('tui-turn-2', 'rm -rf /home/user'));

  assert.equal(client.responses[0]?.decision, 'decline');
  assert.ok(client.events.some((event) => event.decision === 'declined-dangerous-command'));
  assert.equal(client.forwards.length, 0, 'dangerous commands never reach the owner card');
});

test('a group turn stays hard read-only and is never forwarded', () => {
  const client = makeClient();
  client.turnModes.set('group-turn-1', 'read-only');
  client.respondToServerRequest(commandRequest('group-turn-1', "/bin/zsh -lc 'open /home/user/.codex'"));

  assert.equal(client.responses[0]?.decision, 'decline');
  assert.ok(client.events.some((event) => event.decision === 'declined-read-only-mode'));
  assert.equal(client.forwards.length, 0);
});

test('a private-tools write inside the roots still needs an explicit tap', () => {
  const client = makeClient();
  client.turnModes.set('pm-turn-1', 'private-tools');
  client.respondToServerRequest(commandRequest('pm-turn-1', `echo hi > ${WORKDIR}/x.txt`));

  assert.equal(client.responses.length, 0);
  assert.equal(client.forwards[0]?.reason, 'manual-confirmation-required');
});

test('a malformed file-change payload is declined instead of shown as a blank card', () => {
  const client = makeClient();
  client.respondToServerRequest({
    id: 1,
    method: 'item/fileChange/requestApproval',
    params: { turnId: 'tui-turn-3', fileChanges: {} },
  });

  assert.equal(client.responses[0]?.decision, 'decline');
  assert.ok(client.events.some((event) => event.decision === 'declined-malformed-empty-paths'));
  assert.equal(client.forwards.length, 0);
});

test('an external write outside the roots names the target on the card', () => {
  const client = makeClient();
  client.respondToServerRequest(commandRequest('tui-turn-4', 'echo x > /srv/elsewhere/a.txt'));

  assert.equal(client.forwards[0]?.reason, 'external-client-turn');
  assert.ok(
    (client.forwards[0]?.summary?.targetsOutsideRoots || []).some((target) => target.includes('/srv/elsewhere/a.txt')),
  );
});

test('a request with no turnId is forwarded rather than answered', () => {
  const client = makeClient();
  client.respondToServerRequest(commandRequest(undefined, "/bin/zsh -lc 'open /home/user/.codex'"));

  assert.equal(client.forwards.length, 1);
  assert.equal(client.forwards[0].reason, 'external-client-turn');
  assert.equal(client.responses.length, 0);
});

test('a request with no turnId cannot inherit an in-flight private-tools turn', () => {
  const client = makeClient();
  client.activeTurnMode = { turnId: 'private-in-flight', mode: 'private-tools' };
  client.respondToServerRequest(commandRequest(undefined, 'cat README.md'));

  assert.equal(client.forwards.length, 1);
  assert.equal(client.forwards[0].reason, 'external-client-turn');
  assert.equal(client.responses.length, 0, 'even an allowlisted read must not ride someone else`s authority');
});

test('a private-tools file change inside the roots is forwarded too', () => {
  const client = makeClient();
  client.turnModes.set('pm-file-turn', 'private-tools');
  client.respondToServerRequest({
    id: 1,
    method: 'item/fileChange/requestApproval',
    params: {
      turnId: 'pm-file-turn',
      fileChanges: { [`${WORKDIR}/x.txt`]: { type: 'add' } },
    },
  });

  assert.equal(client.responses.length, 0);
  assert.equal(client.forwards[0]?.reason, 'manual-confirmation-required');
});

test('modeForRequest only trusts a turn this client started', () => {
  const client = Object.create(CodexDaemonClient.prototype);
  client.turnModes = new Map([['owned', 'private-tools']]);

  assert.equal(client.modeForRequest({ turnId: 'owned' }), 'private-tools');
  assert.equal(client.modeForRequest({ turnId: 'foreign' }), 'external-turn');
  assert.equal(client.modeForRequest({}), 'external-turn');
});

test('streaming deltas from other clients are bounded', () => {
  // Every attached client receives every turn's deltas, including a terminal
  // session that streams for hours. Both the per-turn text and the number of
  // tracked turns are capped so that traffic cannot grow this map forever.
  const client = Object.create(CodexDaemonClient.prototype);
  client.turnChunks = new Map();
  client.turnModes = new Map();
  client.turnWaiters = new Map();
  client._turnChunkCharsLimit = 8;
  client._turnChunkEntriesLimit = 2;

  client.appendTurnDelta('a', '123456789');
  client.appendTurnDelta('b', 'b');
  client.appendTurnDelta('c', 'c');

  assert.equal(client.turnChunks.get('a')?.length ?? 0, 0, 'the oldest unowned turn is evicted');
  assert.equal(client.turnChunks.get('b'), 'b');
  assert.equal(client.turnChunks.get('c'), 'c');
});

test('a failed resume never creates a replacement thread', async () => {
  const client = Object.create(CodexDaemonClient.prototype);
  client.threadId = 'locked-thread';
  client.ready = false;
  client.resumeBlocked = null;
  client.handshakeError = null;
  client.call = async () => ({});
  client.notify = () => {};
  client.resumeExistingThread = async () => { throw new Error('missing rollout'); };
  client.startThread = async () => { throw new Error('startThread must not run'); };
  client.log = () => {};
  client.logSecurityEvent = () => {};
  let blocked = null;
  client.onThreadChange = (info) => { blocked = info; };

  await client.handshake();

  assert.equal(client.threadId, 'locked-thread', 'the locked thread id is untouched');
  assert.equal(client.ready, false, 'the client stays not-ready instead of serving a fresh thread');
  assert.equal(blocked?.blocked, true, 'the bridge is told to ask the owner');
});
