// Codex daemon client — WebSocket-over-unix-socket
//
// Drop-in alternative to CodexAppClient (spawn mode). Selected via
// config.codexMode === 'daemon'. Instead of spawning its own
// `codex app-server --stdio` child, this client connects to a long-running
// daemon at `codex app-server --listen unix://PATH` and shares the daemon's
// in-memory thread state with any other clients that resume the same thread.
// That makes a Telegram bot and a `codex --remote unix://PATH` TUI feel like
// they are talking to the same Codex instance instead of two split processes.
//
// Design rationale (collected from peer-review iterations R1-R6 during the v2
// development cycle, retained here so future maintainers can see the trade-offs):
//
// Protocol-level
//   - Plain JSON-RPC 2.0 over WebSocket. The "jsonrpc": "2.0" field is included
//     for compatibility with the stdio path; the daemon accepts both.
//   - capabilities is initialized as null. optOutNotificationMethods, etc.
//     should be added one at a time only after smoke testing confirms the
//     daemon accepts the exact shape.
//   - thread/start at handshake time uses approvalPolicy: "never" and a
//     read-only sandbox. Per-turn overrides happen at turn/start time via
//     buildTurnOverrides(mode); private-tools mode switches to on-request +
//     workspaceWrite + the bridge's own approval handler.
//
// Lifecycle / resilience
//   - The constructor sets this.handshakePromise = this.connectWithRetry().
//     ask() awaits waitReady() so that messages arriving while the daemon is
//     restarting wait for recovery instead of failing fast.
//   - A `connecting` promise lock prevents concurrent reconnect loops.
//   - The socket close handler immediately points handshakePromise at a fresh
//     "wait 2s then reconnect" promise, so the 2-second backoff window does
//     not leak through as a stale already-resolved promise.
//   - Exponential backoff up to 30s.
//
// Correctness
//   - completedTurns caches turn/completed notifications that arrive before
//     the corresponding ask() registers a waiter. Bounded by a FIFO limit so
//     broadcast-driven completions from other clients do not accumulate.
//   - modeForRequest distinguishes two cases:
//       1. params.turnId is known to this client -> use that turn's mode.
//       2. params.turnId is unknown, or absent entirely -> 'external-turn'.
//          The request belongs to another client (typically a `codex --remote`
//          TUI on the same thread), or ownership cannot be proven. Either way
//          this client neither lends its private-tools authority nor answers
//          on the other client's behalf.
//   - thread/resume failure is fail-closed: the client stays connected but not
//     ready, and never silently starts a replacement thread. A new thread would
//     read as amnesia to whoever is chatting. onThreadChange fires with
//     blocked: true so the bridge can tell the owner to run /resume or /new.
//
// Security
//   - The default daemon socket lives at $CODEX_HOME/app-server-control/
//     app-server-control.sock with mode 0600. Only the user that started the
//     daemon can connect.
//   - Approvals are sorted into auto-approve (side-effect-free inspection
//     commands inside the writable roots), auto-decline (dangerous commands,
//     read-only turns, malformed payloads) and forward-to-owner (everything
//     else, including every file write and every external-turn request).
//     Without a requestUserApproval callback the forward bucket is declined,
//     so an unconfigured bridge fails closed rather than open.

import net from 'node:net';
import crypto from 'node:crypto';
import {
  extractWriteTargets,
  isDangerousCommand,
  isPathWithinRoots,
  isSafeInspectionCommand,
  normalizeAllowedRoots,
} from './command-policy.mjs';

// Re-exported so the smoke tests can exercise the exact predicates this client
// uses without importing bridge.mjs (which would start the Telegram poll loop).
export { extractWriteTargets, isDangerousCommand, isSafeInspectionCommand };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const READ_ONLY_SANDBOX = { type: 'readOnly', networkAccess: false };

function makeAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.length - i < 2) break;
    const b0 = buf[i], b1 = buf[i + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = i + 2;
    if (len === 126) {
      if (buf.length - cursor < 2) break;
      len = buf.readUInt16BE(cursor); cursor += 2;
    } else if (len === 127) {
      if (buf.length - cursor < 8) break;
      len = Number(buf.readBigUInt64BE(cursor)); cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length - cursor < 4) break;
      maskKey = buf.subarray(cursor, cursor + 4); cursor += 4;
    }
    if (buf.length - cursor < len) break;
    let payload = buf.subarray(cursor, cursor + len);
    if (masked) {
      const u = Buffer.alloc(len);
      for (let j = 0; j < len; j++) u[j] = payload[j] ^ maskKey[j % 4];
      payload = u;
    }
    frames.push({ opcode, text: opcode === 0x1 ? payload.toString('utf8') : null });
    i = cursor + len;
  }
  return { frames, rest: buf.subarray(i) };
}

export class CodexDaemonClient {
  constructor({
    socketPath,
    workdir,
    threadId = null,
    model = 'gpt-5.5',
    effort = 'medium',
    serviceTier = 'fast',
    timeoutMs = 600000,
    toolWritableRoots = null,
    toolNetworkAccess = false,
    onReady,
    onThreadChange,
    onSecurityEvent,
    // Called for approvals that are neither clearly safe nor clearly dangerous.
    // The bridge forwards them to the owner (Telegram inline keyboard) and
    // resolves with 'accept' or 'decline'. When it is not supplied, those
    // requests are declined instead of being silently approved.
    requestUserApproval = null,
    // Called when the daemon socket drops, so the bridge can invalidate any
    // approval cards still waiting for a tap.
    onDisconnect = null,
    log = console.log,
  }) {
    this.socketPath = socketPath;
    this.workdir = workdir;
    this.threadId = threadId;
    this.model = model;
    this.effort = effort;
    this.serviceTier = serviceTier;
    this.timeoutMs = timeoutMs;
    this.toolWritableRoots = normalizeAllowedRoots(toolWritableRoots, workdir);
    this.toolNetworkAccess = toolNetworkAccess === true;
    this.onReady = onReady;
    this.onThreadChange = onThreadChange;
    this.onSecurityEvent = onSecurityEvent;
    this.requestUserApproval = requestUserApproval;
    this.onDisconnect = onDisconnect;
    this.log = log;

    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.upgraded = false;
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this._completedTurnsLimit = 64;
    this.turnChunks = new Map();
    // Streaming deltas are broadcast to every attached client, including turns
    // started by a TUI. Bound both the per-turn text and the number of tracked
    // turns so a long terminal session cannot grow this map without limit.
    this._turnChunkCharsLimit = 1_000_000;
    this._turnChunkEntriesLimit = 128;
    this.turnModes = new Map();
    this.activeTurnMode = null;
    this.ready = false;
    this.closing = false;
    this.handshakeError = null;
    // Set when the locked thread could not be resumed. The client stays
    // connected but refuses to serve turns until the owner runs /resume or /new.
    this.resumeBlocked = null;
    this.connecting = null;

    // Wait-capable handshake promise so ask() can block on recovery.
    this.handshakePromise = this.connectWithRetry();
  }

  // connectWithRetry is the single entry to (re)establish the daemon
  // connection. A `connecting` promise lock makes it idempotent.
  connectWithRetry() {
    if (this.connecting) return this.connecting;
    this.connecting = this._doConnectWithRetry().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _doConnectWithRetry() {
    let backoffMs = 1000;
    while (!this.closing) {
      try {
        await this.connect();
        await this.handshake();
        return;
      } catch (error) {
        this.log(`Codex daemon connect failed: ${error.message}; retry in ${backoffMs / 1000}s`);
        this.ready = false;
        this.handshakeError = error;
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.socketPath);
      this.buf = Buffer.alloc(0);
      this.upgraded = false;
      const key = crypto.randomBytes(16).toString('base64');
      const expectedAccept = makeAccept(key);
      // A daemon that accepts the TCP/unix connection but never answers the
      // upgrade would otherwise hang this promise forever and stall every turn.
      const handshakeTimer = setTimeout(() => {
        if (this.upgraded) return;
        try { this.socket?.destroy(); } catch {}
        reject(new Error('Codex daemon WebSocket handshake timeout'));
      }, 10000);
      const rejectHandshake = (error) => {
        clearTimeout(handshakeTimer);
        reject(error);
      };

      this.socket.once('connect', () => {
        const handshake = [
          'GET / HTTP/1.1',
          'Host: localhost',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '', '',
        ].join('\r\n');
        this.socket.write(handshake);
      });

      this.socket.on('error', (err) => {
        if (!this.upgraded) rejectHandshake(err);
        else this.failAll(err);
      });

      this.socket.on('close', () => {
        const wasUpgraded = this.upgraded;
        this.ready = false;
        this.upgraded = false;
        if (!wasUpgraded) rejectHandshake(new Error('Codex daemon socket closed during handshake'));
        this.failAll(new Error('Codex daemon socket closed'));
        if (wasUpgraded && !this.closing) {
          this.log('Codex daemon disconnected; reconnecting in 2s');
          // Point handshakePromise at the new "wait 2s then reconnect" promise
          // immediately so waitReady() blocks on the right thing during the
          // 2-second window.
          this.handshakePromise = new Promise((r) => setTimeout(r, 2000))
            .then(() => this.connectWithRetry());
        }
      });

      this.socket.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);

        if (!this.upgraded) {
          const headEnd = this.buf.indexOf('\r\n\r\n');
          if (headEnd < 0) return;
          const head = this.buf.subarray(0, headEnd).toString('utf8');
          this.buf = this.buf.subarray(headEnd + 4);
          if (!head.includes('101 Switching Protocols')) {
            try { this.socket?.destroy(); } catch {}
            return rejectHandshake(new Error(`WS handshake failed: ${head.slice(0, 200)}`));
          }
          if (!head.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
            try { this.socket?.destroy(); } catch {}
            return rejectHandshake(new Error('WS handshake accept key mismatch'));
          }
          clearTimeout(handshakeTimer);
          this.upgraded = true;
          resolve();
        }

        if (this.upgraded) {
          const { frames, rest } = decodeFrames(this.buf);
          this.buf = rest;
          for (const f of frames) {
            if (f.opcode === 0x8) { this.socket.end(); continue; }
            if (f.opcode !== 0x1 || !f.text) continue;
            try { this.handleMessage(JSON.parse(f.text)); } catch {}
          }
        }
      });
    });
  }

  handleMessage(message) {
    // Server response to one of our outbound RPC requests.
    if (message.id != null && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const handler = this.pending.get(message.id);
      if (!handler) return;
      this.pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
      return;
    }

    // Server-originated request (has id AND method). The bridge must reply
    // so the daemon does not hang waiting for an approval decision.
    if (message.id != null && message.method) {
      this.respondToServerRequest(message);
      return;
    }

    // Notification (server push).
    if (message.method === 'item/agentMessage/delta') {
      const { turnId, delta } = message.params || {};
      this.appendTurnDelta(turnId, delta);
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = message.params?.turn;
      if (!turn) return;
      const result = {
        turn,
        reply: (this.turnChunks.get(turn.id) || '').trim(),
      };
      this.turnChunks.delete(turn.id);
      this.turnModes.delete(turn.id);
      if (this.activeTurnMode?.turnId === turn.id) this.activeTurnMode = null;
      const waiter = this.turnWaiters.get(turn.id);
      if (waiter) {
        this.turnWaiters.delete(turn.id);
        waiter.resolve(result);
      } else {
        // Cache a turn/completed that arrived before ask() set up a waiter.
        // FIFO-bounded to keep multi-client broadcasts from accumulating.
        this.completedTurns.set(turn.id, result);
        while (this.completedTurns.size > this._completedTurnsLimit) {
          const oldest = this.completedTurns.keys().next().value;
          this.completedTurns.delete(oldest);
        }
      }
      return;
    }

    // Other notifications (thread/* / mcpServer/* / etc.) are ignored here.
    // The bridge can opt out of noisy ones via capabilities.optOutNotificationMethods.
  }

  appendTurnDelta(turnId, delta) {
    if (!turnId) return;
    if (!this.turnChunks.has(turnId) && this.turnChunks.size >= this._turnChunkEntriesLimit) {
      const evictable = [...this.turnChunks.keys()].find(
        (candidate) => !this.turnModes.has(candidate) && !this.turnWaiters.has(candidate),
      );
      if (evictable) this.turnChunks.delete(evictable);
      if (this.turnChunks.size >= this._turnChunkEntriesLimit) return;
    }
    const current = this.turnChunks.get(turnId) || '';
    if (current.length >= this._turnChunkCharsLimit) return;
    this.turnChunks.set(turnId, `${current}${String(delta || '')}`.slice(0, this._turnChunkCharsLimit));
  }

  // Approval requests are sorted into three buckets:
  //   1. Clearly safe   -> auto-approve. Only side-effect-free inspection
  //      commands inside the writable roots qualify.
  //   2. Clearly unsafe -> auto-decline (dangerous command, read-only turn,
  //      malformed file-change payload).
  //   3. Everything else -> forward to the owner and wait for a decision.
  // Any other server-originated method keeps the synchronous fallback path.
  respondToServerRequest(message) {
    const method = message.method;
    const params = message.params || {};
    const isCmdApproval = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
    const isFileApproval = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';

    if (!isCmdApproval && !isFileApproval) {
      try {
        const result = this.handleServerRequest(method, params);
        this.sendResponse(message.id, result);
      } catch (error) {
        this.sendResponse(message.id, null, { code: -32601, message: error.message || 'rejected' });
      }
      return;
    }

    const mode = this.modeForRequest(params);
    const canWrite = mode === 'private-tools';
    // Two protocol generations: new methods use accept/decline, the legacy
    // ones use approved/denied.
    const isNewProto = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
    const acceptValue = isNewProto ? 'accept' : 'approved';
    const declineValue = isNewProto ? 'decline' : 'denied';

    let verdict = this.classifyApproval(method, params, canWrite, isCmdApproval);
    // An external turn is one this client did not start — typically a
    // `codex --remote` TUI attached to the same thread. The bridge is not the
    // decision maker there: declining on the human's behalf silently breaks
    // their own terminal session. Dangerous or malformed requests are still
    // refused; anything else is forwarded so the owner decides, and it is
    // never auto-approved even when every target sits inside the writable
    // roots. Group turns do not reach this branch: their turnId is known and
    // stays hard read-only.
    if (mode === 'external-turn' && verdict.kind === 'auto-decline' && verdict.reason === 'read-only-mode') {
      const recheck = this.classifyApproval(method, params, true, isCmdApproval);
      if (recheck.kind === 'auto-decline') {
        verdict = recheck;
      } else {
        const lp = recheck.logParams || {};
        verdict = {
          kind: 'forward',
          reason: 'external-client-turn',
          logParams: lp,
          summary: recheck.summary || (isCmdApproval
            ? {
              command: lp.command,
              cwd: lp.cwd,
              networkRequested: lp.networkRequested,
              targetsOutsideRoots: lp.targetsOutsideRoots || [],
            }
            : { grantRoot: lp.grantRoot, filePaths: lp.filePaths }),
        };
      }
    }
    const securityKind = isCmdApproval ? 'command-approval' : 'file-change-approval';

    if (verdict.kind === 'auto-approve') {
      this.logSecurityEvent(securityKind, verdict.logParams, 'approved');
      this.sendResponse(message.id, { decision: acceptValue });
      return;
    }
    if (verdict.kind === 'auto-decline') {
      this.logSecurityEvent(securityKind, verdict.logParams, `declined-${verdict.reason}`);
      this.sendResponse(message.id, { decision: declineValue });
      return;
    }

    // verdict.kind === 'forward'
    if (!this.requestUserApproval) {
      this.logSecurityEvent(securityKind, verdict.logParams, 'declined-no-callback');
      this.sendResponse(message.id, { decision: declineValue });
      return;
    }

    this.logSecurityEvent(securityKind, verdict.logParams, 'forward-to-owner');
    Promise.resolve(this.requestUserApproval({
      method,
      params,
      isNewProto,
      reason: verdict.reason,
      summary: verdict.summary,
    })).then((userSemantic) => {
      // userSemantic is 'accept' or 'decline'. acceptForSession stays in the
      // wire map so a future UI can offer it without touching this client, but
      // no button currently returns it.
      const wireMap = isNewProto
        ? { accept: 'accept', acceptForSession: 'acceptForSession', decline: 'decline' }
        : { accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied' };
      const decision = wireMap[userSemantic] || declineValue;
      this.logSecurityEvent(securityKind, { ...verdict.logParams, userSemantic }, `user-${userSemantic}`);
      this.sendResponse(message.id, { decision });
    }).catch((error) => {
      this.logSecurityEvent(securityKind, { ...verdict.logParams, error: error.message }, 'forward-error-declined');
      this.sendResponse(message.id, { decision: declineValue });
    });
  }

  classifyApproval(method, params, canWrite, isCmdApproval) {
    if (isCmdApproval) {
      const command = params.command
        || (Array.isArray(params.commandActions) ? params.commandActions.map((a) => a.cmd).join(' && ') : '')
        || '';
      const cwd = params.cwd || this.workdir;
      const networkRequested = Boolean(params.networkApprovalContext)
        || (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0);
      const logParams = { command, cwd, networkRequested };

      if (isDangerousCommand(command)) {
        return { kind: 'auto-decline', reason: 'dangerous-command', logParams };
      }
      if (!canWrite) {
        return { kind: 'auto-decline', reason: 'read-only-mode', logParams };
      }
      // A safe cwd is not enough: the command string itself can redirect or
      // copy outside the roots (`> file`, cp/mv/tee/dd of=, curl -o, ...).
      const writeTargets = extractWriteTargets(command);
      const targetsOutsideRoots = writeTargets.filter((t) => !isPathWithinRoots(t, this.toolWritableRoots, cwd));
      const cwdInsideRoots = isPathWithinRoots(cwd, this.toolWritableRoots, this.workdir);
      if (
        !networkRequested
        && targetsOutsideRoots.length === 0
        && cwdInsideRoots
        && isSafeInspectionCommand(command)
      ) {
        return { kind: 'auto-approve', logParams: { ...logParams, writeTargets } };
      }
      return {
        kind: 'forward',
        reason: networkRequested
          ? 'network-requested'
          : (targetsOutsideRoots.length
            ? 'command-writes-outside-roots'
            : (cwdInsideRoots ? 'manual-confirmation-required' : 'cwd-outside-roots')),
        logParams: { ...logParams, writeTargets, targetsOutsideRoots },
        summary: { command, cwd, networkRequested, targetsOutsideRoots },
      };
    }

    // File-change approval.
    const grantRoot = params.grantRoot || null;
    const filePaths = params.fileChanges ? Object.keys(params.fileChanges) : [];
    const logParams = { grantRoot, filePaths };

    if (!canWrite) {
      return { kind: 'auto-decline', reason: 'read-only-mode', logParams };
    }
    const allPaths = [grantRoot, ...filePaths].filter(Boolean);
    // A malformed payload with no paths at all gives the owner nothing to
    // judge, so it is declined rather than forwarded as a blank card.
    if (allPaths.length === 0) {
      return { kind: 'auto-decline', reason: 'malformed-empty-paths', logParams };
    }
    const allInRoots = allPaths.every((p) => isPathWithinRoots(p, this.toolWritableRoots, this.workdir));
    // File writes are never silent, not even inside the writable roots.
    return {
      kind: 'forward',
      reason: allInRoots ? 'manual-confirmation-required' : 'paths-outside-roots',
      logParams,
      summary: { grantRoot, filePaths },
    };
  }

  sendResponse(id, result, error) {
    const env = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    if (this.socket?.writable) this.socket.write(encodeFrame(JSON.stringify(env)));
  }

  handleServerRequest(method, params) {
    const mode = this.modeForRequest(params);
    const canWrite = mode === 'private-tools';

    if (method === 'item/commandExecution/requestApproval') {
      return { decision: this.shouldApproveCommand(params, canWrite) ? 'accept' : 'decline' };
    }
    if (method === 'execCommandApproval') {
      return { decision: this.shouldApproveCommand(params, canWrite) ? 'approved' : 'denied' };
    }
    if (method === 'item/fileChange/requestApproval') {
      return { decision: this.shouldApproveFileChange(params, canWrite) ? 'accept' : 'decline' };
    }
    if (method === 'applyPatchApproval') {
      return { decision: this.shouldApproveFileChange(params, canWrite) ? 'approved' : 'denied' };
    }
    if (method === 'item/permissions/requestApproval') {
      this.logSecurityEvent('permissions-request', params, 'restricted');
      return { permissions: {}, scope: 'turn', strictAutoReview: true };
    }
    if (method === 'item/tool/requestUserInput') {
      this.logSecurityEvent('user-input-request', params, 'empty-answer');
      return { answers: {} };
    }
    if (method === 'item/tool/call') {
      this.logSecurityEvent('dynamic-tool-request', params, 'rejected');
      return {
        contentItems: [{ type: 'inputText', text: 'Telegram bridge does not expose dynamic tools.' }],
        success: false,
      };
    }

    this.logSecurityEvent('unknown-server-request', { method, params }, 'rejected');
    throw new Error(`Telegram bridge does not expose ${method}`);
  }

  // Mode lookup for a server-originated request.
  //   - Known turnId -> that turn's mode.
  //   - Unknown turnId -> 'external-turn'. The request belongs to another
  //     client (e.g. a TUI attached to the same thread). Never lend this
  //     client's private-tools authority to it, and never answer for it.
  //   - No turnId -> also 'external-turn'. In a shared daemon, ownership
  //     cannot be proven without one, so requiring an explicit owner decision
  //     is safer than inheriting whatever the bridge is currently running.
  modeForRequest(params) {
    if (params?.turnId) {
      if (this.turnModes.has(params.turnId)) return this.turnModes.get(params.turnId);
      return 'external-turn';
    }
    return 'external-turn';
  }

  shouldApproveCommand(params, canWrite) {
    const command = params.command || params.commandActions?.map((action) => action.cmd).join(' && ') || '';
    const cwd = params.cwd || this.workdir;
    const networkRequested = Boolean(params.networkApprovalContext)
      || (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0);
    const allowed = canWrite
      && !networkRequested
      && !isDangerousCommand(command)
      && isSafeInspectionCommand(command)
      && isPathWithinRoots(cwd, this.toolWritableRoots, this.workdir);
    this.logSecurityEvent('command-approval', { command, cwd, networkRequested }, allowed ? 'approved' : 'declined');
    return allowed;
  }

  shouldApproveFileChange(params, canWrite) {
    const grantRoot = params.grantRoot || null;
    const filePaths = params.fileChanges ? Object.keys(params.fileChanges) : [];
    const requestedPaths = [grantRoot, ...filePaths].filter(Boolean);
    // Daemon mode forwards file changes to the owner. This synchronous
    // fallback exists only for callers without an approval channel, and it
    // must never approve a write just because the path is in-root.
    this.logSecurityEvent(
      'file-change-approval',
      { grantRoot, filePaths, canWrite, requestedPaths },
      'declined-manual-confirmation-required',
    );
    return false;
  }

  logSecurityEvent(kind, params, decision) {
    if (!this.onSecurityEvent) return;
    try { this.onSecurityEvent({ kind, decision, params }); } catch {}
  }

  call(method, params, timeoutMs = this.timeoutMs) {
    if (!this.upgraded || !this.socket?.writable) {
      return Promise.reject(new Error('Codex daemon not connected'));
    }
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    this.socket.write(encodeFrame(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    return promise;
  }

  notify(method, params) {
    if (!this.upgraded || !this.socket?.writable) return;
    this.socket.write(encodeFrame(JSON.stringify({ jsonrpc: '2.0', method, params })));
  }

  async handshake() {
    await this.call('initialize', {
      clientInfo: { name: 'codex-telegram-bridge', version: '0.4.0-daemon' },
      capabilities: null,
    });
    this.notify('initialized', {});

    if (this.threadId) {
      const originalThreadId = this.threadId;
      try {
        await this.resumeExistingThread(this.threadId);
      } catch (error) {
        // Session continuity is a hard invariant: one bot, one history. Never
        // replace the persisted thread just because resume failed — a silent
        // new thread looks like amnesia to whoever is chatting. Stay connected
        // but degraded so the owner can run /resume or /new deliberately.
        this.resumeBlocked = error;
        this.handshakeError = new Error(`locked thread could not be resumed: ${originalThreadId}`);
        this.log(`thread/resume(${originalThreadId}) failed: fail-closed, no replacement thread created`);
        this.logSecurityEvent('thread-resume-blocked', {
          previous_thread_id: originalThreadId,
          error: error?.message || String(error),
        }, 'fail-closed');
        if (this.onThreadChange) {
          try {
            this.onThreadChange({
              previousThreadId: originalThreadId,
              reason: 'resume-failed',
              blocked: true,
              error: error?.message || String(error),
            });
          } catch {}
        }
        return;
      }
    } else {
      await this.startThread();
      try { await this.dummyTurn(); } catch (e) { this.log(`Dummy turn failed (non-fatal): ${e.message}`); }
    }

    this.ready = true;
    this.resumeBlocked = null;
    this.handshakeError = null;
    if (this.onReady) this.onReady(this.threadId);
  }

  async startThread() {
    const started = await this.call('thread/start', {
      model: this.model,
      serviceTier: this.serviceTier,
      cwd: this.workdir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      serviceName: 'codex-telegram',
    });
    this.threadId = started.thread.id;
    return this.threadId;
  }

  async resumeExistingThread(threadId) {
    const resumed = await this.call('thread/resume', {
      threadId,
      model: this.model,
      serviceTier: this.serviceTier,
      cwd: this.workdir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      persistExtendedHistory: false,
    });
    if (resumed?.thread?.id !== threadId) {
      throw new Error(`thread/resume returned a different thread: expected=${threadId} actual=${resumed?.thread?.id || 'missing'}`);
    }
    this.threadId = resumed.thread.id;
    return this.threadId;
  }

  // Send a minimal initialization turn so the rollout JSONL is created on disk
  // and other clients (e.g. `codex --remote`) can resume the thread. Only ever
  // called for a freshly started thread, never after a failed resume.
  async dummyTurn() {
    const started = await this.call('turn/start', {
      threadId: this.threadId,
      input: [{
        type: 'text',
        text: '[bridge-handshake] Thread initialization handshake. Please acknowledge with a brief "ready"; do not treat this as a real user message.',
        text_elements: [],
      }],
      cwd: this.workdir,
      effort: 'low',
      approvalPolicy: 'never',
      sandboxPolicy: READ_ONLY_SANDBOX,
    });
    const turnId = started.turn.id;
    await new Promise((resolve, reject) => {
      const cached = this.completedTurns.get(turnId);
      if (cached) {
        this.completedTurns.delete(turnId);
        return resolve(cached);
      }
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error('Dummy turn timeout'));
      }, 60000);
      this.turnWaiters.set(turnId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  // Per-turn overrides. read-only and group turns use approvalPolicy 'never'
  // (no approval flow); private-tools turns switch to on-request so the
  // bridge's respondToServerRequest handler vets each command.
  buildTurnOverrides(mode) {
    if (mode !== 'private-tools') {
      return { approvalPolicy: 'never', sandboxPolicy: READ_ONLY_SANDBOX };
    }
    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: this.toolWritableRoots,
        networkAccess: this.toolNetworkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
  }

  async waitReady() {
    if (this.ready) return;
    if (this.handshakePromise) {
      try { await this.handshakePromise; } catch {}
    }
    if (this.closing) throw new Error('Codex daemon client closing');
    if (!this.ready) {
      if (this.handshakeError) throw this.handshakeError;
      throw new Error('Codex daemon not ready');
    }
  }

  async ask(text, images = [], options = {}) {
    await this.waitReady();

    const mode = options.toolMode || 'read-only';

    const input = [
      { type: 'text', text, text_elements: [] },
      ...images.map((image) => ({ type: 'localImage', path: image.path })),
    ];
    const started = await this.call('turn/start', {
      threadId: this.threadId,
      input,
      cwd: options.cwd || this.workdir,
      effort: this.effort,
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      ...this.buildTurnOverrides(mode),
    });

    const turnId = started.turn.id;
    this.turnModes.set(turnId, mode);
    this.activeTurnMode = { turnId, mode };

    const cached = this.completedTurns.get(turnId);
    if (cached) {
      this.completedTurns.delete(turnId);
      this.turnModes.delete(turnId);
      if (this.activeTurnMode?.turnId === turnId) this.activeTurnMode = null;
      return this.validateResult(cached);
    }

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        this.turnModes.delete(turnId);
        this.turnChunks.delete(turnId);
        if (this.activeTurnMode?.turnId === turnId) this.activeTurnMode = null;
        // Tell the daemon to stop; otherwise the abandoned turn keeps running
        // and its approval requests would arrive with no owner.
        this.call('turn/interrupt', { threadId: this.threadId, turnId }, 5000).catch(() => {});
        reject(new Error('Codex turn timeout'));
      }, this.timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    return this.validateResult(result);
  }

  validateResult(result) {
    if (result.turn.status === 'failed') {
      throw new Error(result.turn.error?.message || 'Codex turn failed');
    }
    if (!result.reply) throw new Error('Codex returned no message text.');
    return { reply: result.reply, threadId: this.threadId };
  }

  // /new and /resume are the two commands that are allowed to run while the
  // client is fail-closed on a resume failure — they are exactly how the owner
  // gets out of that state, so they must not wait on a handshake that will
  // never report ready.
  async newThread() {
    if (!this.ready && !(this.upgraded && this.resumeBlocked)) await this.waitReady();
    await this.startThread();
    this.ready = true;
    this.resumeBlocked = null;
    this.handshakeError = null;
    if (this.onReady) this.onReady(this.threadId);
    return this.threadId;
  }

  async resumeThread(threadId) {
    if (!this.ready && !(this.upgraded && this.resumeBlocked)) await this.waitReady();
    await this.resumeExistingThread(threadId);
    this.ready = true;
    this.resumeBlocked = null;
    this.handshakeError = null;
    if (this.onReady) this.onReady(this.threadId);
    return this.threadId;
  }

  failAll(error) {
    for (const handler of this.pending.values()) handler.reject(error);
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
    this.turnChunks.clear();
    this.turnModes.clear();
    this.completedTurns.clear();
    this.activeTurnMode = null;
    // Let the bridge invalidate approval cards still waiting for a tap: the
    // daemon is gone, so a late tap would try to answer a dead connection.
    if (typeof this.onDisconnect === 'function') {
      try {
        this.onDisconnect(error?.message || 'daemon-disconnect');
      } catch (e) {
        try { this.log(`onDisconnect callback threw: ${e.message}`); } catch {}
      }
    }
  }

  close() {
    this.closing = true;
    try { this.socket?.end(); } catch {}
  }
}
