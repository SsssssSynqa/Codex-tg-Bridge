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

    return items
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
  } catch {
    return [{ text: unwrapped, replyToMessageId: null }];
  }
}

export class PriorityTaskQueue {
  constructor() {
    this.running = false;
    this.sequence = 0;
    this.tasks = [];
  }

  run(task, priority = 0) {
    return new Promise((resolve, reject) => {
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
    log = console.log,
    timing = {},
    getTiming = null,
  }) {
    this.generateReplies = generateReplies;
    this.sendReply = sendReply;
    this.notifyFailure = notifyFailure;
    this.log = log;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.getTiming = typeof getTiming === 'function' ? getTiming : null;
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

  enqueue(message) {
    const chatId = String(message.chatId);
    const state = this.getState(chatId);

    if (message.senderIsBot && isNonConversationalBotMessage(message.text)) {
      this.log(`ignore bridge/status bot message chat=${chatId} from=${message.senderId}`);
      return { accepted: false, reason: 'bridge-status' };
    }

    if (!message.senderIsBot && isStopInstruction(message.text)) {
      state.muted = true;
      state.pending = [];
      state.firstPendingAt = 0;
      state.revision += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      this.log(`group muted chat=${chatId} revision=${state.revision}`);
      return { accepted: true, stopped: true };
    }

    if (state.muted) {
      if (message.senderIsBot) {
        this.log(`muted: ignore bot message chat=${chatId} from=${message.senderId}`);
        return { accepted: false, reason: 'muted' };
      }
      state.muted = false;
      this.log(`human message unmuted chat=${chatId}`);
    }

    if (message.senderIsBot && Date.now() < state.botPausedUntil) {
      this.log(`failure circuit: ignore bot message chat=${chatId} from=${message.senderId}`);
      return { accepted: false, reason: 'failure-circuit' };
    }

    const receivedAt = Number(message.receivedAt || Date.now());
    if (!state.pending.length) state.firstPendingAt = receivedAt;
    state.pending.push({ ...message, chatId, receivedAt });
    state.revision += 1;

    if (!state.processing) this.schedule(chatId, state);
    return { accepted: true, stopped: false };
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

    try {
      while (!state.muted && (carry.length || state.pending.length)) {
        const batch = [...carry, ...state.pending];
        carry = [];
        state.pending = [];
        state.firstPendingAt = 0;
        const revisionAtGeneration = state.revision;
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
            } catch (notifyError) {
              this.log(`failure notice failed chat=${chatId}: ${notifyError.message}`);
            }
          }
          this.log(`group generation failed chat=${chatId}: ${error.message}`);
          continue;
        }

        if (state.revision !== revisionAtGeneration) {
          this.log(`new context superseded draft chat=${chatId} revision=${revisionAtGeneration}->${state.revision}`);
          carry = batch;
          superseding = true;
          continue;
        }

        const shouldSend = () => (
          !state.muted
          && state.revision === revisionAtGeneration
          && !state.pending.length
        );
        for (const reply of replies) {
          if (!shouldSend()) {
            this.log(`send cancelled by newer context chat=${chatId} revision=${revisionAtGeneration}->${state.revision}`);
            break;
          }
          await this.sendReply(chatId, reply, batch, shouldSend);
        }

        this.log(
          `group batch completed chat=${chatId} messages=${batch.length} replies=${replies.length} elapsed_ms=${Date.now() - startedAt}`,
        );
        superseding = false;
      }
    } finally {
      state.processing = false;
      if (!state.muted && state.pending.length) this.schedule(chatId, state);
    }
  }
}
