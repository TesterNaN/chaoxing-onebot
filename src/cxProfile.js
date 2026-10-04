/**
 * 资料解析器：把 uid 补成真实姓名（**可选功能**，默认关闭）
 *
 * 真名不在环信 SDK 里——两个客户端都是走"cookie 会话 + 学习通自己的 HTTP 接口"，
 * 但**端点不同**，所以这里提供两种方案（`onebot.profileSource`）：
 *
 *   web：网页端那条路
 *     GET  {im}/webim/user/getUserInfoByTuid?tuid=<uid>     ← 只要 cookie，单个查询
 *     GET  {im}/apis/getLoginUser?detail=1
 *     GET  {im}/webim/huanxin/getGroupInfo?roomId=<群id>
 *
 *   pc：PC 客户端那条路（主进程 UserOut.getUserByTuids）
 *     POST {user}/apis/user/getUsers4C?<tokenSign>          ← cookie + tokenSign，**批量**
 *     表单体 tuids=a,b,c（见 src/cxToken.js）
 *
 * 缓存策略：TTL + LRU + 并发去重。失败**不缓存**，返回 null，由调用方回落 uid，
 * 绝不因为查名字失败而丢消息。
 */
const https = require('https');
const zlib = require('zlib');
const { signUrl, formBody } = require('./cxToken');

const DEFAULT_BASE = 'https://im.chaoxing.com';
const DEFAULT_PC_BASE = 'https://useryd.chaoxing.com';
const FAIL_WARN_AFTER = 5;      // 连续失败多少次后开始明确告警
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function defaultFetchJson(url, { cookie, timeoutMs, base, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host,
      path: u.pathname + u.search,
      method,
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: cookie || '',
        referer: `${base || u.origin}/`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
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
        const text = buf.toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch {
          reject(new Error(`响应不是 JSON（cookie 可能已失效）: ${text.slice(0, 80)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * @param {object} opts
 * @param {string} opts.cookie        学习通 cookie（与适配器其它请求同一份）
 * @param {'web'|'pc'} [opts.source]  走哪个客户端那条路，默认 'web'
 * @param {string} [opts.puid]        pc 方案签名的身份参数（**必须是 puid，不是 tuid**）
 * @param {string} [opts.tuid]        pc 方案下查自己资料用（web 方案用 getLoginUser，不需要）
 * @param {string} [opts.base]        web 方案主机，默认 https://im.chaoxing.com
 * @param {string} [opts.pcBase]      pc 方案主机，默认 https://useryd.chaoxing.com
 * @param {number} [opts.ttlMs]       缓存有效期，默认 1 小时
 * @param {number} [opts.maxSize]     单类缓存条数上限，默认 3000
 * @param {number} [opts.timeoutMs]   单次请求超时
 * @param {number} [opts.maxInflight] 后台预取的最大并发（热路径用）
 * @param {number} [opts.batchSize]   pc 方案每次批量查询的 uid 数，默认 50
 * @param {function} [opts.fetchJson] 注入用（单测）
 */
function createProfileResolver(opts = {}) {
  const {
    cookie = '',
    source = 'web',
    puid = '',
    tuid = '',
    base = DEFAULT_BASE,
    pcBase = DEFAULT_PC_BASE,
    ttlMs = 3600000,
    maxSize = 3000,
    timeoutMs = 6000,
    maxInflight = 4,
    batchSize = 50,
    fetchJson = defaultFetchJson,
    logger = console,
  } = opts;

  const users = new Map();    // tuid → {value} | {promise}
  const groups = new Map();   // gid  → {value} | {promise}
  const stats = { userHits: 0, userMisses: 0, groupHits: 0, groupMisses: 0, errors: 0, skipped: 0, requests: 0, batched: 0, consecutiveErrors: 0, sessionInvalid: 0 };
  let inflight = 0;
  let lastWarnAt = 0;
  // 登录态失效（cookie 过期/被顶）时的冷却截止时间：这段时间内**不再发请求**。
  // cookie 失效时，pc 路返回 `登录信息异常[806001]`、云盘 token 路返回 `没有权限`，
  // 而 hxToken 仍然有效 → 消息照收，但每来一条消息都会再打一次必然失败的资料请求，
  // 日志就被同一条错误刷屏。这里改成"告警一次 + 静默 10 分钟再试"。
  let sessionRetryAt = 0;

  /**
   * 这个错误是不是"登录态失效"（而不是接口维护/网络问题）？
   * 纯函数，便于单测。实测见过的文案：
   *   `登录信息异常[806001]`（pc 资料接口）、`没有权限`（云盘 token）、HTTP 401/403
   */
  function isSessionInvalid(msg) {
    return /806001|登录信息异常|登录已失效|未登录|没有权限|重新登录|HTTP 40[13]\b/i.test(String(msg || ''));
  }
  const sessionCooldownMs = Number(opts.sessionCooldownMs) > 0 ? Number(opts.sessionCooldownMs) : 10 * 60 * 1000;
  const sessionBlocked = () => Date.now() < sessionRetryAt;

  /**
   * 失败记账。**重点是别让"接口在维护"表现为静默降级**：
   * 学习通这些 HTTP 接口（网页端 im.chaoxing.com、PC 端 useryd.chaoxing.com）
   * 都可能整段维护或改动；那时昵称会一个个回落成 uid，而消息收发照常，
   * 不特意看日志根本发现不了。所以连续失败到一定次数就**明确告警一次**（60s 内不重复）。
   */
  function noteFailure(e, key) {
    stats.errors++;
    stats.consecutiveErrors++;
    if (!logger || !logger.error) return;

    // 登录态失效是另一类问题：重试没有意义，得换 cookie。只喊一次，然后静默冷却。
    if (isSessionInvalid(e && e.message)) {
      stats.sessionInvalid++;
      if (!sessionBlocked()) {
        sessionRetryAt = Date.now() + sessionCooldownMs;
        lastWarnAt = Date.now();
        logger.error(
          `[profile] ⚠️ 登录态似乎已失效（${e.message}）—— cookie 过期或被顶掉了。`
          + `昵称会回落为 uid；**云盘相关功能（发文件/视频、取直链）也会一起失效**。`
          + `需重新登录刷新 cookie：node src/login.js qr（或在客户端重新登录后更新 config.json）。`
          + `已暂停资料查询 ${Math.round(sessionCooldownMs / 60000)} 分钟，避免刷屏。`
        );
      }
      return;
    }

    if (stats.consecutiveErrors >= FAIL_WARN_AFTER) {
      if (Date.now() - lastWarnAt > 60000) {
        lastWarnAt = Date.now();
        logger.error(
          `[profile] ⚠️ 资料接口连续失败 ${stats.consecutiveErrors} 次（最近：${e.message}）——`
          + `昵称将回落为 uid。若持续如此，多半是该接口在维护或已变更：`
          + `可改用 onebot.profileSource 的其它取值，或设为 "none" 彻底不依赖它。`
        );
      }
    } else {
      logger.error('[profile] 查询失败:', key, e.message);
    }
  }
  const noteSuccess = () => { stats.consecutiveErrors = 0; };

  const evict = (map) => { while (map.size > maxSize) map.delete(map.keys().next().value); };
  const put = (map, key, value) => { map.set(key, { value, at: Date.now() }); evict(map); };

  function cached(map, key, fetcher) {
    // 登录态冷却期内直接短路：不发请求、不记失败、不刷日志（cookie 失效时重试没有意义）
    if (sessionBlocked()) { stats.skipped++; return Promise.resolve(null); }
    const hit = map.get(key);
    if (hit) {
      if (hit.promise) return hit.promise;                    // 并发去重
      if (Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
      map.delete(key);
    }
    const p = (async () => {
      try {
        const value = await fetcher();
        noteSuccess();
        put(map, key, value);
        return value;
      } catch (e) {
        map.delete(key);                                      // 失败不缓存
        noteFailure(e, key);
        return null;
      }
    })();
    map.set(key, { promise: p });
    return p;
  }

  const get = (path, extra) => {
    stats.requests++;
    return fetchJson(`${base}${path}`, { cookie, timeoutMs, base, ...extra });
  };

  // ---------- pc 方案：批量 ----------
  const mapPcUser = (u) => ({
    tuid: u.uid != null ? String(u.uid) : '',
    puid: u.puid != null ? String(u.puid) : '',
    name: u.name || u.nick || '',
    pic: u.pic || '',
    schoolname: u.schoolname || '',
    sex: u.sex,
  });

  /**
   * 资料接口只接受**数字** id（实测：传 `358400709/webim_web_…` 这种会被服务端拒
   * `tuids参数请确保为逗号分隔数字!`）。
   * 所以这里做一道闸：非纯数字一律**不请求**、直接当作查不到 ——
   * 既省一次必然失败的往返，也不让日志被这句话刷屏。
   * （上游 imClient 已经会先剥掉 `/设备资源名`，这是第二道防线。）
   */
  const isNumericId = (v) => /^\d+$/.test(String(v == null ? '' : v).trim());

  async function fetchUsersBatch(uids, byPuid = false) {
    const list = (uids || []).map(String).filter(isNumericId);
    if (!list.length) return [];
    // 签名参数是 puid（PC 客户端 getUserByTuids(puid, tuids) 的第一个参数）；
    // 用错会被服务端拒成 "用户登录信息异常 code:433"（已验证）
    const url = signUrl(pcBase, '/apis/user/getUsers4C', { puid: String(puid || '') });
    // 同一个接口两种用法：postParams 传 tuids 或 puids
    // （PC 客户端里对应 getUserByTuids / getUserByPuids 两个方法）
    const body = formBody(byPuid ? { puids: list } : { tuids: list });
    stats.requests++;
    stats.batched++;
    const d = await fetchJson(url, { cookie, timeoutMs, base: pcBase, method: 'POST', body });
    if (!d || d.result !== 1 || !Array.isArray(d.data)) {
      throw new Error((d && d.errorMsg) || '批量查询用户失败');
    }
    return d.data.map(mapPcUser);
  }

  // ---------- web 方案：单个 ----------
  async function fetchUserOne(uid) {
    if (!isNumericId(uid)) return null;      // 同上：非数字不发请求
    const d = await get(`/webim/user/getUserInfoByTuid?tuid=${encodeURIComponent(uid)}`);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    if (d.result !== undefined && d.result !== 1) return null;
    if (!d.name && !d.puid) return null;
    return {
      tuid: String(d.tuid || uid),
      puid: d.puid != null ? String(d.puid) : '',
      name: d.name || '',
      pic: d.pic || '',
      schoolname: d.schoolname || '',
      sex: d.sex,
    };
  }

  /** 单个 uid → 资料（带缓存） */
  async function userInfo(uid) {
    const key = String(uid || '');
    if (!key || key === 'undefined') return null;
    if (!isNumericId(key)) return null;      // 见 isNumericId 注释：非数字不打请求
    const v = await cached(users, key, async () => {
      stats.userMisses++;
      return source === 'pc' ? (await fetchUsersBatch([key]))[0] || null : fetchUserOne(key);
    });
    if (v) stats.userHits++; else stats.userMisses++;
    return v;
  }

  function peekUserName(uid) {
    const hit = users.get(String(uid || ''));
    return hit && !hit.promise && Date.now() - hit.at < ttlMs ? (hit.value && hit.value.name) || null : null;
  }

  /** 后台补一条（热路径用）：未命中且并发未超限时才发起 */
  function primeUser(uid) {
    const key = String(uid || '');
    if (!key || users.get(key)) return;
    if (sessionBlocked()) { stats.skipped++; return; }        // 登录态冷却期内不发
    if (inflight >= maxInflight) { stats.skipped++; return; }
    inflight++;
    userInfo(key).finally(() => { inflight--; });
  }

  /**
   * 按 **puid** 反查资料（同一个批量接口，postParams 用 puids）。
   *
   * 为什么需要：v11 的 contact 段给的是"某个人的 id"，而学习通名片要的是 puid；
   * 收到名片时上报的 id 就是 puid（见 _toSegments 的 `u.puid || u.uid`），
   * 所以插件把名片原样回传时必须能按 puid 查。
   * 网页端那个接口只按 tuid 查，没有反向查询 → web 方案下返回 null。
   */
  async function userInfoByPuid(puidValue) {
    const key = 'puid:' + String(puidValue || '');
    if (!puidValue || source !== 'pc') return null;
    return cached(users, key, async () => {
      const list = await fetchUsersBatch([String(puidValue)], true);
      const hit = list[0] || null;
      if (hit && hit.tuid) put(users, hit.tuid, hit);   // 顺手把 uid 也缓存上
      return hit;
    });
  }

  /** 批量取昵称：{uid: name}（pc 方案下一批一次请求） */
  async function namesOf(uids, { concurrency = 8 } = {}) {
    const list = [...new Set((uids || []).map(String).filter(Boolean))];
    const out = {};
    const miss = [];
    for (const uid of list) {
      const c = peekUserName(uid);
      if (c) out[uid] = c; else miss.push(uid);
    }
    if (!miss.length) return out;

    if (source === 'pc') {
      for (let i = 0; i < miss.length; i += batchSize) {
        const chunk = miss.slice(i, i + batchSize);
        try {
          const infos = await fetchUsersBatch(chunk);
          noteSuccess();
          for (const info of infos) {
            if (info.tuid) put(users, info.tuid, info);
            out[info.tuid] = info.name || null;
          }
          for (const uid of chunk) if (out[uid] === undefined) out[uid] = null;
        } catch (e) {
          noteFailure(e, 'batch');
          for (const uid of chunk) if (out[uid] === undefined) out[uid] = null;
        }
      }
      return out;
    }
    // web 方案：单个查询 + 受限并发
    let i = 0;
    const worker = async () => {
      while (i < miss.length) {
        const uid = miss[i++];
        const info = await userInfo(uid);
        out[uid] = (info && info.name) || null;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, miss.length) }, worker));
    return out;
  }

  /** 群资料：只有 web 那条路有这个接口；pc 方案的群信息请用 SDK 的 get_group_info */
  async function groupInfo(gid) {
    if (source !== 'web') return null;
    const key = String(gid || '');
    if (!key) return null;
    const v = await cached(groups, key, async () => {
      stats.groupMisses++;
      const d = await get(`/webim/huanxin/getGroupInfo?roomId=${encodeURIComponent(key)}`);
      const g = Array.isArray(d) ? d[0] : d;
      if (!g || typeof g !== 'object') return null;
      return {
        id: String(g.id || key),
        name: g.name || '',
        owner: g.owner != null ? String(g.owner) : '',
        members_count: Number(g.members_count) || 0,
        pics: Array.isArray(g.pics) ? g.pics : [],
      };
    });
    if (v) stats.groupHits++; else stats.groupMisses++;
    return v;
  }

  /** 登录用户资料：web 用 getLoginUser；pc 用自己的 tuid 走同一个批量接口（同一条路） */
  async function loginUser() {
    if (source === 'pc') {
      if (!tuid) return null;
      const u = await userInfo(String(tuid));
      return u ? { puid: u.puid, name: u.name, fid: '', pic: u.pic } : null;
    }
    return cached(users, '__login__', async () => {
      const r = await get('/apis/getLoginUser?detail=1');
      if (!r || r.result !== 1 || !r.data) return null;
      return {
        puid: r.data.puid != null ? String(r.data.puid) : '',
        name: r.data.name || '',
        fid: r.data.fid != null ? String(r.data.fid) : '',
        pic: r.data.pic || '',
      };
    });
  }

  return {
    source,
    userInfo,
    userInfoByPuid,
    groupInfo,
    loginUser,
    namesOf,
    peekUserName,
    primeUser,
    stats: () => ({ ...stats, users: users.size, groups: groups.size }),
    clear: () => { users.clear(); groups.clear(); },
  };
}

/**
 * 解析"资料补充方案"配置（纯函数，便于单测）
 *
 *   profileSource: "none" → 只用环信 SDK（与 PC 客户端一致），不碰任何 HTTP 资料接口
 *   profileSource: "web"  → 用网页端接口补真实姓名（单个查询，只要 cookie）
 *   profileSource: "pc"   → 用 PC 客户端接口补真实姓名（批量，cookie + tokenSign）
 *
 * 兼容旧的布尔写法 profileEnrich: true === profileSource: "web"。
 * 非法值不静默兜底，返回 error 让启动器直接退出（避免"以为开了其实没开"）。
 */
const PROFILE_SOURCES = ['none', 'web', 'pc'];
function resolveProfileSource(cfg = {}) {
  const raw = cfg.profileSource !== undefined
    ? cfg.profileSource
    : (cfg.profileEnrich === true ? 'web' : 'none');
  const source = String(raw).toLowerCase();
  if (!PROFILE_SOURCES.includes(source)) {
    return { error: `onebot.profileSource 取值非法: "${raw}"（应为 none / web / pc）` };
  }
  return { source };
}

module.exports = {
  createProfileResolver,
  resolveProfileSource,
  defaultFetchJson,
  DEFAULT_BASE,
  DEFAULT_PC_BASE,
  PROFILE_SOURCES,
};
