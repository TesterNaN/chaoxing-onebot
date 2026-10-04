'use strict';
/**
 * 群名片（v11 `contact` 段 `type=group`）→ 学习通的 `att_chat_group`（attachmentType 23）
 *
 * 两条**只读** HTTP 接口，都不需要 tokenSign，也不改动任何群设置：
 *
 *   1) 邀请码 —— GET {learn}/im/addcg?cgid=<群id>
 *      这是「加入群聊」的落地页。服务端会把该群**当前有效的邀请码**渲染进页面 JS：
 *
 *          var inviteCode = "xxxx0001";     ← 有码
 *          var inviteCode = "";             ← 没有码（未开启，或 30 天有效期已过）
 *
 *      实测免登录可读（不带 cookie 返回同一个码），且**有码/没码两份页面除这一行外完全一致**
 *      —— 所以解析它同时拿到「码」和「有没有码」，这是全流程唯一的判据。
 *      （不要去调 createChatGroupIncode：它是写接口，语义是"开启邀请码"。）
 *
 *   2) 群名 + 头像 —— GET {im}/webim/huanxin/getGroupInfo?roomId=<群id>
 *      → [{"owner":"…","name":"…","members_count":N,"id":…,"pics":["…"]}]
 *      `pics` 就是名片要的 `listPic`（官方最多放 4 个）。
 *
 *   3) 邀请码是否**有效** —— IM SDK 的 `getGroupInfo` → `description`（JSON 串）里的 `showQRCode`
 *      （HTTP 那个 getGroupInfo 不返回 description，所以这一步必须走 IM）
 *
 * ⚠️ 为什么"读得到码"不能当判据：关闭邀请码时客户端只把码的 `expireTime` 置成 1000
 *    （1970-01-01，一个绝对时间戳的过去值）并把 `showQRCode` 广播成 0，
 *    **码字符串仍留在服务端**，addcg 照样渲染出来。实测群 324000000000003：
 *    description = {"showQRCode":0}，但 addcg 依然返回 xxxx0002 —— 那个码已经不能用了。
 *    所以流程是：addcg 取"码的值"，showQRCode 判"码能不能用"，两者都满足才发。
 */
const https = require('https');
const zlib = require('zlib');

const DEFAULT_LEARN_BASE = 'https://learn.chaoxing.com';
const DEFAULT_IM_BASE = 'https://im.chaoxing.com';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_LIST_PIC = 4;                 // 官方渲染按 4 张拼头像九宫格
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** 取文本响应（cxProfile 那个只解析 JSON，落地页是 HTML，所以单独一个） */
function defaultFetchText(url, { cookie, timeoutMs, base } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/json,text/plain,*/*',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: cookie || '',
        referer: `${base || u.origin}/`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch { /* 保持原样 */ }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(buf.toString('utf8'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

const unescapeHtml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * 解析 addcg 落地页（纯函数，便于单测）
 * @returns {{inviteCode:string, cgid:string, groupName:string, memberCount:number}}
 */
function parseAddcgPage(html) {
  const s = String(html || '');
  const pick = (re) => { const m = s.match(re); return m ? m[1] : ''; };
  return {
    // 这是「有没有邀请码」的唯一判据：没码时服务端渲染的是空串
    inviteCode: pick(/var\s+inviteCode\s*=\s*"([^"]*)"/),
    cgid: pick(/var\s+cgid\s*=\s*"([^"]*)"/) || pick(/id="groupid"\s+value="([^"]*)"/),
    groupName: unescapeHtml(pick(/<h3>([^<]*)<\/h3>/)).trim(),
    memberCount: Number((pick(/<p>\s*(\d+)\s*人\s*<\/p>/) || '0')) || 0,
  };
}

/** listPic 归一化：官方只放最多 4 个；容错字符串/空/null（纯函数） */
function normalizeListPic(pics) {
  let arr = [];
  if (Array.isArray(pics)) arr = pics;
  else if (typeof pics === 'string' && pics) arr = [pics];   // 班级/课程群可能直接给一个 logo
  return arr.filter((x) => typeof x === 'string' && x).slice(0, MAX_LIST_PIC);
}

/** 构造附件体（纯函数） */
function buildAttachment({ groupId, groupName, inviteCode, listPic }) {
  return {
    attachmentType: 23,
    att_chat_group: {
      groupId: String(groupId == null ? '' : groupId),
      groupName: String(groupName || ''),
      inviteCode: String(inviteCode || ''),
      listPic: normalizeListPic(listPic),
    },
  };
}

/**
 * 解析群详情 `description` 里的 `showQRCode`（纯函数）—— **这才是"邀请码是否有效"的判据**。
 *
 * 为什么不能拿 addcg 读到的码当判据：关闭邀请码时客户端只做两件事
 * （把码的 `expireTime` 置成 1000，再把 `showQRCode` 广播成 0），**码字符串仍留在服务端**，
 * addcg 照样把它渲染出来。实测：群 324000000000003 的 description 是 {"showQRCode":0}，
 * 但 addcg 依然返回 xxxx0002 —— 那个码已经不能用了。
 *
 * description 不是 JSON、或没有 showQRCode 字段，都按「未启用」处理（拿不到"开着"的证据就不发）。
 * @returns {{ok:boolean, present:boolean, value:*, rawText:string}}
 */
function parseShowQRCode(description) {
  let j = null;
  try { j = JSON.parse(String(description == null ? '' : description)); } catch { j = null; }
  const present = !!(j && typeof j === 'object' && 'showQRCode' in j);
  const value = present ? j.showQRCode : undefined;
  const rawText = present ? JSON.stringify(value) : (String(description || '') ? '字段缺失' : 'description 为空');
  return { ok: Number(value) === 1, present, value, rawText };
}

/**
 * @param {object} opts
 * @param {string} [opts.cookie]      与适配器其它请求同一份 cookie（getGroupInfo 用；addcg 不需要）
 * @param {string} [opts.learnBase]   默认 https://learn.chaoxing.com
 * @param {string} [opts.imBase]      默认 https://im.chaoxing.com
 * @param {number} [opts.timeoutMs]   默认 8000
 * @param {Function} [opts.fetchText] 注入用（单测）
 * @param {Function} [opts.fetchGroupDescription] 取群详情 `description` 字符串（**必传**才做有效性判定）。
 *        只有 IM SDK 的 `getGroupInfo` 能读到它，HTTP 的 `webim/huanxin/getGroupInfo` 不返回。
 *        返回 null/undefined 视为"读不到"，会拒绝发送（不发可能已失效的码）。
 */
function createGroupCardResolver(opts = {}) {
  const cookie = opts.cookie || '';
  const learnBase = opts.learnBase || DEFAULT_LEARN_BASE;
  const imBase = opts.imBase || DEFAULT_IM_BASE;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchText = opts.fetchText || defaultFetchText;
  const fetchGroupDescription = opts.fetchGroupDescription || null;

  // 不做缓存：发群名片不是热路径，宁可可每次现取（群里一改邀请码/开关，缓存就会发旧状态）
  const stats = { incodeReq: 0, groupReq: 0, incodeFail: 0, groupFail: 0, noIncode: 0, disabled: 0, detailFail: 0 };

  async function incodeOf(gid) {
    const url = `${learnBase}/im/addcg?cgid=${encodeURIComponent(gid)}`;
    stats.incodeReq++;
    try {
      const html = await fetchText(url, { cookie, timeoutMs, base: learnBase });
      return parseAddcgPage(html);
    } catch (e) {
      stats.incodeFail++;
      throw e;
    }
  }

  async function groupInfoOf(gid) {
    const url = `${imBase}/webim/huanxin/getGroupInfo?roomId=${encodeURIComponent(gid)}`;
    stats.groupReq++;
    try {
      const text = await fetchText(url, { cookie, timeoutMs, base: imBase });
      const d = JSON.parse(text);
      return Array.isArray(d) ? (d[0] || null) : d;
    } catch (e) {
      stats.groupFail++;
      return null;      // 群名/头像拿不到不算致命，后面有落地页的兜底
    }
  }

  /**
   * 解析出一张可发的群名片
   * @returns {Promise<{ok:true, attachment:object, groupName:string, inviteCode:string}
   *                  | {ok:false, error:string}>}
   */
  async function resolve(gid) {
    const id = String(gid == null ? '' : gid).trim();
    if (!id) return { ok: false, error: 'contact 段缺少 id 字段' };

    let page;
    try {
      page = await incodeOf(id);
    } catch (e) {
      return { ok: false, error: `读取群邀请码失败: ${e.message}` };
    }

    const info = await groupInfoOf(id);
    const groupName = (info && info.name) || page.groupName || '';

    // ① 服务端根本没存码（从未生成过）
    if (!page.inviteCode) {
      stats.noIncode++;
      return {
        ok: false,
        error: `群「${groupName || id}」没有群聊邀请码（服务端未存有邀请码），无法生成群名片`,
      };
    }

    // ② 有码 ≠ 码可用。关闭邀请码只把码的 expireTime 置成过去值、并把 showQRCode 广播成 0，
    //    码字符串仍留在服务端、addcg 照样渲染 —— 所以有效性只能看 showQRCode。
    if (fetchGroupDescription) {
      let desc;
      try {
        desc = await fetchGroupDescription(id);
      } catch (e) {
        desc = undefined;
      }
      if (desc === undefined || desc === null) {
        stats.detailFail++;
        return {
          ok: false,
          error: `群「${groupName || id}」读不到群详情，无法确认邀请码是否有效（连上 IM 后重试）`,
        };
      }
      const flag = parseShowQRCode(desc);
      if (!flag.ok) {
        stats.disabled++;
        return {
          ok: false,
          error: `群「${groupName || id}」已关闭群聊邀请码（群详情 showQRCode=${flag.rawText}），无法生成群名片`,
        };
      }
    }

    return {
      ok: true,
      groupName,
      inviteCode: page.inviteCode,
      attachment: buildAttachment({
        groupId: id,
        groupName,
        inviteCode: page.inviteCode,
        listPic: info && info.pics,
      }),
    };
  }

  return {
    resolve,
    incodeOf,
    groupInfoOf,
    stats: () => ({ ...stats }),
  };
}

module.exports = {
  createGroupCardResolver,
  parseAddcgPage,
  parseShowQRCode,
  normalizeListPic,
  buildAttachment,
  defaultFetchText,
  DEFAULT_LEARN_BASE,
  DEFAULT_IM_BASE,
  MAX_LIST_PIC,
};
