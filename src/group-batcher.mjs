const DEFAULT_TIMING = Object.freeze({
  singleMessageMs: 1000,
  sameSenderIdleMs: 1800,
  sameSenderMaxMs: 3000,
  multiSenderIdleMs: 2200,
  multiSenderMaxMs: 5000,
});

export function isStopInstruction(text) {
  const normalized = String(text || '')
    .replace(/@[A-Za-z0-9_]+/g, '')
    .replace(/[，,。.!！?？~～\s]/g, '')
    .toLowerCase();
  return /^(?:everyone|all)?(?:stop|pause|quiet|silence|donotreply|noreplies)$/.test(normalized)
    || /^(?:大家)?(?:先)?(?:别|不要)(?:再)?回(?:复)?(?:了)?$/.test(normalized)
    || /^(?:大家)?(?:先)?(?:安静|停|暂停|停止回复|别说话|不要说话)(?:一下|一会儿|了)?$/.test(normalized);
}

export function isNonConversationalBotMessage(text) {
  const value = String(text || '');
  return value.startsWith('[bridge-status]')
    || /failed|error already logged|try again/i.test(value)
    || /You've hit your usage limit|rate limit|quota/i.test(value);
}

export function parseBatchReplies(raw, validMessageIds = []) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const validIds = new Set(validMessageIds.map(Number));
  const unwrapped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const firstBrace = unwrapped.indexOf('{');
  const lastBrace = unwrapped.lastIndexOf('}');
  const candidate = firstBrace >= 0 && lastBrace > firstBrace
    ? unwrapped.slice(firstBrace, lastBrace + 1)
    : unwrapped;

  try {
    const parsed = JSON.parse(candidate);
    const items = Array.isArray(parsed) ? parsed : parsed.replies;
    if (!Array.isArray(items)) throw new Error('replies is not an array');

    const replies = items
      .map((item) => {
        if (typeof item === 'string') return { text: item.trim(), replyToMessageId: null };
        const replyText = String(item?.text || '').trim();
        const requestedId = Number(item?.replyToMessageId);
        return {
          text: replyText,
          replyToMessageId: validIds.has(requestedId) ? requestedId : null,
        };
      })
      .filter((item) => item.text)
      .slice(0, 2);
    // Optional emoji reaction for the "read it, chose not to reply" case, so
    // silence in a group is distinguishable from not having seen the message.
    const react = typeof parsed.react === 'string' ? parsed.react.trim() : null;
    if (react) replies._react = react;
    return replies;
  } catch {
    // The group protocol is a security boundary: never publish malformed or
    // raw model output into a group chat.
    return [];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PriorityTaskQueue {
  constructor({ maxSize = 100 } = {}) {
    this.running = false;
    this.sequence = 0;
    this.tasks = [];
    this.maxSize = maxSize;
  }

  run(task, priority = 0) {
    return new Promise((resolve, reject) => {
      // A bounded queue is what makes backpressure visible. Without it a slow
      // model turn silently accumulates every message that arrives meanwhile.
      if (this.tasks.length >= this.maxSize) {
        reject(new Error(`task queue full (${this.maxSize})`));
        return;
      }
      this.tasks.push({ task, priority, sequence: this.sequence++, resolve, reject });
      this.tasks.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;

    while (this.tasks.length) {
      const next = this.tasks.shift();
      try {
        next.resolve(await next.task());
      } catch (error) {
        next.reject(error);
      }
    }

    this.running = false;
  }
}

export class GroupConversationBatcher {
  constructor({
    generateReplies,
    sendReply,
    notifyFailure,
    // Called after every reply in a batch has been accepted by Telegram. This
    // is the only safe place to commit per-batch state (context cursors,
    // durable "done" markers): anything committed earlier would be lost work
    // if the send failed.
    onBatchComplete = null,
    // Called when the model chose to stay silent but returned a reaction emoji.
    onReact = null,
    log = console.log,
    timing = {},
    getTiming = null,
    isImportantMessage = null,
    unimportantSupersedeThreshold = 5,
    maxPendingMessages = 100,
    contextDemotionMs = 0,
  }) {
    this.generateReplies = generateReplies;
    this.sendReply = sendReply;
    this.notifyFailure = notifyFailure;
    this.onBatchComplete = typeof onBatchComplete === 'function' ? onBatchComplete : null;
    this.onReact = typeof onReact === 'function' ? onReact : null;
    this.log = log;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.getTiming = typeof getTiming === 'function' ? getTiming : null;
    // Draft debounce: only "important" messages invalidate a draft that is
    // already being generated. Human messages are important by default, bot
    // chatter is not.
    this.isImportantMessage = typeof isImportantMessage === 'function'
      ? isImportantMessage
      : (message) => !message.senderIsBot;
    // Enough unimportant messages still count as a context change and force a
    // rewrite (0 or negative disables this fallback).
    this.unimportantSupersedeThreshold = unimportantSupersedeThreshold;
    this.maxPendingMessages = Math.max(1, Number(maxPendingMessages) || 100);
    // Age-based demotion: messages received more than this many milliseconds
    // before the batch starts generating are marked contextOnly, and the
    // caller should render them as background that needs no reply. This keeps
    // a slow model from serially answering a backlog long after the fact.
    // 0 disables it; the newest message is always left answerable.
    this.contextDemotionMs = Math.max(0, Number(contextDemotionMs) || 0);
    this.chats = new Map();
  }

  getState(chatId) {
    const key = String(chatId);
    if (!this.chats.has(key)) {
      this.chats.set(key, {
        pending: [],
        firstPendingAt: 0,
        timer: null,
        processing: false,
        revision: 0,
        importantRevision: 0,
        muted: false,
        botPausedUntil: 0,
        lastFailureNoticeAt: 0,
      });
    }
    return this.chats.get(key);
  }

  timingFor(chatId, state) {
    const override = this.getTiming ? this.getTiming(String(chatId), state) : null;
    return { ...this.timing, ...(override || {}) };
  }

  // Returns { accepted, completion }. `completion` resolves once this message
  // has been fully handled (sent, suppressed, or superseded) and rejects if
  // handling failed, so a durable caller can decide when to mark it done.
  enqueue(message) {
    const chatId = String(message.chatId);
    const state = this.getState(chatId);
    let settleResolve;
    let settleReject;
    const completion = new Promise((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    completion.catch(() => {});
    const delivery = { resolve: settleResolve, reject: settleReject, settled: false };
    const finish = (value) => {
      if (delivery.settled) return;
      delivery.settled = true;
      delivery.resolve(value);
    };

    if (message.senderIsBot && isNonConversationalBotMessage(message.text)) {
      this.log(`ignore bridge status message chat=${chatId} from=${message.senderId}`);
      finish({ suppressed: true, reason: 'bridge-status' });
      return { accepted: false, reason: 'bridge-status', completion };
    }

    if (!message.senderIsBot && isStopInstruction(message.text)) {
      state.muted = true;
      for (const pending of state.pending) {
        this.settleMessage(pending, { suppressed: true, reason: 'stop-instruction' });
      }
      state.pending = [];
      state.firstPendingAt = 0;
      state.revision += 1;
      state.importantRevision += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      this.log(`group muted chat=${chatId} revision=${state.revision}`);
      finish({ suppressed: true, reason: 'stop-instruction' });
      return { accepted: true, stopped: true, completion };
    }

    if (state.muted) {
      if (message.senderIsBot) {
        this.log(`muted: ignoring bot message chat=${chatId} from=${message.senderId}`);
        finish({ suppressed: true, reason: 'muted' });
        return { accepted: false, reason: 'muted', completion };
      }
      state.muted = false;
      this.log(`a human message lifted the mute chat=${chatId}`);
    }

    if (message.senderIsBot && Date.now() < state.botPausedUntil) {
      this.log(`failure circuit open: ignoring bot message chat=${chatId} from=${message.senderId}`);
      finish({ suppressed: true, reason: 'failure-circuit' });
      return { accepted: false, reason: 'failure-circuit', completion };
    }

    if (state.pending.length >= this.maxPendingMessages) {
      const error = new Error(`group queue full chat=${chatId} limit=${this.maxPendingMessages}`);
      delivery.settled = true;
      delivery.reject(error);
      return { accepted: false, reason: 'queue-full', completion };
    }

    const receivedAt = Number(message.receivedAt || Date.now());
    if (!state.pending.length) state.firstPendingAt = receivedAt;
    state.pending.push({ ...message, chatId, receivedAt, _delivery: delivery });
    state.revision += 1;
    if (this.isImportantMessage(message)) state.importantRevision += 1;

    if (!state.processing) this.schedule(chatId, state);
    return { accepted: true, stopped: false, completion };
  }

  settleMessage(message, value, error = null) {
    const delivery = message?._delivery;
    if (!delivery || delivery.settled) return;
    delivery.settled = true;
    if (error) delivery.reject(error);
    else delivery.resolve(value);
  }

  settleBatch(batch, value, error = null) {
    for (const message of batch) this.settleMessage(message, value, error);
  }

  schedule(chatId, state) {
    if (state.timer) clearTimeout(state.timer);
    if (!state.pending.length) return;

    const now = Date.now();
    const timing = this.timingFor(chatId, state);
    const senderCount = new Set(state.pending.map((message) => message.senderId)).size;
    let deadline;

    if (state.pending.length === 1) {
      deadline = state.firstPendingAt + timing.singleMessageMs;
    } else if (senderCount === 1) {
      deadline = Math.min(
        state.firstPendingAt + timing.sameSenderMaxMs,
        now + timing.sameSenderIdleMs,
      );
    } else {
      deadline = Math.min(
        state.firstPendingAt + timing.multiSenderMaxMs,
        now + timing.multiSenderIdleMs,
      );
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      this.flush(chatId).catch((error) => this.log(`group batch crashed chat=${chatId}: ${error.message}`));
    }, Math.max(0, deadline - now));
  }

  async flush(chatId) {
    const state = this.getState(chatId);
    if (state.processing || !state.pending.length || state.muted) return;

    state.processing = true;
    let carry = [];
    let superseding = false;
    let activeBatch = [];

    try {
      while (!state.muted && (carry.length || state.pending.length)) {
        const batch = [...carry, ...state.pending];
        activeBatch = batch;
        carry = [];
        state.pending = [];
        state.firstPendingAt = 0;
        // Recomputed on every round rather than only added to: with supersede
        // enabled the same message object can travel through several rounds,
        // so the mark has to be re-decided against the current clock. If every
        // message is stale, the newest one stays answerable — otherwise the
        // downstream protocol has no message id to reply to.
        if (this.contextDemotionMs > 0 && batch.length) {
          const cutoff = Date.now() - this.contextDemotionMs;
          for (const message of batch) message.contextOnly = message.receivedAt < cutoff;
          if (batch.every((message) => message.contextOnly)) {
            batch[batch.length - 1].contextOnly = false;
          }
          const demoted = batch.filter((message) => message.contextOnly).length;
          if (demoted) this.log(`age demotion chat=${chatId}: ${demoted}/${batch.length} messages became background`);
        }
        const revisionAtGeneration = state.revision;
        const importantAtGeneration = state.importantRevision;
        const startedAt = Date.now();

        let replies;
        try {
          replies = await this.generateReplies(batch, { superseding });
        } catch (error) {
          state.botPausedUntil = Date.now() + 5 * 60 * 1000;
          const containsHuman = batch.some((message) => !message.senderIsBot);
          if (
            containsHuman
            && this.notifyFailure
            && Date.now() - state.lastFailureNoticeAt > 5 * 60 * 1000
          ) {
            state.lastFailureNoticeAt = Date.now();
            try {
              await this.notifyFailure(chatId, error, batch);
            } catch (noticeError) {
              this.log(`failure notice failed chat=${chatId}: ${noticeError.message}`);
            }
          }
          this.log(`group generation failed chat=${chatId}: ${error.message}`);
          this.settleBatch(batch, null, error);
          activeBatch = [];
          superseding = false;
          continue;
        }

        if (state.muted) {
          this.log(`stop instruction cancelled the draft chat=${chatId}`);
          this.settleBatch(batch, { suppressed: true, reason: 'muted-during-generation' });
          activeBatch = [];
          break;
        }

        // Ordinary bot chatter no longer invalidates a draft; only an important
        // message (human/addressed) or enough drift does.
        const unimportantDrift = (state.revision - revisionAtGeneration)
          - (state.importantRevision - importantAtGeneration);
        const supersededByImportant = state.importantRevision !== importantAtGeneration;
        const supersededByDrift = this.unimportantSupersedeThreshold > 0
          && unimportantDrift >= this.unimportantSupersedeThreshold;

        if (supersededByImportant || supersededByDrift) {
          carry = [...batch, ...state.pending];
          state.pending = [];
          state.firstPendingAt = 0;
          superseding = true;
          this.log(
            `new context cancelled the draft chat=${chatId} revision=${revisionAtGeneration}->${state.revision}`
            + ` reason=${supersededByImportant ? 'important-message' : `low-importance-drift x${unimportantDrift}`}`,
          );
          continue;
        }

        const shouldSend = () => !state.muted && state.importantRevision === importantAtGeneration;
        let fullySent = true;
        // Silence plus reaction: no replies but a react emoji was returned.
        if (!replies.length && replies._react && shouldSend() && this.onReact) {
          const lastMsg = batch[batch.length - 1];
          if (lastMsg?.messageId) {
            try {
              await this.onReact(chatId, lastMsg.messageId, replies._react);
            } catch (e) {
              this.log(`react failed chat=${chatId}: ${e.message}`);
            }
          }
        }
        for (const [replyIndex, reply] of replies.entries()) {
          if (!shouldSend()) break;
          const sent = await this.sendReply(chatId, reply, batch, shouldSend, { replyIndex });
          if (sent === false) {
            if (shouldSend()) {
              throw new Error(`sendReply returned false without a superseding message chat=${chatId}`);
            }
            fullySent = false;
            break;
          }
        }

        if (!fullySent || !shouldSend()) {
          carry = [...batch, ...state.pending];
          state.pending = [];
          state.firstPendingAt = 0;
          superseding = true;
          this.log(`context changed while sending; regrouping chat=${chatId}`);
          continue;
        }

        if (this.onBatchComplete) await this.onBatchComplete(chatId, batch, replies);
        this.settleBatch(batch, { sent: true, replyCount: replies.length });
        activeBatch = [];

        this.log(
          `group batch done chat=${chatId} messages=${batch.length} replies=${replies.length} elapsed_ms=${Date.now() - startedAt}`,
        );
        superseding = false;
      }
    } catch (error) {
      this.settleBatch(activeBatch, null, error);
      throw error;
    } finally {
      state.processing = false;
      if (state.pending.length && !state.muted) this.schedule(chatId, state);
    }
  }

  async waitForIdle(chatId, timeoutMs = 10000) {
    const startedAt = Date.now();
    for (;;) {
      const state = this.getState(chatId);
      if (!state.processing && !state.pending.length && !state.timer) return;
      if (Date.now() - startedAt > timeoutMs) throw new Error('group batcher idle timeout');
      await sleep(20);
    }
  }
}
