import { spawn } from 'node:child_process';

export class CodexAppClient {
  constructor({
    codexPath,
    workdir,
    threadId = null,
    model = 'gpt-5.5',
    effort = 'medium',
    timeoutMs = 600000,
    onReady,
    log = () => {},
  }) {
    this.codexPath = codexPath;
    this.workdir = workdir;
    this.threadId = threadId;
    this.model = model;
    this.effort = effort;
    this.timeoutMs = timeoutMs;
    this.onReady = onReady;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.turnChunks = new Map();
    this.completedTurns = new Map();
    this.buffer = '';
    this.ready = false;
    this.closing = false;
    this.handshakeError = null;
    this.handshakePromise = null;
    this.spawnServer();
  }

  spawnServer() {
    this.ready = false;
    this.buffer = '';
    this.child = spawn(
      this.codexPath,
      ['app-server', '--listen', 'stdio://', '-c', `model="${this.model}"`],
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
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Telegram bridge does not expose tools' },
        })}\n`,
      );
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

  async waitReady() {
    if (this.ready) return;
    if (this.handshakePromise) await this.handshakePromise;
    if (this.handshakeError) throw this.handshakeError;
    if (!this.ready) throw new Error('Codex app-server is not ready');
  }

  async ask(text, images = []) {
    await this.waitReady();
    const input = [
      { type: 'text', text, text_elements: [] },
      ...images.map((image) => ({ type: 'localImage', path: image.path })),
    ];
    const started = await this.send('turn/start', {
      threadId: this.threadId,
      input,
      effort: this.effort,
    });
    const turnId = started.turn.id;

    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
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
