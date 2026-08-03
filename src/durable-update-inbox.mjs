import fs from 'node:fs';
import path from 'node:path';

function updateIdOf(update) {
  const id = Number(update?.update_id);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid Telegram update_id');
  return id;
}

function fsyncDirectory(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync on directories.
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function appendJsonLine(filePath, event) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(filePath);
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`append write made no progress: ${filePath}`);
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
  if (!existed) fsyncDirectory(directory);
}

function writeAtomicPrivateFile(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(value), { encoding: 'utf8', mode: 0o600 });
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(directory);
}

export class DurableUpdateInbox {
  constructor(filePath, {
    compactBytes = 8 * 1024 * 1024,
    keepDone = 512,
    rawArchivePath = null,
  } = {}) {
    this.filePath = filePath;
    this.compactBytes = compactBytes;
    this.keepDone = keepDone;
    this.rawArchivePath = rawArchivePath;
    this.rawArchiveOffsetPath = rawArchivePath ? `${rawArchivePath}.offset` : null;
    this.lastArchivedUpdateId = -1;
    if (this.rawArchiveOffsetPath) {
      try {
        const id = Number(fs.readFileSync(this.rawArchiveOffsetPath, 'utf8').trim());
        if (Number.isSafeInteger(id)) this.lastArchivedUpdateId = id;
      } catch {}
    }
    this.records = new Map();
    this.doneOrder = [];
    this.groupBatches = new Map();
    this.updateToGroupBatch = new Map();
    this.load();
  }

  applyGroupBatchEvent(event) {
    const batchId = String(event.batchId || '');
    if (!batchId) return;

    if (event.state === 'group_batch') {
      const updateIds = [...new Set(
        (event.updateIds || []).map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0),
      )];
      if (!updateIds.length || !Array.isArray(event.preparedMessages)) return;
      for (const updateId of updateIds) {
        const previousBatchId = this.updateToGroupBatch.get(updateId);
        if (previousBatchId && previousBatchId !== batchId) {
          const previous = this.groupBatches.get(previousBatchId);
          if (previous) previous.state = 'superseded';
        }
      }
      const record = {
        state: 'active',
        batchId,
        chatId: String(event.chatId || ''),
        updateIds,
        preparedMessages: event.preparedMessages,
        replies: null,
        threadId: null,
        ackedReplyIndexes: new Set(),
        attempts: Number(event.attempts || 0),
        nextAttemptAt: Number(event.nextAttemptAt || 0),
        lastError: event.lastError || null,
      };
      this.groupBatches.set(batchId, record);
      for (const updateId of updateIds) this.updateToGroupBatch.set(updateId, batchId);
      return;
    }

    const record = this.groupBatches.get(batchId);
    if (!record) return;
    if (event.state === 'group_replies') {
      record.replies = Array.isArray(event.replies) ? event.replies : [];
      record.threadId = event.threadId ? String(event.threadId) : null;
    } else if (event.state === 'group_reply_ack') {
      const index = Number(event.replyIndex);
      if (Number.isInteger(index) && index >= 0) record.ackedReplyIndexes.add(index);
    } else if (event.state === 'group_retry') {
      record.attempts = Number(event.attempts || record.attempts || 0);
      record.nextAttemptAt = Number(event.nextAttemptAt || 0);
      record.lastError = event.lastError || null;
      for (const updateId of record.updateIds) {
        const current = this.records.get(updateId);
        if (current?.state === 'received') {
          this.records.set(updateId, {
            ...current,
            attempts: record.attempts,
            nextAttemptAt: record.nextAttemptAt,
            lastError: record.lastError,
          });
        }
      }
    } else if (event.state === 'group_dead') {
      record.state = 'dead';
      record.attempts = Number(event.attempts || record.attempts || 0);
      record.nextAttemptAt = 0;
      record.lastError = event.lastError || null;
      for (const updateId of record.updateIds) {
        const current = this.records.get(updateId);
        if (current?.update) {
          this.records.set(updateId, {
            ...current,
            state: 'dead',
            attempts: record.attempts,
            nextAttemptAt: 0,
            lastError: record.lastError,
          });
        }
      }
    } else if (event.state === 'group_requeue') {
      record.state = 'active';
      record.attempts = 0;
      record.nextAttemptAt = 0;
      record.lastError = null;
      for (const updateId of record.updateIds) {
        const current = this.records.get(updateId);
        if (current?.update) {
          this.records.set(updateId, {
            ...current,
            state: 'received',
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
          });
          this.updateToGroupBatch.set(updateId, batchId);
        }
      }
    } else if (event.state === 'group_superseded' || event.state === 'group_done') {
      record.state = event.state === 'group_done' ? 'done' : 'superseded';
      for (const updateId of record.updateIds) {
        if (this.updateToGroupBatch.get(updateId) === batchId) this.updateToGroupBatch.delete(updateId);
      }
      if (event.state === 'group_done') {
        for (const updateId of record.updateIds) this.markDoneInMemory(updateId);
      }
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (String(event.state || '').startsWith('group_')) {
        this.applyGroupBatchEvent(event);
        continue;
      }
      const id = Number(event.updateId);
      if (!Number.isSafeInteger(id)) continue;
      const current = this.records.get(id);
      if (event.state === 'received' && event.update) {
        this.records.set(id, {
          state: 'received',
          update: event.update,
          attempts: Number(event.attempts || 0),
          nextAttemptAt: Number(event.nextAttemptAt || 0),
          lastError: event.lastError || null,
          privateDelivery: current?.privateDelivery || null,
          operation: current?.operation || null,
        });
      } else if (event.state === 'private_generated') {
        const current = this.records.get(id);
        if (current?.update) {
          this.records.set(id, {
            ...current,
            privateDelivery: {
              reply: String(event.reply || ''),
              threadId: event.threadId ? String(event.threadId) : null,
              chatId: String(event.chatId || ''),
              sent: false,
              sendResult: null,
            },
          });
        }
      } else if (event.state === 'private_send_ack') {
        const current = this.records.get(id);
        if (current?.privateDelivery) {
          current.privateDelivery.sent = true;
          current.privateDelivery.sendResult = event.sendResult || null;
        }
      } else if (event.state === 'operation_intent') {
        const current = this.records.get(id);
        if (current?.update) {
          current.operation = {
            name: String(event.name || ''),
            payload: event.payload || {},
            status: 'intent',
            result: null,
          };
        }
      } else if (event.state === 'operation_result') {
        const current = this.records.get(id);
        if (current?.operation) {
          current.operation.status = 'result';
          current.operation.result = event.result || {};
        }
      } else if (event.state === 'retry') {
        const current = this.records.get(id);
        if (current?.update) {
          this.records.set(id, {
            ...current,
            state: 'received',
            attempts: Number(event.attempts || current.attempts || 0),
            nextAttemptAt: Number(event.nextAttemptAt || 0),
            lastError: event.lastError || null,
          });
        }
      } else if (event.state === 'dead') {
        this.records.set(id, {
          ...current,
          state: 'dead',
          update: event.update || current?.update || null,
          attempts: Number(event.attempts || current?.attempts || 0),
          lastError: event.lastError || current?.lastError || null,
        });
      } else if (event.state === 'done') {
        this.records.set(id, { state: 'done', update: null });
        this.doneOrder.push(id);
      }
    }
    this.trimDoneIndex();
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }

  markDoneInMemory(updateId) {
    const id = Number(updateId);
    if (this.records.get(id)?.state === 'done') return;
    this.records.set(id, { state: 'done', update: null });
    this.doneOrder.push(id);
  }

  append(event) {
    appendJsonLine(this.filePath, event);
  }

  archiveRaw(update, updateId) {
    if (!this.rawArchivePath || updateId <= this.lastArchivedUpdateId) return;
    // The archive is append-only and never compacted. The offset is written
    // second, so a crash can at worst duplicate one line, never lose it.
    appendJsonLine(this.rawArchivePath, {
      archivedAt: new Date().toISOString(),
      updateId,
      update,
    });
    writeAtomicPrivateFile(this.rawArchiveOffsetPath, updateId);
    this.lastArchivedUpdateId = updateId;
  }

  recordReceived(update) {
    const updateId = updateIdOf(update);
    this.archiveRaw(update, updateId);
    const existing = this.records.get(updateId);
    if (existing) return existing.state === 'received';
    this.append({ state: 'received', updateId, recordedAt: new Date().toISOString(), attempts: 0, update });
    this.records.set(updateId, {
      state: 'received',
      update,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      privateDelivery: null,
      operation: null,
    });
    return true;
  }

  markPrivateGenerated(updateId, { reply, threadId, chatId }) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.update || current.state !== 'received') throw new Error(`update ${id} is not in a deliverable state`);
    if (current.privateDelivery) return current.privateDelivery;
    const event = {
      state: 'private_generated',
      updateId: id,
      recordedAt: new Date().toISOString(),
      reply: String(reply || ''),
      threadId: threadId ? String(threadId) : null,
      chatId: String(chatId || ''),
    };
    this.append(event);
    current.privateDelivery = {
      reply: event.reply,
      threadId: event.threadId,
      chatId: event.chatId,
      sent: false,
      sendResult: null,
    };
    return current.privateDelivery;
  }

  privateDelivery(updateId) {
    const delivery = this.records.get(Number(updateId))?.privateDelivery;
    return delivery ? structuredClone(delivery) : null;
  }

  markPrivateSendAck(updateId, sendResult = null) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.privateDelivery) throw new Error(`update ${id} has no generated private reply`);
    if (current.privateDelivery.sent) return;
    this.append({
      state: 'private_send_ack',
      updateId: id,
      recordedAt: new Date().toISOString(),
      sendResult,
    });
    current.privateDelivery.sent = true;
    current.privateDelivery.sendResult = sendResult;
  }

  beginOperation(updateId, name, payload = {}) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.update || current.state !== 'received') throw new Error(`update ${id} is not in an executable state`);
    if (current.operation) {
      if (current.operation.name !== String(name)) throw new Error(`update ${id} operation name conflict`);
      return structuredClone(current.operation);
    }
    const event = {
      state: 'operation_intent',
      updateId: id,
      recordedAt: new Date().toISOString(),
      name: String(name),
      payload,
    };
    this.append(event);
    current.operation = { name: event.name, payload, status: 'intent', result: null };
    return structuredClone(current.operation);
  }

  completeOperation(updateId, result = {}) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.operation) throw new Error(`update ${id} has no operation intent`);
    if (current.operation.status === 'result') return structuredClone(current.operation);
    const event = {
      state: 'operation_result',
      updateId: id,
      recordedAt: new Date().toISOString(),
      result,
    };
    this.append(event);
    current.operation.status = 'result';
    current.operation.result = result;
    return structuredClone(current.operation);
  }

  operation(updateId) {
    const operation = this.records.get(Number(updateId))?.operation;
    return operation ? structuredClone(operation) : null;
  }

  updateState(updateId) {
    return this.records.get(Number(updateId))?.state || null;
  }

  markDone(updateId) {
    const id = Number(updateId);
    if (this.records.get(id)?.state === 'done') return;
    const groupBatch = this.groupBatchForUpdate(id);
    // GroupConversationBatcher settles every message in an active batch
    // together. Commit the whole membership in one fsync event so a crash
    // cannot leave a half-done batch that can neither replay nor progress.
    if (groupBatch?.state === 'active') {
      this.markGroupBatchDone(groupBatch.batchId);
      return;
    }
    this.append({ state: 'done', updateId: id, recordedAt: new Date().toISOString() });
    this.markDoneInMemory(id);
    this.trimDoneIndex();
    this.compactIfNeeded();
  }

  markGroupBatch({ batchId, chatId, updateIds, preparedMessages }) {
    const id = String(batchId || '');
    const ids = [...new Set(
      (updateIds || []).map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0),
    )];
    if (!id || !ids.length || !Array.isArray(preparedMessages) || preparedMessages.length !== ids.length) {
      throw new Error('invalid durable group batch arguments');
    }

    const existing = this.groupBatches.get(id);
    if (existing?.state === 'active') return id;

    const supersededBatchIds = new Set();
    for (const updateId of ids) {
      const previousBatchId = this.updateToGroupBatch.get(updateId);
      if (previousBatchId && previousBatchId !== id) supersededBatchIds.add(previousBatchId);
    }
    for (const previousBatchId of supersededBatchIds) {
      this.append({
        state: 'group_superseded',
        batchId: previousBatchId,
        supersededBy: id,
        recordedAt: new Date().toISOString(),
      });
      this.applyGroupBatchEvent({ state: 'group_superseded', batchId: previousBatchId });
    }

    const event = {
      state: 'group_batch',
      batchId: id,
      chatId: String(chatId || ''),
      updateIds: ids,
      preparedMessages,
      recordedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
    return id;
  }

  markGroupBatchReplies(batchId, replies, threadId) {
    const id = String(batchId || '');
    const record = this.groupBatches.get(id);
    if (!record || record.state !== 'active') throw new Error(`group batch ${id} is not active`);
    const event = {
      state: 'group_replies',
      batchId: id,
      recordedAt: new Date().toISOString(),
      replies: Array.isArray(replies) ? replies : [],
      threadId: threadId ? String(threadId) : null,
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
  }

  markGroupReplyAck(batchId, replyIndex) {
    const id = String(batchId || '');
    const index = Number(replyIndex);
    const record = this.groupBatches.get(id);
    if (!record || record.state !== 'active' || !Number.isInteger(index) || index < 0) {
      throw new Error(`group batch ${id} reply ack is invalid`);
    }
    if (record.ackedReplyIndexes.has(index)) return;
    const event = {
      state: 'group_reply_ack',
      batchId: id,
      replyIndex: index,
      recordedAt: new Date().toISOString(),
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
  }

  isGroupReplyAcked(batchId, replyIndex) {
    return this.groupBatches.get(String(batchId || ''))?.ackedReplyIndexes.has(Number(replyIndex)) === true;
  }

  groupBatchForUpdate(updateId) {
    const batchId = this.updateToGroupBatch.get(Number(updateId));
    if (!batchId) return null;
    const record = this.groupBatches.get(batchId);
    return record && (record.state === 'active' || record.state === 'dead') ? record : null;
  }

  pendingGroupBatches(now = Date.now()) {
    const pending = [...this.groupBatches.values()]
      .filter((record) => record.state === 'active')
      .filter((record) => record.updateIds.every((updateId) => this.records.get(updateId)?.state === 'received'))
      .sort((left, right) => Math.min(...left.updateIds) - Math.min(...right.updateIds));
    const record = pending[0];
    if (!record || Number(record.nextAttemptAt || 0) > now) return [];
    const earliestReceivedUpdateId = Math.min(
      ...[...this.records.entries()]
        .filter(([, entry]) => entry.state === 'received' && entry.update)
        .map(([updateId]) => updateId),
    );
    if (Math.min(...record.updateIds) !== earliestReceivedUpdateId) return [];
    return [{
      ...record,
      updateIds: [...record.updateIds],
      preparedMessages: structuredClone(record.preparedMessages),
      replies: record.replies == null ? null : structuredClone(record.replies),
      ackedReplyIndexes: new Set(record.ackedReplyIndexes),
    }];
  }

  markGroupBatchRetry(batchId, error, {
    maxAttempts = 12,
    baseDelayMs = 3000,
    maxDelayMs = 5 * 60 * 1000,
  } = {}) {
    const id = String(batchId || '');
    const record = this.groupBatches.get(id);
    if (!record || record.state !== 'active') throw new Error(`group batch ${id} is not in a retryable state`);
    if (Number(record.nextAttemptAt || 0) > Date.now()) {
      return {
        dead: false,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        alreadyScheduled: true,
      };
    }

    const attempts = Number(record.attempts || 0) + 1;
    const lastError = String(error || 'unknown').slice(0, 500);
    if (attempts >= maxAttempts) {
      const event = {
        state: 'group_dead',
        batchId: id,
        recordedAt: new Date().toISOString(),
        attempts,
        lastError,
      };
      this.append(event);
      this.applyGroupBatchEvent(event);
      this.compactIfNeeded();
      return { dead: true, attempts, nextAttemptAt: null, alreadyScheduled: false };
    }

    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempts - 1)));
    const nextAttemptAt = Date.now() + delayMs;
    const event = {
      state: 'group_retry',
      batchId: id,
      recordedAt: new Date().toISOString(),
      attempts,
      nextAttemptAt,
      lastError,
    };
    this.append(event);
    this.applyGroupBatchEvent(event);
    for (const updateId of record.updateIds) {
      const current = this.records.get(updateId);
      if (current?.state === 'received') {
        this.records.set(updateId, { ...current, attempts, nextAttemptAt, lastError });
      }
    }
    this.compactIfNeeded();
    return { dead: false, attempts, nextAttemptAt, alreadyScheduled: false };
  }

  markGroupBatchDone(batchId) {
    const id = String(batchId || '');
    const record = this.groupBatches.get(id);
    if (!record || record.state === 'done') return;
    if (record.state !== 'active') throw new Error(`group batch ${id} is not active`);
    const event = { state: 'group_done', batchId: id, recordedAt: new Date().toISOString() };
    this.append(event);
    this.applyGroupBatchEvent(event);
    this.trimDoneIndex();
    this.compactIfNeeded();
  }

  markRetry(updateId, error, {
    maxAttempts = 12,
    baseDelayMs = 3000,
    maxDelayMs = 5 * 60 * 1000,
  } = {}) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (!current?.update || current.state !== 'received') {
      throw new Error(`update ${id} is not in a retryable state`);
    }
    const attempts = Number(current.attempts || 0) + 1;
    const lastError = String(error || 'unknown').slice(0, 500);
    if (attempts >= maxAttempts) {
      const event = {
        state: 'dead',
        updateId: id,
        recordedAt: new Date().toISOString(),
        attempts,
        lastError,
        update: current.update,
      };
      this.append(event);
      this.records.set(id, { ...current, state: 'dead', attempts, lastError });
      this.compactIfNeeded();
      return { dead: true, attempts, nextAttemptAt: null };
    }
    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempts - 1)));
    const nextAttemptAt = Date.now() + delayMs;
    this.append({
      state: 'retry',
      updateId: id,
      recordedAt: new Date().toISOString(),
      attempts,
      nextAttemptAt,
      lastError,
    });
    this.records.set(id, { ...current, state: 'received', attempts, nextAttemptAt, lastError });
    this.compactIfNeeded();
    return { dead: false, attempts, nextAttemptAt };
  }

  pendingUpdates(now = Date.now()) {
    const pending = [...this.records.entries()]
      .filter(([, record]) => record.state === 'received' && record.update)
      .sort(([left], [right]) => left - right);
    const due = [];
    for (const [updateId, record] of pending) {
      // An active exact group batch owns this update. Stop rather than skipping
      // it so a later Telegram update cannot leap over a delayed batch replay.
      if (this.updateToGroupBatch.has(updateId)) break;
      // Preserve Telegram update order across retry backoff. A later update must
      // not leap over an earlier one that has not reached its retry deadline.
      if (Number(record.nextAttemptAt || 0) > now) break;
      due.push(record.update);
    }
    return due;
  }

  deadUpdates() {
    return [...this.records.entries()]
      .filter(([, record]) => record.state === 'dead')
      .sort(([left], [right]) => left - right)
      .map(([updateId, record]) => ({ updateId, attempts: record.attempts, lastError: record.lastError }));
  }

  requeueDead(updateId) {
    const id = Number(updateId);
    const current = this.records.get(id);
    if (current?.state !== 'dead' || !current.update) return false;
    const deadGroupBatch = [...this.groupBatches.values()].find(
      (record) => record.state === 'dead' && record.updateIds.includes(id),
    );
    if (deadGroupBatch) {
      const event = {
        state: 'group_requeue',
        batchId: deadGroupBatch.batchId,
        recordedAt: new Date().toISOString(),
      };
      this.append(event);
      this.applyGroupBatchEvent(event);
      return true;
    }
    const event = {
      state: 'received',
      updateId: id,
      recordedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      update: current.update,
    };
    this.append(event);
    this.records.set(id, {
      ...current,
      state: 'received',
      update: current.update,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    });
    return true;
  }

  stats(now = Date.now()) {
    let pending = 0;
    let delayed = 0;
    let dead = 0;
    for (const record of this.records.values()) {
      if (record.state === 'received') {
        pending += 1;
        if (Number(record.nextAttemptAt || 0) > now) delayed += 1;
      } else if (record.state === 'dead') {
        dead += 1;
      }
    }
    return { pending, delayed, dead };
  }

  trimDoneIndex() {
    while (this.doneOrder.length > this.keepDone) {
      const id = this.doneOrder.shift();
      if (this.records.get(id)?.state === 'done') this.records.delete(id);
    }
  }

  compactIfNeeded(force = false) {
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch { return; }
    if (!force && size < this.compactBytes) return;
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const lines = [];
    for (const [updateId, record] of [...this.records.entries()].sort(([a], [b]) => a - b)) {
      let event;
      if (record.state === 'received') {
        event = {
          state: 'received',
          updateId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          nextAttemptAt: record.nextAttemptAt || 0,
          lastError: record.lastError || null,
          update: record.update,
        };
      } else if (record.state === 'dead') {
        event = {
          state: 'dead',
          updateId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          lastError: record.lastError || null,
          update: record.update,
        };
      } else {
        event = { state: 'done', updateId, recordedAt: new Date().toISOString() };
      }
      lines.push(JSON.stringify(event));
      if (record.privateDelivery && record.state !== 'done') {
        lines.push(JSON.stringify({
          state: 'private_generated',
          updateId,
          recordedAt: new Date().toISOString(),
          reply: record.privateDelivery.reply,
          threadId: record.privateDelivery.threadId || null,
          chatId: record.privateDelivery.chatId,
        }));
        if (record.privateDelivery.sent) {
          lines.push(JSON.stringify({
            state: 'private_send_ack',
            updateId,
            recordedAt: new Date().toISOString(),
            sendResult: record.privateDelivery.sendResult || null,
          }));
        }
      }
      if (record.operation && record.state !== 'done') {
        lines.push(JSON.stringify({
          state: 'operation_intent',
          updateId,
          recordedAt: new Date().toISOString(),
          name: record.operation.name,
          payload: record.operation.payload || {},
        }));
        if (record.operation.status === 'result') {
          lines.push(JSON.stringify({
            state: 'operation_result',
            updateId,
            recordedAt: new Date().toISOString(),
            result: record.operation.result || {},
          }));
        }
      }
    }
    for (const record of [...this.groupBatches.values()]
      .filter((entry) => entry.state === 'active' || entry.state === 'dead')
      .sort((left, right) => Math.min(...left.updateIds) - Math.min(...right.updateIds))) {
      lines.push(JSON.stringify({
        state: 'group_batch',
        batchId: record.batchId,
        chatId: record.chatId,
        updateIds: record.updateIds,
        preparedMessages: record.preparedMessages,
        recordedAt: new Date().toISOString(),
        attempts: record.attempts || 0,
        nextAttemptAt: record.nextAttemptAt || 0,
        lastError: record.lastError || null,
      }));
      if (record.replies != null) {
        lines.push(JSON.stringify({
          state: 'group_replies',
          batchId: record.batchId,
          recordedAt: new Date().toISOString(),
          replies: record.replies,
          threadId: record.threadId || null,
        }));
      }
      for (const replyIndex of [...record.ackedReplyIndexes].sort((a, b) => a - b)) {
        lines.push(JSON.stringify({
          state: 'group_reply_ack',
          batchId: record.batchId,
          replyIndex,
          recordedAt: new Date().toISOString(),
        }));
      }
      if (record.state === 'dead') {
        lines.push(JSON.stringify({
          state: 'group_dead',
          batchId: record.batchId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          lastError: record.lastError || null,
        }));
      } else if (record.attempts || record.nextAttemptAt || record.lastError) {
        lines.push(JSON.stringify({
          state: 'group_retry',
          batchId: record.batchId,
          recordedAt: new Date().toISOString(),
          attempts: record.attempts || 0,
          nextAttemptAt: record.nextAttemptAt || 0,
          lastError: record.lastError || null,
        }));
      }
    }
    fs.writeFileSync(tmp, `${lines.join('\n')}${lines.length ? '\n' : ''}`, { encoding: 'utf8', mode: 0o600 });
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    fsyncDirectory(path.dirname(this.filePath));
  }
}

export async function deliverDurablePrivateReply({
  inbox,
  updateId,
  chatId,
  generate,
  send,
  onReplay = () => {},
}) {
  let delivery = inbox.privateDelivery(updateId);
  let generatedNow = false;
  if (!delivery) {
    const generated = await generate();
    delivery = inbox.markPrivateGenerated(updateId, {
      reply: generated.reply,
      threadId: generated.threadId,
      chatId,
    });
    generatedNow = true;
  } else {
    onReplay(delivery);
  }

  if (delivery.sent) {
    return { delivery, generatedNow, sentNow: false };
  }
  const sendResult = await send(delivery.reply);
  inbox.markPrivateSendAck(updateId, sendResult || null);
  return {
    delivery: inbox.privateDelivery(updateId),
    generatedNow,
    sentNow: true,
  };
}
