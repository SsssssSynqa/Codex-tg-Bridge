// the session的上下文水位读取（2026-08-16）。
//
// 数据源是 Codex 自己写进 rollout 的 `event_msg/token_count`：
//   info.last_token_usage.input_tokens  = 这一轮实际喂进去多少
//   info.model_context_window           = 窗口大小（当前 258,400）
// 这是引擎自己记的账，不是估算，跟他在别处看到的数字不会打架。
//
// rollout 是 append-only 且能长到上百 MB（实测可达上百 MB），所以从**文件尾部**
// 倒着读块、按行找最后一条 token_count，绝不整文件读进内存。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const TAIL_CHUNK = 256 * 1024;
const MAX_TAIL_SCAN = 8 * 1024 * 1024; // 再往前翻就说明这个 rollout 不正常了

/** 在 ~/.codex/sessions/YYYY/MM/DD/ 里找 thread 对应的 rollout。 */
export function findRollout(threadId, { root = SESSIONS_ROOT } = {}) {
  if (!threadId) return null;
  const suffix = `-${threadId}.jsonl`;
  const stack = [root];
  const hits = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) hits.push(full);
    }
  }
  if (!hits.length) return null;
  // 同一个 thread id 理论上只有一个 rollout；真撞上就取最近改动的那个
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

/** 从尾部倒着读，返回最后 `wanted` 个完整行（顺序仍是文件顺序）。 */
function tailLines(file, wanted = 400) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    let position = size;
    let buffered = '';
    let scanned = 0;
    while (position > 0 && scanned < MAX_TAIL_SCAN) {
      const length = Math.min(TAIL_CHUNK, position);
      position -= length;
      scanned += length;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, position);
      buffered = buffer.toString('utf8') + buffered;
      const lines = buffered.split('\n');
      // 首行可能被块边界截断，position>0 时不算数
      const complete = position > 0 ? lines.slice(1) : lines;
      if (complete.filter(Boolean).length >= wanted) {
        return complete.filter(Boolean).slice(-wanted);
      }
    }
    return buffered.split('\n').filter(Boolean).slice(-wanted);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读一个 thread 的当前水位。
 * @returns {{used:number, window:number, percent:number, rollout:string, compactions:number}|null}
 */
export function readContextUsage(threadId, options = {}) {
  const rollout = options.rollout || findRollout(threadId, options);
  if (!rollout || !fs.existsSync(rollout)) return null;

  let used = null;
  let window = null;
  // 倒着扫：一旦先撞上 compacted，说明再往前的 token_count 记的是**压缩之前**的
  // 上下文，拿它当水位就是读旧账。
  // 2026-08-16 第一次真跑 /refine 时踩到：精炼把 175k 降到 96k，但 rollout 末尾
  // 还没有新的 token_count，巡检读到精炼前的 213k，当场给用户误报了一次 75%。
  // Codex 自己自动压缩后也有同样的窗口期（压缩那一拍记的是 0，会被跳过）。
  let stale = false;
  for (const line of tailLines(rollout, options.tailLines || 400).reverse()) {
    if (line.includes('"type":"compacted"')) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === 'compacted') { stale = true; break; }
      continue;
    }
    if (!line.includes('token_count')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const info = record?.payload?.info;
    if (record?.payload?.type !== 'token_count' || !info) continue;
    const last = info.last_token_usage || {};
    if (!last.input_tokens) continue; // 压缩那一拍自己记的是 0，跳过
    used = last.input_tokens;
    window = info.model_context_window || null;
    break;
  }
  // 仍然带上 rollout —— /refine 和 /handoff 靠它定位文件，不能因为读数过期就拿不到路径
  if (stale) return { stale: true, rollout };
  if (used == null) return null;

  const total = window || 258_400;
  return {
    used,
    window: total,
    percent: Math.round((used / total) * 1000) / 10,
    rollout,
  };
}

export function formatUsage(usage) {
  if (usage?.stale) return '刚压缩过，还没说话——等他下一轮回复才会有新的读数。';
  if (!usage) return '读不到水位（rollout 里还没有 token_count）';
  const filled = Math.round(usage.percent / 5);
  const bar = '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, 20 - filled));
  const k = (n) => `${(n / 1000).toFixed(1)}k`;
  return `${bar} ${usage.percent}%\n${k(usage.used)} / ${k(usage.window)}`;
}
