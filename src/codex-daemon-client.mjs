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
//   - modeForRequest distinguishes three cases:
//       1. params.turnId is known to this client -> use that turn's mode.
//       2. params.turnId is unknown to this client -> conservative read-only
//          (this is some other client's turn; do not lend our private-tools
//          authority to answer their approval).
//       3. No params.turnId -> fall back to pendingTurnMode (set immediately
//          before turn/start) and then activeTurnMode, to cover server
//          requests that race the turn/start response.
//   - thread/resume failure falls back to thread/start plus a short dummy turn
//     so the rollout file exists on disk and other clients can attach. The
//     onThreadChange callback fires before the swap so the bridge can save the
//     previous thread id (e.g. to session.previous.txt) for recovery.
//
// Security
//   - The default daemon socket lives at $CODEX_HOME/app-server-control/
//     app-server-control.sock with mode 0600. Only the user that started the
//     daemon can connect.
//   - The bridge's existing respondToServerRequest / approval handlers are
//     reused verbatim so the writable-root / dangerous-command / token-leak
//     defenses still apply.

import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';

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

// Shared with codex-client.mjs: dangerous command list and path containment.
function commandText(command) {
  if (Array.isArray(command)) return command.join(' ');
  return String(command || '');
}
function isDangerousCommand(command) {
  const text = commandText(command);
  return [
    /\brm\s+[^;&|]*(-[^\s]*r|--recursive)\b/i,
    /\bsudo\b/i,
    /\bgit\s+(reset\s+--hard|clean\s+-f|checkout\s+--|push\s+--force)\b/i,
    /\bchmod\s+[^;&|]*(-[^\s]*R|--recursive)\b/i,
    /\bchown\s+[^;&|]*(-[^\s]*R|--recursive)\b/i,
    /\bdd\s+[^;&|]*(if=|of=)/i,
    /\bdiskutil\b/i,
    /\bmkfs\b/i,
    /\blaunchctl\s+(bootout|remove|unload)\b/i,
    /\b(killall|pkill)\b/i,
    /\b\d+:[A-Za-z0-9_-]{30,}\b/,
  ].some((pattern) => pattern.test(text));
}
function normalizeAllowedRoots(roots, fallbackRoot) {
  const values = Array.isArray(roots) && roots.length ? roots : [fallbackRoot];
  return [...new Set(values.map((root) => path.resolve(root)))];
}
function isPathWithinRoots(filePath, roots, cwd) {
  if (!filePath) return true;
  const resolved = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath));
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
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
    this.turnModes = new Map();
    this.activeTurnMode = null;
    this.pendingTurnMode = null;
    this.ready = false;
    this.closing = false;
    this.handshakeError = null;
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
        if (!this.upgraded) reject(err);
        else this.failAll(err);
      });

      this.socket.on('close', () => {
        const wasUpgraded = this.upgraded;
        this.ready = false;
        this.upgraded = false;
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
            return reject(new Error(`WS handshake failed: ${head.slice(0, 200)}`));
          }
          if (!head.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
            return reject(new Error('WS handshake accept key mismatch'));
          }
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
      this.turnChunks.set(turnId, (this.turnChunks.get(turnId) || '') + delta);
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

  // Mirrors the server-request handling in codex-client.mjs so the same
  // path/command/file-change guard rails apply in daemon mode.
  respondToServerRequest(message) {
    try {
      const result = this.handleServerRequest(message.method, message.params || {});
      this.sendResponse(message.id, result);
    } catch (error) {
      this.sendResponse(message.id, null, { code: -32601, message: error.message || 'rejected' });
    }
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
  //   - Unknown turnId -> conservative read-only. The request belongs to
  //     another client (e.g. a TUI attached to the same thread); do not lend
  //     this client's private-tools authority to it.
  //   - No turnId -> fall back to pendingTurnMode (set just before
  //     turn/start) then activeTurnMode. This covers the short race where a
  //     server request arrives before the turn/start response.
  modeForRequest(params) {
    if (params?.turnId) {
      if (this.turnModes.has(params.turnId)) return this.turnModes.get(params.turnId);
      return 'read-only';
    }
    if (this.pendingTurnMode) return this.pendingTurnMode;
    return this.activeTurnMode?.mode || 'read-only';
  }

  shouldApproveCommand(params, canWrite) {
    const command = params.command || params.commandActions?.map((action) => action.cmd).join(' && ') || '';
    const cwd = params.cwd || this.workdir;
    const networkRequested = Boolean(params.networkApprovalContext)
      || (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0);
    const allowed = canWrite
      && !networkRequested
      && !isDangerousCommand(command)
      && isPathWithinRoots(cwd, this.toolWritableRoots, this.workdir);
    this.logSecurityEvent('command-approval', { command, cwd, networkRequested }, allowed ? 'approved' : 'declined');
    return allowed;
  }

  shouldApproveFileChange(params, canWrite) {
    const grantRoot = params.grantRoot || null;
    const filePaths = params.fileChanges ? Object.keys(params.fileChanges) : [];
    const requestedPaths = [grantRoot, ...filePaths].filter(Boolean);
    const allowed = canWrite && requestedPaths.every((fp) => isPathWithinRoots(fp, this.toolWritableRoots, this.workdir));
    this.logSecurityEvent('file-change-approval', { grantRoot, filePaths }, allowed ? 'approved' : 'declined');
    return allowed;
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
      clientInfo: { name: 'codex-telegram-bridge', version: '0.3.0-daemon' },
      capabilities: null,
    });
    this.notify('initialized', {});

    if (this.threadId) {
      const originalThreadId = this.threadId;
      try {
        await this.resumeExistingThread(this.threadId);
      } catch (error) {
        this.log(`thread/resume(${originalThreadId}) failed: ${error.message}; falling back to startThread + dummy turn`);
        this.logSecurityEvent('thread-resume-fallback', {
          previous_thread_id: originalThreadId,
          error: error?.message || String(error),
        }, 'fallback-with-dummy-turn');
        if (this.onThreadChange) {
          try { this.onThreadChange({ previousThreadId: originalThreadId, reason: 'resume-failed' }); } catch {}
        }
        await this.startThread();
        try {
          await this.dummyTurn();
          this.log('Dummy turn completed; rollout flushed and other clients can attach.');
        } catch (e) {
          this.log(`Dummy turn failed (non-fatal): ${e.message}`);
        }
      }
    } else {
      await this.startThread();
      try { await this.dummyTurn(); } catch (e) { this.log(`Dummy turn failed (non-fatal): ${e.message}`); }
    }

    this.ready = true;
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
    this.threadId = resumed.thread.id;
    return this.threadId;
  }

  // Send a minimal initialization turn so the rollout JSONL is created on
  // disk and other clients (e.g. `codex --remote`) can resume the thread.
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

    // Pre-set pendingTurnMode so an approval request that races the
    // turn/start response sees the correct mode.
    this.pendingTurnMode = mode;
    let started;
    try {
      const input = [
        { type: 'text', text, text_elements: [] },
        ...images.map((image) => ({ type: 'localImage', path: image.path })),
      ];
      started = await this.call('turn/start', {
        threadId: this.threadId,
        input,
        cwd: options.cwd || this.workdir,
        effort: this.effort,
        ...this.buildTurnOverrides(mode),
      });
    } finally {
      this.pendingTurnMode = null;
    }

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

  async newThread() {
    await this.waitReady();
    await this.startThread();
    if (this.onReady) this.onReady(this.threadId);
    return this.threadId;
  }

  async resumeThread(threadId) {
    await this.waitReady();
    await this.resumeExistingThread(threadId);
    if (this.onReady) this.onReady(this.threadId);
    return this.threadId;
  }

  failAll(error) {
    for (const handler of this.pending.values()) handler.reject(error);
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
  }

  close() {
    this.closing = true;
    try { this.socket?.end(); } catch {}
  }
}
