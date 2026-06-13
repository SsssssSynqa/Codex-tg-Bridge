import { spawn } from 'node:child_process';
import path from 'node:path';

const READ_ONLY_SANDBOX = { type: 'readOnly', networkAccess: false };

function normalizeAllowedRoots(roots, fallbackRoot) {
  const values = Array.isArray(roots) && roots.length ? roots : [fallbackRoot];
  return [...new Set(values.map((root) => path.resolve(root)))];
}

function isPathWithinRoots(filePath, roots, cwd) {
  if (!filePath) return true;
  const resolved = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath));
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

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

export class CodexAppClient {
  constructor({
    codexPath,
    workdir,
    threadId = null,
    model = 'gpt-5.5',
    effort = 'medium',
    serviceTier = 'fast',
    timeoutMs = 600000,
    toolWritableRoots = null,
    toolNetworkAccess = false,
    onReady,
    onSecurityEvent,
    log = () => {},
  }) {
    this.codexPath = codexPath;
    this.workdir = workdir;
    this.threadId = threadId;
    this.model = model;
    this.effort = effort;
    this.serviceTier = serviceTier;
    this.timeoutMs = timeoutMs;
    this.toolWritableRoots = normalizeAllowedRoots(toolWritableRoots, workdir);
    this.toolNetworkAccess = toolNetworkAccess === true;
    this.onReady = onReady;
    this.onSecurityEvent = onSecurityEvent;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.turnChunks = new Map();
    this.turnModes = new Map();
    this.completedTurns = new Map();
    this.buffer = '';
    this.ready = false;
    this.closing = false;
    this.activeTurnMode = null;
    this.handshakeError = null;
    this.handshakePromise = null;
    this.spawnServer();
  }

  spawnServer() {
    this.ready = false;
    this.buffer = '';
    this.child = spawn(
      this.codexPath,
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        `model="${this.model}"`,
        '-c',
        `service_tier="${this.serviceTier}"`,
      ],
      {
        cwd: this.workdir,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.log(`[codex stderr] ${text}`);
    });
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('exit', (code, signal) => {
      this.ready = false;
      this.failAll(new Error(`Codex app-server exited code=${code} signal=${signal || ''}`));
      if (!this.closing) setTimeout(() => this.spawnServer(), 2000);
    });

    this.handshakeError = null;
    this.handshakePromise = this.handshake().catch((error) => {
      this.ready = false;
      this.handshakeError = error;
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim() || line[0] !== '{') continue;

      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        // Ignore non-protocol output.
      }
    }
  }

  handleMessage(message) {
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const handler = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!handler) return;
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      const { turnId, delta } = message.params;
      this.turnChunks.set(turnId, (this.turnChunks.get(turnId) || '') + delta);
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = message.params.turn;
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
        this.completedTurns.set(turn.id, result);
      }
      return;
    }

    if (message.id != null && message.method) {
      this.respondToServerRequest(message);
    }
  }

  respondToServerRequest(message) {
    try {
      const result = this.handleServerRequest(message.method, message.params || {});
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    } catch (error) {
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: error.message || 'Telegram bridge rejected this request' },
        })}\n`,
      );
    }
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

  modeForRequest(params) {
    if (params?.turnId && this.turnModes.has(params.turnId)) return this.turnModes.get(params.turnId);
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
    const allowed = canWrite
      && requestedPaths.every((filePath) => isPathWithinRoots(filePath, this.toolWritableRoots, this.workdir));
    this.logSecurityEvent('file-change-approval', { grantRoot, filePaths }, allowed ? 'approved' : 'declined');
    return allowed;
  }

  logSecurityEvent(kind, params, decision) {
    if (!this.onSecurityEvent) return;
    try {
      this.onSecurityEvent({ kind, decision, params });
    } catch {
      // Logging hooks must not break protocol responses.
    }
  }

  send(method, params) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error('Codex app-server stdin is not writable'));
    }

    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async handshake() {
    await this.send('initialize', {
      clientInfo: { name: 'telegram-codex-bridge', version: '0.1.0' },
      capabilities: null,
    });
    this.notify('initialized', {});

    if (this.threadId) {
      try {
        const resumed = await this.send('thread/resume', {
          threadId: this.threadId,
          model: this.model,
          serviceTier: this.serviceTier,
          cwd: this.workdir,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          excludeTurns: true,
          persistExtendedHistory: false,
        });
        this.threadId = resumed.thread.id;
      } catch {
        await this.startThread();
      }
    } else {
      await this.startThread();
    }

    this.ready = true;
    if (this.onReady) this.onReady(this.threadId);
  }

  async startThread() {
    const started = await this.send('thread/start', {
      model: this.model,
      serviceTier: this.serviceTier,
      cwd: this.workdir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    this.threadId = started.thread.id;
    return this.threadId;
  }

  async resumeExistingThread(threadId) {
    const resumed = await this.send('thread/resume', {
      threadId,
      model: this.model,
      serviceTier: this.serviceTier,
      cwd: this.workdir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      excludeTurns: true,
      persistExtendedHistory: false,
    });
    this.threadId = resumed.thread.id;
    return this.threadId;
  }

  buildTurnOverrides(mode) {
    if (mode !== 'private-tools') {
      return {
        approvalPolicy: 'never',
        sandboxPolicy: READ_ONLY_SANDBOX,
      };
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
    if (this.handshakePromise) await this.handshakePromise;
    if (this.handshakeError) throw this.handshakeError;
    if (!this.ready) throw new Error('Codex app-server is not ready');
  }

  async ask(text, images = [], options = {}) {
    await this.waitReady();
    const mode = options.toolMode || 'read-only';
    const input = [
      { type: 'text', text, text_elements: [] },
      ...images.map((image) => ({ type: 'localImage', path: image.path })),
    ];
    const started = await this.send('turn/start', {
      threadId: this.threadId,
      input,
      cwd: options.cwd || this.workdir,
      effort: this.effort,
      ...this.buildTurnOverrides(mode),
    });
    const turnId = started.turn.id;
    this.turnModes.set(turnId, mode);
    this.activeTurnMode = { turnId, mode };

    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      this.turnModes.delete(turnId);
      if (this.activeTurnMode?.turnId === turnId) this.activeTurnMode = null;
      return this.validateResult(completed);
    }

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error('Codex response timed out'));
      }, this.timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    return this.validateResult(result);
  }

  validateResult(result) {
    if (result.turn.status === 'failed') {
      throw new Error(result.turn.error?.message || 'Codex turn failed');
    }
    if (!result.reply) throw new Error('Codex produced no sendable text');
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
    try {
      this.child?.kill('SIGTERM');
    } catch {
      // Process may already be gone.
    }
  }
}
