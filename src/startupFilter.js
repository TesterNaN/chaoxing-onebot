'use strict';
/**
 * 「只处理启动后的事件」过滤器
 *
 * 为什么需要：SDK 在每次连接时会把离线期间的消息补发一遍（`onOfflineMessageSyncStart`
 * → `onOfflineMessageSyncFinish`，官方类型里有定义）。补发的都是**启动前**的旧消息，
 * 如果照常上报，框架（AI 机器人）会当成新消息**再回复一次**——实测就是这样：
 * 对方半小时前问过的话，机器人重启后又答一遍。
 *
 * 判定用两个信号，任一命中即视为"启动前"：
 *
 *   1. **处于离线补发窗口内**（syncing）——这是补发的直接特征，也是**群事件唯一可用**的信号
 *      （群事件不带时间戳，无法按时间判断）
 *   2. **消息时间戳早于「进程启动时刻 - 宽限」**——兜底，防补发窗口之外漏网的旧消息
 *
 * 宽限（graceMs）用于吸收服务器与本机的时钟偏差：宁可多放行几秒内的消息，
 * 也不要误杀刚发生的新消息。
 */
function makeStartupFilter(opts = {}) {
  const enabled = opts.enabled !== false;
  const startedAt = Number(opts.startedAt) || Date.now();
  const graceMs = Number.isFinite(Number(opts.graceMs)) ? Number(opts.graceMs) : 10000;

  return {
    enabled,
    startedAt,
    graceMs,
    /**
     * @param {{ts?:number, syncing?:boolean}} p
     * @returns {boolean} true = 启动前的事件，应当略过
     */
    isPreStartup(p = {}) {
      if (!enabled) return false;
      if (p.syncing) return true;                 // 补发窗口内 → 一定是旧的
      const ts = Number(p.ts);
      if (!ts || !Number.isFinite(ts)) return false;   // 没有时间戳 → 不敢丢，放行
      return ts < startedAt - graceMs;
    },
  };
}

module.exports = { makeStartupFilter };
