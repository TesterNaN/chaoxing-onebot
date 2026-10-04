'use strict';
/**
 * 消息去重表（LRU + 长 TTL）
 *
 * 为什么需要：环信 SDK 在断线重连后会走离线消息同步（onOfflineMessageSyncFinish）
 * 把离线期间的消息补发一遍，而实时链路可能已经投递过其中一部分；同一账号多端登录时
 * 也会各推一份。没有去重的话，上层（AI 回复 / OneBot 事件）会对同一条消息处理多次。
 *
 * 键的选择：接收消息对象上的 id 来自服务端下发（SDK 内部 `B = e.msgId`），同一条消息
 * 在实时推送与离线补发中保持一致，因此可以安全去重；发送路径上的 id 才是本地生成值，
 * 那条路径不走这里。
 *
 * TTL 取较长值（默认 6 小时）：离线补发可能滞后很久，窗口太短会漏掉重复。
 * 容量上限兜底，防止长时间运行内存无界增长。
 */
class DedupCache {
  /**
   * @param {{maxSize?:number, ttlMs?:number}} [opts]
   */
  constructor({ maxSize = 5000, ttlMs = 6 * 3600 * 1000 } = {}) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this._map = new Map();   // key -> 时间戳（Map 保持插入序，天然 LRU 序）
    this.hits = 0;           // 判定为重复的次数
    this.misses = 0;         // 首次见到
    this.evicted = 0;        // 因容量/TTL 淘汰
  }

  /**
   * 记录并判断：首次出现返回 false，重复返回 true。
   * @param {string} key
   * @returns {boolean} 是否重复
   */
  check(key) {
    if (!key) return false;           // 无键 → 不去重（宁可重复也不误丢）
    const now = Date.now();
    const prev = this._map.get(key);
    if (prev !== undefined && now - prev < this.ttlMs) {
      // 命中：刷新位置到队尾，避免热点消息被容量淘汰后再次判定为新消息
      this._map.delete(key);
      this._map.set(key, now);
      this.hits++;
      return true;
    }
    this._map.set(key, now);
    this.misses++;
    this._trim(now);
    return false;
  }

  /** 仅标记为已见（不参与重复判定），用于本适配器发出的消息 */
  mark(key) {
    if (!key) return;
    this._map.set(key, Date.now());
    this._trim(Date.now());
  }

  _trim(now) {
    // 1) 先按 TTL 从队首（最旧）清理
    for (const [k, t] of this._map) {
      if (now - t < this.ttlMs) break;
      this._map.delete(k);
      this.evicted++;
    }
    // 2) 再按容量从队首淘汰
    while (this._map.size > this.maxSize) {
      const k = this._map.keys().next().value;
      this._map.delete(k);
      this.evicted++;
    }
  }

  clear() { this._map.clear(); }

  get size() { return this._map.size; }

  stats() {
    return { size: this._map.size, maxSize: this.maxSize, ttlMs: this.ttlMs, hits: this.hits, misses: this.misses, evicted: this.evicted };
  }
}

module.exports = { DedupCache };
