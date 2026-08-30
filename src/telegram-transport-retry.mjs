// Telegram 调用的传输层重试（2026-08-15 全家 TG 桥体检加入）
//
// 起因：同一天the bot那边 Kimi 已经把回复写好了，一次 sendMessage 超时，整轮被判失败，
// 用户手机上什么都没收到，而那段话就明晃晃地留在终端里。本桥用的是同一套 fetch，
// 同一天记了 52 次轮询失败。
//
// 这些桥底下的网络是成片抖的（2026-08-15 的失败集中在 12/14/15/21 UTC 三个波峰）。
// Syner 用完全相同的 undici fetch 却零失败，唯一的区别就是它在传输层重试。
// 这里就是那一层，单独抽出来好写测试。
//
// 只吸收"话根本没送出去"这类故障。Telegram 给的真实回答（chat not found、
// bad request）必须立刻冒上去，不许拿重试盖住。429 带 retry_after，归上游限流器管，
// 在这里盲目重试只会让限流更糟。

const RETRYABLE_TRANSPORT = new RegExp([
  'fetch failed',
  'aborted',
  'timeout',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'socket hang up',
  'other side closed',
  'terminated',
].join('|'), 'i');

export function isRetryableTransportError(error) {
  if (!error) return false;
  const status = Number(error.status) || 0;
  if (status === 429) return false;      // 限流器的活，需要 retry_after
  if (status >= 500) return true;        // Telegram 自己在晃
  if (status >= 400) return false;       // 真实回答：不许盖住
  return RETRYABLE_TRANSPORT.test(String(error.message || ''));
}

export async function withTransportRetry(call, {
  maxAttempts = 4,
  baseDelayMs = 500,
  maxDelayMs = 5000,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  onRetry = null,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await call(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableTransportError(error) || attempt === maxAttempts) throw error;
      const delayMs = Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs);
      if (typeof onRetry === 'function') onRetry({ attempt, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
