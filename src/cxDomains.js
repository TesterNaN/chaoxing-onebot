'use strict';
/**
 * 运行时域名表（domainMap）
 *
 * 为什么需要它：学习通有几类富内容（话题/笔记/小组/通知/笔记本/两种文件夹）的附件体里
 * **只有 id，没有地址** —— 客户端是拿「域名 + id」现拼的，域名来自服务端的 `mirrorConfig`。
 * 详见 web 端附件组件 `_webim_plugins/attachment.js` 里对应的 case。
 *
 * 实测（2026-09，带 cookie）：
 *   GET https://fe.chaoxing.com/proxy/apis/mirrorConfig
 *   → {"result":1,"data":{"domainMap":{…170 个域名…}}}
 *   domainMap.GroupWebDomainHttps = "https://groupweb.chaoxing.com"
 *   domainMap.NoteDomainHttps     = "https://noteyd.chaoxing.com"
 *   domainMap.NoticeDomainHttps   = "https://notice.chaoxing.com"
 *
 * ⚠️ 只在 `fe.chaoxing.com` 这个 host 上取到；learn / im / mooc1 上的同路径都是 404（实测）。
 * 取不到时**不影响任何功能**：相关附件照旧退回 `[中文名]标题` 文本兜底。
 */

/** 实际使用的三个域名（需要更多时在此追加） */
const DOMAIN_KEYS = ['GroupWebDomainHttps', 'NoteDomainHttps', 'NoticeDomainHttps'];

const MIRROR_CONFIG_URL = 'https://fe.chaoxing.com/proxy/apis/mirrorConfig';

/**
 * 从 mirrorConfig 的响应里挑出所需域名（纯函数，便于单测）
 * @param {any} json 接口原文
 * @returns {{GroupWebDomainHttps?:string, NoteDomainHttps?:string, NoticeDomainHttps?:string}|null}
 */
function pickDomains(json) {
  const dm = json && json.data && json.data.domainMap;
  if (!dm || typeof dm !== 'object') return null;
  const out = {};
  let n = 0;
  for (const k of DOMAIN_KEYS) {
    const v = dm[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) { out[k] = v.replace(/\/+$/, ''); n++; }
  }
  return n ? out : null;
}

/**
 * 取域名表。**失败一律返回 null，不抛** —— 它只是"锦上添花"，不该拖垮启动。
 * @param {{cookie?:string, timeoutMs?:number, fetchImpl?:Function}} [opts]
 * @returns {Promise<object|null>}
 */
async function fetchDomainMap(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const timeoutMs = Number(opts.timeoutMs) || 10000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await doFetch(`${MIRROR_CONFIG_URL}?_t=${Date.now()}`, {
      headers: {
        cookie: opts.cookie || '',
        accept: 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        referer: 'https://fe.chaoxing.com/',
      },
      signal: ac.signal,
    });
    if (!r || !r.ok) return null;
    const j = JSON.parse(await r.text());
    return pickDomains(j);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DOMAIN_KEYS, MIRROR_CONFIG_URL, pickDomains, fetchDomainMap };
