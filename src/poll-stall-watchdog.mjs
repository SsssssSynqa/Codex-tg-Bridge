// Telegram 轮询静默卡死看门狗（2026-08-15 全家 TG 桥体检加入）
//
// 病象：桥进程活着、日志干净、launchd 认为一切正常，但 Telegram 那边根本没人
// 在长轮询 —— 用户发的消息石沉大海。排查当天桥的日志停在 13:47，之后近一
// 小时零网络流量，getUpdates 探测打过去它毫无反应。
//
// 机制：undici 的 keep-alive 连接池在一次 AbortSignal 超时之后会留下坏 socket，
// 下一个 fetch 既不返回、也不 reject、也不再触发 abort，await 就永远挂在那里。
// launchd 的 KeepAlive 只认进程退出，对"活着但聋了"完全无效。
//
// 只盯 getUpdates 那一段（beginPoll → endPoll）。生成回复走的是同一个 for 循环、
// 轮询本来就停着，那段必须完全不管 —— 在用户等回复的时候把桥杀掉，比聋着还糟。

export const DEFAULT_STALL_MS = 90_000; // fetch 自带 40s abort；90s 还没回来 = 连接池已坏
export const DEFAULT_CHECK_MS = 15_000;

export function createPollStallWatchdog({
  stallMs = DEFAULT_STALL_MS,
  checkMs = DEFAULT_CHECK_MS,
  now = () => Date.now(),
  onStall,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof onStall !== 'function') throw new Error('轮询看门狗需要 onStall 回调');

  let pollStartedAt = 0; // 0 = 当前不在 getUpdates 里，看门狗闭嘴
  let timer = null;

  return {
    beginPoll() {
      pollStartedAt = now();
    },
    endPoll() {
      pollStartedAt = 0;
    },
    start() {
      if (timer) return;
      // 检查间隔不能超过阈值本身，否则阈值形同虚设
      const everyMs = Math.max(1000, Math.min(checkMs, stallMs));
      timer = setIntervalFn(() => {
        if (!pollStartedAt) return;
        const stuckMs = now() - pollStartedAt;
        if (stuckMs < stallMs) return;
        // 先清零再回调：同一次挂起只报一次，交给宿主决定怎么死
        pollStartedAt = 0;
        onStall(stuckMs);
      }, everyMs);
      timer?.unref?.();
    },
    stop() {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
    },
  };
}
