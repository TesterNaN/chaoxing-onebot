// ============================================================================
// OneBot v11 协议实现（学习通适配）
// ----------------------------------------------------------------------------
// 规范: https://github.com/botuniverse/onebot-11
// 支持通信方式：
//   - 正向 WebSocket: 本实现作服务端，监听 /api、/event、/（默认 6700 端口）
//   - 反向 WebSocket: 本实现作客户端，主动连 wsUrl（NoneBot2 常用），
//                     握手携带 X-Self-ID / X-Client-Role
//   - 鉴权: Authorization: Bearer <token> 或 ?access_token=<token>
// 事件: message(private/group)、meta_event(lifecycle/heartbeat)
// API : send_msg / send_group_msg / send_private_msg / get_login_info /
//       get_group_list / get_group_member_list / get_group_member_info /
//       get_status / get_version_info / can_send_image 等
// ============================================================================
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { resolveImageFile } = require('./imageSource');
let WebSocketServer = null;
let WebSocketClient = null;
try {
  const ws = require('ws');
  WebSocketServer = ws.WebSocketServer || ws.Server;
  WebSocketClient = ws;
} catch (e) {
  // ws 不可用时仅 HTTP 模式（见 onebot.js 降级提示）
}

const VERSION = { app_name: 'cxstudy-onebot', app_version: '1.0.0', protocol_version: 'v11' };

/**
 * 学习通富内容类型的中文名（取自 PC 客户端附件注册表 `message-2dc1f205.js` 的 `L1`，一字未改）。
 * 用途：认得出但 v11 没有对应段类型的附件，降级成 `[中文名]` 文本上报 ——
 * **不能什么都不报**，否则占位正文被抑制后整条消息会变空（已验证）。
 */
const ATTACH_CN = {
  1: '话题', 2: '笔记', 3: '专题', 4: '报纸', 6: '期刊', 7: '小组', 8: '通知',
  10: '笔记本', 15: '课程', 17: '章节', 18: '文件', 20: '个人信息', 21: '课程',
  22: '收藏', 23: '群聊', 25: '网页', 26: '音频', 29: '视频', 30: '活动', 31: '附件',
  33: '位置', 34: '课程测验', 37: '文件夹', 38: '文件夹', 39: '图书', 40: '课程',
  41: '微课', 42: '消息内容', 43: 'wifi打卡', 44: '附件', 47: '文件夹', 48: '文件夹',
  52: '文件夹', 53: '讨论',
};

/** 从附件体里挑一个能当标题显示的字段（纯函数，找不到返回空串） */
function pickAttachLabel(d) {
  if (!d || typeof d !== 'object') return '';
  for (const k of ['name', 'title', 'fileTitle', 'groupName', 'realTitle', 'subjectTitle',
    'knowledgeLabel', 'content', 'address', 'textContent']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60);
  }
  return '';
}

/**
 * 「认得出、但 v11 没有专用段」的附件类型里，**自带可点开地址**的那些 → 用 v11 标准的 `share` 段。
 *
 * 字段名全部照 web 端附件组件 `_webim_plugins/attachment.js` 的渲染分支（一字未改）：
 *   - case 3 / 4 / 6（专题 / 报纸 / 期刊 → `att_subject`）：`category == "0"` 时用
 *     `subjectLink`；否则是章节，用 `chapterLink`，并按官方文案注明「来自《subjectTitle》」
 *   - case 17（章节 → `att_course`）：`knowledgeUrl`
 *   - case 38（云盘文件夹 → `att_cloudFolder`）：`shareInfo.weburl`
 *   - case 41（微课 → `att_micro_course`）：`url`
 *
 * ⚠️ 另外 7 种类型的地址是客户端用「运行时域名 + id」拼的（`GroupWebDomainHttps` /
 * `NoteDomainHttps` / `NoticeDomainHttps`，来自 `mirrorConfig` 的 `domainMap`）：
 * 话题(1) / 笔记(2) / 小组(7) / 通知(8) / 笔记本(10) / 话题文件夹(47) / 资料文件夹(48)。
 * 域名由启动器取一次（`src/cxDomains.js`）后经 `cfg.domains` 传进来；
 * **没传（取不到）就返回 null，照旧走文本兜底** —— 这是本函数唯一的降级路径。
 *
 * @param {number} at
 * @param {object} d  附件体
 * @param {{GroupWebDomainHttps?:string,NoteDomainHttps?:string,NoticeDomainHttps?:string}} [domains]
 * @returns {{type:'share', data:{url:string, title?:string, content?:string, image?:string}}|null}
 */
function pickShareFromAttachment(at, d, domains) {
  if (!d || typeof d !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const dom = domains || {};
  const firstImg = (arr) => (Array.isArray(arr) && typeof arr[0] === 'string' && arr[0].trim() ? arr[0].trim() : '');
  let url = '';
  let title = '';
  let content = '';
  let image = '';

  if (at === 3 || at === 4 || at === 6) {
    const isSubject = String(d.category) === '0';
    url = isSubject ? pick('subjectLink') : pick('chapterLink');
    title = isSubject ? pick('subjectTitle') : pick('chapterTitle');
    const subj = pick('subjectTitle');
    content = isSubject ? pick('subjectDescription') : (subj ? `来自《${subj}》` : '');
    image = isSubject ? pick('subjectLogo') : pick('chapterLogo');
  } else if (at === 17) {
    url = pick('knowledgeUrl');
    title = pick('knowledgeLabel');
    content = pick('courseName');
    image = pick('knowledgeLogo');
  } else if (at === 38) {
    url = (d.shareInfo && typeof d.shareInfo.weburl === 'string') ? d.shareInfo.weburl.trim() : '';
    title = pick('name');
  } else if (at === 41) {
    url = pick('url');
    title = pick('title');
    image = pick('cover');
  } else if (at === 1 && dom.GroupWebDomainHttps) {
    // 话题：case 1 → GroupWebDomainHttps + /pc/topic/jumpToTopicDetail?bbsid=<att_group.bbsId>&uuid=<uuid>
    const bbsId = d.att_group && d.att_group.bbsId;
    const uuid = pick('uuid');
    if (bbsId && uuid) {
      url = `${dom.GroupWebDomainHttps}/pc/topic/jumpToTopicDetail?bbsid=${encodeURIComponent(bbsId)}&uuid=${encodeURIComponent(uuid)}`;
    }
    title = pick('title') || pick('content');
    content = pick('title') ? pick('content') : '';
    if (pick('creatorName')) content = (content ? content + ' ' : '') + `来自 ${pick('creatorName')}`;
    image = firstImg(d.images);
  } else if ((at === 2 || at === 10) && dom.NoteDomainHttps) {
    const cid = pick('cid');
    if (cid) {
      url = at === 2
        ? `${dom.NoteDomainHttps}/pc/${encodeURIComponent(cid)}`                       // 笔记：case 2
        : `${dom.NoteDomainHttps}/pc/note_notebook/otherNotebooksLatest/${encodeURIComponent(cid)}`;  // 笔记本：case 10
    }
    if (at === 2) {
      title = pick('title') || pick('contentTxt');
      content = pick('title') ? pick('contentTxt') : '';
      if (pick('creatorName')) content = (content ? content + ' ' : '') + `来自 ${pick('creatorName')}`;
      image = firstImg(d.images);
    } else {
      title = pick('name');
    }
  } else if (at === 7 && dom.GroupWebDomainHttps) {
    // 小组：case 7 → GroupWebDomainHttps + /pc/topic/topiclist/index?bbsid=<groupId>
    const gid = pick('groupId');
    if (gid) url = `${dom.GroupWebDomainHttps}/pc/topic/topiclist/index?bbsid=${encodeURIComponent(gid)}`;
    title = pick('groupName');
    content = pick('creatorName');
    image = firstImg(d.groupLogo);
  } else if (at === 8 && dom.NoticeDomainHttps) {
    // 通知：case 8 → NoticeDomainHttps + /pc/notice/<idCode>/detail
    const idCode = pick('idCode');
    if (idCode) url = `${dom.NoticeDomainHttps}/pc/notice/${encodeURIComponent(idCode)}/detail`;
    title = pick('title');
    content = pick('createrName');
    image = pick('logo');
  } else if (at === 47 && dom.GroupWebDomainHttps) {
    // 话题文件夹：case 47 → /pc/topic/topiclist/index?bbsid=<groupInfo.bbsId>&folder_uuid=<folder_uuid>
    const bbsId = d.groupInfo && d.groupInfo.bbsId;
    const fu = pick('folder_uuid');
    if (bbsId && fu) {
      url = `${dom.GroupWebDomainHttps}/pc/topic/topiclist/index?bbsid=${encodeURIComponent(bbsId)}&folder_uuid=${encodeURIComponent(fu)}`;
    }
    title = pick('name');
  } else if (at === 48 && dom.GroupWebDomainHttps) {
    // 资料文件夹：case 48 → /pc/resource/jumpToResourceList?bbsid=<groupInfo.bbsId>&folderId=<folderId>
    const bbsId = d.groupInfo && d.groupInfo.bbsId;
    const fid = pick('folderId');
    if (bbsId && fid) {
      url = `${dom.GroupWebDomainHttps}/pc/resource/jumpToResourceList?bbsid=${encodeURIComponent(bbsId)}&folderId=${encodeURIComponent(fid)}`;
    }
    title = pick('folderName');
  }

  if (!url) return null;
  const data = { url };
  const t = title || pickAttachLabel(d);
  if (t) data.title = t;
  if (content) data.content = content;
  if (image) data.image = image;
  return { type: 'share', data };
}

// 学习通消息 id 是 int64 字符串，OneBot 要 int32 → 取模压缩（冲突概率极低）
function toInt32(id) {
  const n = Number(String(id).replace(/\D/g, '').slice(-12));
  if (!isFinite(n)) return Math.floor(Math.random() * 2e9);
  return n % 2147483647;
}

class OneBotV11 {
  /**
   * @param {object} o
   * @param {object} o.bridge  学习通桥接对象，需实现：
   *        sendText(chatType,to,text,opts) / listGroups() / listGroupMembers(gid)
   *        sendImage(chatType,to,buf,{filename,mime}) → {ok,msgId,url}
   *        getSelfInfo() → {user_id, nickname}
   * @param {object} o.cfg  onebot 配置 { accessToken, wsPort, wsHost, reverseWsUrl, httpPort, httpPostUrl, heartbeatInterval }
   */
  constructor({ bridge, cfg = {} }) {
    this.bridge = bridge;
    this.cfg = cfg;
    this.eventSockets = new Set();   // /event 与 / 连接
    this.apiSockets = new Map();     // ws -> role
    this.reverseSockets = new Set();
    this.startedAt = Math.floor(Date.now() / 1000);
    this._heartbeatTimer = null;
    this._seq = 0;
    // message_id 反查表：OneBot 的 message_id 是 int32，而学习通消息 id 是 int64，
    // 取模压缩不可逆，所以 delete_msg / get_msg 需要靠这张表还原原始会话信息。
    // 只保留最近 N 条（LRU），进程重启即失效——这是规范允许的局限，会在错误信息里说明。
    this._msgIndex = new Map();
    this._byMid = new Map();   // 原始 mid → 同一条记录（撤回通知反查作者用）
    this._msgIndexMax = cfg.msgIndexMax || 500;
  }

  /** 记录 message_id → 原始会话信息，供 delete_msg / get_msg 反查 */
  _remember(id32, rec) {
    if (id32 == null) return;
    const entry = { ...rec, id32, ts: rec.ts || Date.now() };
    this._msgIndex.set(id32, entry);
    // 反向索引：撤回通知只带原始 mid，需要靠它找出被撤回消息的作者
    if (rec.mid != null) this._byMid.set(String(rec.mid), entry);
    while (this._msgIndex.size > this._msgIndexMax) {
      const oldest = this._msgIndex.keys().next().value;
      const gone = this._msgIndex.get(oldest);
      if (gone && gone.mid != null) this._byMid.delete(String(gone.mid));
      this._msgIndex.delete(oldest);
    }
  }

  /**
   * 撤回通知 → OneBot v11 notice 事件
   *
   * 群聊 → notice_type=group_recall（group_id / operator_id / user_id / message_id）
   * 私聊 → notice_type=friend_recall（user_id / message_id）
   *
   * user_id 是「被撤回消息的发送者」：撤回通知本身只带被撤回消息的 id，
   * 所以要靠 _byMid 反查；查不到时退化为撤回者（operator）。
   */
  pushRecall(recall) {
    this._eventChain = (this._eventChain || Promise.resolve())
      .then(() => this._pushRecallInner(recall))
      .catch((e) => console.error('[onebot] pushRecall error:', e && e.message));
    return this._eventChain;
  }

  async _pushRecallInner(recall) {
    if (!recall) return null;
    const self = await this.bridge.getSelfInfo();
    const selfId = Number(self.user_id) || 0;
    const found = recall.msgId != null ? this._byMid.get(String(recall.msgId)) : null;
    const messageId = found ? found.id32 : toInt32(recall.msgId);
    const base = {
      time: Math.floor((recall.ts || Date.now()) / 1000),
      self_id: selfId,
      post_type: 'notice',
    };
    let evt;
    if (recall.isGroup) {
      // ⚠️ group_recall **没有** sub_type（对照规范原文 event/notice.md：group_increase /
      // group_decrease / group_admin / group_ban 才有 sub_type）。此处多写了一个
      // `sub_type:'normal'` —— 那正是本项目最不能有的"自造字段"，实测后被规范原文揪出来删掉。
      evt = {
        ...base,
        notice_type: 'group_recall',
        group_id: Number(recall.groupId) || 0,
        operator_id: Number(recall.operatorId) || 0,
        user_id: found && found.fromUid != null ? (Number(found.fromUid) || 0) : (Number(recall.operatorId) || 0),
        message_id: messageId,
      };
    } else {
      evt = {
        ...base,
        notice_type: 'friend_recall',
        user_id: Number(recall.peerId || recall.operatorId) || 0,
        message_id: messageId,
      };
    }
    this._broadcast(evt);
    return evt;
  }

  /**
   * 群事件 → OneBot v11 notice 事件
   *
   * 只映射**规范里有明确落点**的 operation；没有标准落点的一律不发（宁可少发，不造字段）：
   *
   *   memberPresence / membersPresence → group_increase（sub_type=approve）
   *   memberAbsence  / membersAbsence  → group_decrease（sub_type=leave）
   *   removeMember                     → group_decrease（自己被移出 → kick_me）
   *   setAdmin / removeAdmin           → group_admin（set / unset）
   *   muteMember / unmuteMember        → group_ban（ban / lift_ban）
   *
   * 有意不发（v11 无对应子类型，见 README）：
   *   destroy（群解散）、changeOwner（群主转让）、updateInfo（群资料变更）、
   *   muteAllMembers / unmuteAllMembers（全员禁言）、updateAnnouncement / deleteAnnouncement、
   *   uploadFile / deleteFile、各类邀请与申请（inviteToJoin / requestToJoin / …）
   *
   * operator_id 说明：学习通的群事件只带一个 from（事件发起者），多人事件里 SDK 会删掉它。
   * 拿不到时给 0（0 不是合法 uid，作为"未知"占位），而不是拿 user_id 冒充操作者。
   */
  pushNotice(n) {
    this._eventChain = (this._eventChain || Promise.resolve())
      .then(() => this._pushNoticeInner(n))
      .catch((e) => console.error('[onebot] pushNotice error:', e && e.message));
    return this._eventChain;
  }

  async _pushNoticeInner(n) {
    if (!n || !n.op) return null;
    const self = await this.bridge.getSelfInfo();
    const selfId = Number(self.user_id) || 0;
    const gid = Number(n.groupId) || 0;
    if (!gid) return null;
    const num = (x) => (x == null || x === '' ? 0 : (Number(x) || 0));
    const actor = num(n.actorUid);
    const targets = (n.targetUids || []).map(num).filter((x) => x > 0);
    const base = {
      time: Math.floor((n.ts || Date.now()) / 1000),
      self_id: selfId,
      post_type: 'notice',
    };
    const events = [];
    const push = (notice_type, sub_type, extra) => events.push({ ...base, notice_type, sub_type, group_id: gid, ...extra });

    switch (n.op) {
      // ---- 成员增加 ----
      case 'memberPresence':
      case 'membersPresence':
        // 单人事件里 from 即入群的人；多人事件用 members 数组（此时没有操作者信息）
        for (const uid of (targets.length ? targets : [actor])) {
          push('group_increase', 'approve', { operator_id: targets.length ? 0 : actor, user_id: uid });
        }
        break;
      case 'directJoined':
        // 自己被直接拉进群：只带群名，不带任何 uid
        push('group_increase', 'invite', { operator_id: 0, user_id: selfId });
        break;

      // ---- 成员减少 ----
      case 'memberAbsence':
      case 'membersAbsence':
        for (const uid of (targets.length ? targets : [actor])) {
          push('group_decrease', 'leave', { operator_id: targets.length ? 0 : actor, user_id: uid });
        }
        break;
      case 'removeMember':
        // 语义即"自己被移出/拉黑"，事件不带 userId
        push('group_decrease', 'kick_me', { operator_id: actor, user_id: selfId });
        break;

      // ---- 管理员变动 ----
      case 'setAdmin':
        push('group_admin', 'set', { user_id: targets[0] || selfId });
        break;
      case 'removeAdmin':
        // 语义即"自己被撤"，事件不带 userId
        push('group_admin', 'unset', { user_id: targets[0] || selfId });
        break;

      // ---- 禁言 ----
      case 'muteMember': {
        // v11 的 duration 是秒；学习通给的是**到期时间戳**（muteTimestamp），换算并夹到非负
        const dur = n.muteUntil && n.muteUntil > Date.now()
          ? Math.max(0, Math.round((n.muteUntil - Date.now()) / 1000))
          : 0;
        push('group_ban', 'ban', { operator_id: actor, user_id: targets[0] || selfId, duration: dur });
        break;
      }
      case 'unmuteMember':
        push('group_ban', 'lift_ban', { operator_id: actor, user_id: targets[0] || selfId, duration: 0 });
        break;

      default:
        // 无标准落点 → 不发。但打一次日志，避免"事件到达却无记录"（只打一次，不刷屏）
        this._unmappedOps = this._unmappedOps || new Set();
        if (!this._unmappedOps.has(n.op)) {
          this._unmappedOps.add(n.op);
          console.log(`[notice] 收到未映射的群事件 operation=${n.op}（v11 无对应子类型，未上报）`);
        }
        return null;
    }

    for (const evt of events) this._broadcast(evt);
    return events;
  }

  // ---------------- 鉴权 ----------------
  /**
   * 常数时间字符串比较，避免时序侧信道。
   * （用 === 比较 token 会因提前返回而泄露前缀匹配长度；对高熵 token 虽不实际可利用，
   *  但代价极低，顺手做对。）
   */
  static _safeEqual(a, b) {
    const ab = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ab.length !== bb.length) return false;   // 长度不同直接 false（长度本身不是秘密）
    return crypto.timingSafeEqual(ab, bb);
  }

  // ---------------- 鉴权 ----------------
  _checkAuth(req) {
    const token = this.cfg.accessToken;
    if (!token) return true;                     // 未配置 token = 不校验
    const auth = req.headers['authorization'] || '';
    const expect = `Bearer ${token}`;
    if (OneBotV11._safeEqual(auth, expect)) return true;
    try {
      const u = new URL(req.url, 'http://localhost');
      const q = u.searchParams.get('access_token') || '';
      if (OneBotV11._safeEqual(q, token)) return true;
    } catch (_) { /* URL 解析失败 → 视为未通过 */ }
    return false;
  }

  // ---------------- 事件推送 ----------------
  _broadcast(obj) {
    const payload = JSON.stringify(obj);
    // HTTP POST 方式：把事件推给框架配置的地址。
    // 用 promise 链串行发送，保持事件顺序（与 WS 路径同样的保证）。
    const postUrl = this.cfg.httpPostUrl;
    if (postUrl) {
      this._httpPushChain = (this._httpPushChain || Promise.resolve())
        .then(async () => {
          const headers = { 'Content-Type': 'application/json' };
          if (this.cfg.accessToken) headers.Authorization = `Bearer ${this.cfg.accessToken}`;
          const res = await fetch(postUrl, { method: 'POST', headers, body: payload });
          if (!res.ok) console.error(`[onebot] HTTP 事件推送返回 ${res.status}`);
        })
        .catch((e) => console.error('[onebot] HTTP 事件推送失败:', e && e.message));
    }
    for (const ws of this.eventSockets) {
      if (ws.readyState === 1) { try { ws.send(payload); } catch (_) {} }
    }
    for (const ws of this.reverseSockets) {
      if (ws.readyState === 1) { try { ws.send(payload); } catch (_) {} }
    }
  }

  /** 学习通消息 → OneBot v11 消息事件 */
  /**
   * 上抛一条学习通消息
   *
   * 事件按到达顺序串行处理：pushMessage 内部要 await getSelfInfo()，若并发放行，
   * 后到的短消息可能先发出，导致插件看到的顺序与真实顺序不一致。
   *
   * 协议纯净性：只产出 OneBot v11 规范里定义的字段与事件类型。
   * 自己发出的消息在 v11 里没有对应事件（message_sent 是 go-cqhttp 扩展），
   * 因此默认不上报，只有显式打开 reportSelfMessage 才会作为扩展上报。
   */
  pushMessage(msg) {
    // 原生 v11：post_type 只有 message / notice / request / meta_event，
    // 「自己发的消息」不属于任何一类，默认不产出事件。
    if (msg && msg.isSelf && this.cfg.reportSelfMessage !== true) return Promise.resolve(null);
    this._eventChain = (this._eventChain || Promise.resolve())
      .then(() => this._pushMessageInner(msg))
      .catch((e) => console.error('[onebot] pushMessage error:', e && e.message));
    return this._eventChain;
  }

  async _pushMessageInner(msg) {
    const self = await this.bridge.getSelfInfo();
    // 文件/视频/笔记音频的附件体里只有 resid / objectId（资源号），没有可直接下载的地址。
    // 若 bridge 支持，就在上报前换成真直链；失败或超时一律回落 preview，绝不影响事件上报。
    await this._resolveAttachUrl(msg);
    const message = this._toSegments(msg);
    const sender = {
      user_id: Number(msg.fromUid) || 0,
      nickname: msg.fromName || String(msg.fromUid || ''),
      sex: 'unknown',
      age: 0,
      ...(msg.isGroup ? { card: msg.fromName || '', role: 'member' } : {}),
    };
    // 严格按规范字段构造：time / self_id / post_type / message_type / sub_type /
    // message_id / user_id / message / raw_message / font / sender (+ group_id / anonymous)
    const base = {
      time: Math.floor((msg.ts || Date.now()) / 1000),
      self_id: Number(self.user_id) || 0,
      // 仅在显式开启时报 message_sent（go-cqhttp / NapCat 扩展，非 v11 标准）
      post_type: msg.isSelf ? 'message_sent' : 'message',
      message_id: toInt32(msg.id),
      user_id: Number(msg.isSelf ? (self.user_id || msg.fromUid) : msg.fromUid) || 0,
      message,
      raw_message: String(msg.text || ''),
      font: 0,
      sender,
    };
    const evt = msg.isGroup
      ? { ...base, message_type: 'group', sub_type: 'normal', group_id: Number(msg.groupId) || 0, anonymous: null }
      : { ...base, message_type: 'private', sub_type: 'friend' };
    // 记入反查表，插件之后可用这个 message_id 调 delete_msg
    this._remember(base.message_id, {
      mid: msg.id,
      to: msg.isGroup ? String(msg.groupId) : String(msg.peerId),
      chatType: msg.chatType,
      fromUid: msg.fromUid,     // 撤回通知靠它填 user_id（被撤回消息的作者）
      isSelf: !!msg.isSelf,
      ts: msg.ts,
    });
    this._broadcast(evt);
    return evt;
  }

  /**
   * 学习通消息 → OneBot v11 消息段数组
   *
   * 文本里 `@昵称` 前缀会转成 at 段（用 msg.atUids 提供的真实 uid）。
   * 规范里 at 段的 qq 必须是数字字符串或 'all'，所以**拿不到 uid 时不生成 at 段**，
   * 而是保留原文的 `@昵称` 文本，避免产出非法段值。
   */
  /**
   * 富内容附件 → 真直链（写回 `msg.attachUrl`）。
   *
   * 只有云盘类资源需要这一步：18 文件 / 29 视频 / 26 笔记音频。
   * 附件体里给的是 `resid`（云盘资源号）与 `objectId`，要另调云盘接口换直链。
   * 拿到后 `_toSegments` 会优先用它（`url`），拿不到就用附件里的 `preview` 预览页兜底。
   *
   * 失败一律静默兜底：**事件上报不能被这个拖住**（最多等 8 秒）。
   */
  async _resolveAttachUrl(msg) {
    const a = msg.attachment;
    if (!a || typeof this.bridge.resolveCloudUrl !== 'function') return;
    if (![18, 29, 26].includes(a.type)) return;
    const d = a.data || {};
    const resid = d.resid || d.residstr || '';
    const objectId = d.objectId2 || d.objectId || d.fileId || '';
    if (!resid && !objectId) return;
    try {
      const r = await Promise.race([
        this.bridge.resolveCloudUrl({
          resid, objectId,
          sharePuid: msg.ext && msg.ext.fromPuid,
          fromUid: msg.fromUid,
        }),
        new Promise((res) => setTimeout(() => res({ ok: false, error: '解析超时' }), 8000)),
      ]);
      if (r && r.ok && r.url) {
        msg.attachUrl = r.url;
        if (r.size && !d.size) d.size = r.size;          // 顺手补一下体积（附件体有时是空的）
      } else if (r && r.error && r.error !== '解析超时') {
        console.log(`[onebot] 云盘地址解析失败（用 preview 兜底）: ${r.error}`);
      }
    } catch (e) {
      console.log('[onebot] 云盘地址解析异常（用 preview 兜底）:', e.message);
    }
  }

  _toSegments(msg) {
    let text = String(msg.text || '');
    const segs = [];
    const atUids = (msg.atUids || []).filter((u) => u !== 'all');
    const atAll = (msg.atUids || []).includes('all');
    while (true) {
      const m = text.match(/^@(全体|[^\s：:]{1,20})[：:]?\s*/);
      if (!m) break;
      if (m[1] === '全体') {
        segs.push({ type: 'at', data: { qq: 'all' } });
        text = text.slice(m[0].length);
        continue;
      }
      if (!atUids.length) break;   // 无对应 uid → 不剥离，保留 @昵称 原文
      segs.push({ type: 'at', data: { qq: String(atUids.shift()) } });
      text = text.slice(m[0].length);
    }
    if (atAll && !segs.some((s) => s.data && s.data.qq === 'all')) segs.unshift({ type: 'at', data: { qq: 'all' } });
    // 文本前缀没覆盖到的 @（典型：图片等无正文消息只带 ext.atToInfo）→ 补 at 段
    while (atUids.length) segs.push({ type: 'at', data: { qq: String(atUids.shift()) } });
    // 服务端的 msg 对富内容只是占位（"[聊天记录]" / "[个人名片]"），已有 attachment 段时不再重复输出
    const placeholderOnly = !!msg.attachment && /^\[[^\]]{1,12}\]$/.test(text.trim());
    if (text && !placeholderOnly) segs.push({ type: 'text', data: { text } });
    // 图片消息 → image 段。v11 的 image 段字段为 file(必填) / type / url / cache / proxy / timeout，
    // 故只给 file 与 url（两者都指向带 share-secret 的可访问地址），不夹带私有字段。
    if (msg.type === 'img' && msg.image && msg.image.url) {
      segs.push({ type: 'image', data: { file: msg.image.url, url: msg.image.url } });
    }
    // 超星富内容 → OneBot 段。
    // 注意「合并转发」：学习通把它做成**网页分享**（im.chaoxing.com/message/transfer/data?s=...），
    // 没有 QQ 那种可展开的转发 id，所以映射为 v11 标准的 share 段，而不是 forward 段
    //（硬套 forward 会让插件以为能 get_forward_msg 展开）。
    if (msg.attachment) {
      const { type: at, data: ad } = msg.attachment;
      if (at === 25) {                       // att_web：群公告(webType=1) / 聊天记录转发(webType=2) / 普通网页
        segs.push({
          type: 'share',
          data: {
            url: ad.url || '',
            // 群公告的标题在 realTitle（客户端渲染为 "[群公告]" + realTitle）
            title: ad.realTitle || ad.title || '',
            ...(ad.desc ? { content: String(ad.desc) } : {}),
            ...(ad.logo ? { image: String(ad.logo) } : {}),
          },
        });
      } else if (at === 20) {                // att_user：个人名片
        const u = ad.att_user || ad;
        segs.push({ type: 'contact', data: { type: 'qq', id: String(u.puid || u.uid || '') } });
      } else if (at === 23) {                // att_chat_group：群名片（推荐群）
        const g = ad.att_chat_group || ad;
        segs.push({ type: 'contact', data: { type: 'group', id: String(g.groupId || '') } });
      } else if (at === 18 || at === 29) {
        // 官方客户端发**文件/视频**用的是 txt + attachment 18/29（不是原生消息类型）。
        // 这里必须产出段：占位文本（"[文件]" / "[视频]"）已被上面的 placeholderOnly 抑制，
        // 再不给段整条消息就变成空的了（已验证）。
        //
        // ⚠️ 附件里**没有可直接下载的文件地址**，只有 `preview`（一个 HTML 预览页）和
        // `resid`/`objectId`（云盘资源号）。若上层已用云盘接口换到真直链（`msg.attachUrl`）
        // 就优先用它 —— 这样插件能直接下载，收到什么也能原样回传（回传走的是同一条下载链接）。
        if (at === 18) {
          const f = ad.att_clouddisk || ad;
          const u = msg.attachUrl || f.preview || f.downPath || '';
          segs.push({
            type: 'file',
            data: {
              file: u || String(f.name || ''),
              ...(u ? { url: u } : {}),
              ...(f.name ? { name: String(f.name) } : {}),
              ...(f.size ? { size: String(f.size) } : {}),
            },
          });
        } else {
          const v = ad.att_video || ad;
          const u = msg.attachUrl || v.url || '';
          segs.push({
            type: 'video',
            data: {
              file: u || String(v.fileTitle || ''),
              ...(u ? { url: u } : {}),
            },
          });
        }
      } else if (at === 26 && msg.attachUrl) {
        // att_voice：笔记音频。附件体里没有 URL（只有 fileTitle/fileLength/objectId2），
        // 所以只有**解析到直链**时才报 record；解析不到就走下面的文本兜底（硬报一个空 file 没用）
        const vo = ad.att_voice || ad;
        segs.push({
          type: 'record',
          data: {
            file: msg.attachUrl,
            url: msg.attachUrl,
            ...(vo.voiceLength || vo.fileLength ? { duration: String(vo.voiceLength || vo.fileLength) } : {}),
          },
        });
      } else if (at === 31) {
        // att_linker：**链接卡片**，字段与 25 同构（imgUrl / title / textContent / url），
        // 官方网页端也是当链接渲染的 → 直接映射 share，不该降级成文本
        const l = ad.att_linker || ad;
        segs.push({
          type: 'share',
          data: {
            url: l.url || '',
            title: l.title || '',
            ...(l.textContent ? { content: String(l.textContent) } : {}),
            ...(l.imgUrl ? { image: String(l.imgUrl) } : {}),
          },
        });
      } else if (at === 33) {
        // att_map_location：位置 → v11 的 location 段（lat/lon 是字符串）
        const m0 = ad.att_map_location || ad;
        segs.push({
          type: 'location',
          data: {
            lat: m0.latitude != null ? String(m0.latitude) : '',
            lon: m0.longitude != null ? String(m0.longitude) : '',
            title: String(m0.name || ''),
            ...(m0.address ? { content: String(m0.address) } : {}),
          },
        });
      } else if (at === 1 || at === 2 || at === 3 || at === 4 || at === 6 || at === 7 || at === 8
        || at === 10 || at === 17 || at === 38 || at === 41 || at === 47 || at === 48) {
        // 这些类型的地址可拼（自带 address 或「运行时域名 + id」）→ share 段。
        // 拼不出来（附件体没带 id / 域名表没取到）就退回文本兜底 —— 绝不产出空消息。
        const sh = pickShareFromAttachment(at, ad, this.cfg.domains);
        if (sh) segs.push(sh);
        else if (at === 10) {
          // 笔记(10)：v11 没有对应段，按官方客户端自己的渲染文案降级为 text
          segs.push({ type: 'text', data: { text: `[笔记]${(ad && (ad.category || ad.title || ad.name)) || ''}` } });
        } else {
          segs.push({ type: 'text', data: { text: `[${ATTACH_CN[at] || '附件'}]${pickAttachLabel(ad)}` } });
        }
      } else if (at === 15) {
        // 笔记(10) / 课程(15)：v11 没有对应段类型，按官方客户端自己的渲染文案降级为 text。
        // 必须给出段，否则占位文本已被 placeholderOnly 抑制，整条消息会变空。
        const label = at === 10
          ? `[笔记]${(ad && (ad.category || ad.title)) || ''}`
          : `[课程]${(ad && (ad.atypeName || ad.title)) || ''}`;
        segs.push({ type: 'text', data: { text: label } });
      } else {
        // 兜底：**任何**认得出的附件类型都必须产出段，否则同上会变空消息。
        // （26 笔记音频 / 31 连接附件 / 33 位置这些都在此列）
        const cn = ATTACH_CN[at] || '附件';
        const tail = pickAttachLabel(ad);
        segs.push({ type: 'text', data: { text: `[${cn}]${tail}` } });
      }
    }
    // 文件消息 → file 段。注意：**file 段不在 OneBot v11 规范里**，是 go-cqhttp 的扩展，
    // 但生态（AstrBot / NoneBot 插件）都按它处理文件，且不报的话消息内容就丢了，故默认上报。
    if (msg.type === 'file' && msg.file && msg.file.url) {
      segs.push({
        type: 'file',
        data: {
          file: msg.file.filename || msg.file.url,
          url: msg.file.url,
          ...(msg.file.filename ? { name: msg.file.filename } : {}),
          ...(msg.file.size ? { size: String(msg.file.size) } : {}),
        },
      });
    }
    // 语音 → record 段（v11：file 必填，url 可选）；视频 → video 段
    if (msg.media && msg.media.url) {
      if (msg.type === 'audio') {
        segs.push({ type: 'record', data: { file: msg.media.url, url: msg.media.url } });
      } else if (msg.type === 'video') {
        segs.push({ type: 'video', data: { file: msg.media.url, url: msg.media.url } });
      }
    }
    // 原生 loc 消息 → location 段（v11：lat / lon / title / content，前两者是字符串）
    if (msg.type === 'loc' && msg.location) {
      segs.push({
        type: 'location',
        data: {
          lat: msg.location.lat || '',
          lon: msg.location.lon || '',
          ...(msg.location.title ? { title: String(msg.location.title) } : {}),
        },
      });
    }
    if (segs.length === 0) segs.push({ type: 'text', data: { text: '' } });
    return segs;
  }

  /**
   * OneBot message（字符串/数组/单段）→ 学习通文本 + at uids + 图片列表
   *
   * 支持 text / at / image / record / share / contact(qq|group) / file / video。
   * **遇到不支持的段直接报错**，
   * 不做静默降级——否则插件以为发出去了，实际发的是被改写过的文本。
   * @returns {{text?:string, atUids?:string[], atNames?:string[], images?:object[], records?:object[], shares?:object[], contacts?:object[], files?:object[], videos?:object[], error?:string}}
   */
  _fromMessage(message) {
    const segs = typeof message === 'string'
      ? [{ type: 'text', data: { text: message } }]
      : Array.isArray(message) ? message : [message];
    let text = '';
    const atUids = [];
    const atNames = [];
    const images = [];
    const records = [];
    const shares = [];
    const contacts = [];
    const files = [];
    const videos = [];
    for (const s of segs) {
      if (!s || !s.type) continue;
      if (s.type === 'text') text += (s.data && s.data.text) || '';
      else if (s.type === 'at') {
        const qq = s.data && s.data.qq;
        if (qq === 'all') { text += '@全体 '; atUids.push('all'); atNames.push('全体'); }
        else { text += `@${(s.data && s.data.name) || qq} `; atUids.push(String(qq)); atNames.push((s.data && s.data.name) || ''); }
      } else if (s.type === 'image') {
        // file 支持 http(s) / base64:// / data: / file:// / 本地路径
        const file = (s.data && s.data.file) || s.file;
        if (!file) return { error: 'image 段缺少 file 字段' };
        images.push({ file: String(file) });
      } else if (s.type === 'record') {
        // 语音段：v11 的 record 段字段为 file(必填) / magic / url / cache / proxy / timeout
        const file = (s.data && s.data.file) || s.file;
        if (!file) return { error: 'record 段缺少 file 字段' };
        records.push({ file: String(file) });
      } else if (s.type === 'file') {
        // v11 file 段：file（必填）/ name / file_id。file_id 是"重发已收到的文件"，
        // 需要按 id 反查原始文件 URL，这里没做 → 明确报错，不猜。
        const file = (s.data && s.data.file) || s.file || '';
        if (!file) {
          return {
            error: (s.data && s.data.file_id != null)
              ? 'file 段用 file_id 重发暂不支持：需传 file（本地路径 / http / base64）'
              : 'file 段缺少 file 字段',
          };
        }
        files.push({ file: String(file), name: (s.data && s.data.name) ? String(s.data.name) : '' });
      } else if (s.type === 'video') {
        // v11 video 段：file（必填）/ cover / url / file_id。
        // cover 用不上：SDK 的 video 消息参数里没有 thumb 字段（缩略图由 SDK 自己处理）。
        const file = (s.data && s.data.file) || s.file || '';
        if (!file) {
          return {
            error: (s.data && s.data.file_id != null)
              ? 'video 段用 file_id 重发暂不支持：需传 file（本地路径 / http / base64）'
              : 'video 段缺少 file 字段',
          };
        }
        videos.push({ file: String(file) });
      } else if (s.type === 'share') {
        // v11 链接分享：url / title 必填，content、image 可选
        const url = (s.data && s.data.url) || '';
        if (!url) return { error: 'share 段缺少 url 字段' };
        shares.push({
          url: String(url),
          title: String((s.data && s.data.title) || ''),
          content: (s.data && s.data.content) ? String(s.data.content) : '',
          image: (s.data && s.data.image) ? String(s.data.image) : '',
        });
      } else if (s.type === 'contact') {
        // v11 的 contact 段：推荐好友(type=qq) / 推荐群(type=group)。
        // 学习通两边都有对应物：qq → att_user(20) 个人信息名片，group → att_chat_group(23) 群名片。
        const ct = String((s.data && s.data.type) || 'qq');
        const id = (s.data && s.data.id) || '';
        if (ct !== 'qq' && ct !== 'group') {
          return { error: `contact 段的 type 只支持 qq / group；收到 type=${ct}` };
        }
        if (!id) return { error: 'contact 段缺少 id 字段' };
        contacts.push({ type: ct, id: String(id) });
      } else {
        return { error: `不支持的 message 段类型: ${s.type}（本适配器支持 text / at / image / record / share / contact / file / video）` };
      }
    }
    return { text: text.trim(), atUids, atNames, images, records, shares, contacts, files, videos };
  }

  // ---------------- API 处理 ----------------
  async handleAction(action, params = {}) {
    const p = params || {};
    switch (action) {
      case 'send_msg':
      case 'send_group_msg':
      case 'send_private_msg': {
        const isGroup = action === 'send_group_msg' || (action === 'send_msg' && (p.message_type === 'group' || p.group_id != null));
        const to = isGroup ? p.group_id : p.user_id;
        if (to == null) return this._resp(100, null, '缺少目标 id');
        const parsed = this._fromMessage(p.message ?? p.text ?? '');
        // 不支持的段类型 → 102（不支持的操作），不静默降级
        if (parsed.error) return this._resp(102, null, parsed.error);
        const { text, atUids, atNames, images, records, shares, contacts, files, videos } = parsed;
        const chatType = isGroup ? 'groupChat' : 'singleChat';
        const ids = [];
        // 记入反查表，让插件能撤回机器人刚发出的消息（最常用的撤回场景）
        const remember = (msgId) => this._remember(toInt32(msgId), { mid: msgId, to: String(to), chatType, isSelf: true });
        // 有正文先发正文（带 @），再逐张发图；纯图片消息不发空文本
        if (text) {
          const r = await this.bridge.sendText(chatType, String(to), text, { atUids, atNames });
          if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '发送失败');
          ids.push(r.msgId);
          if (r.msgId) remember(r.msgId);
        }
        for (const img of images) {
          let src;
          try {
            src = await resolveImageFile(img.file);
          } catch (e) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) }); // 正文已发出，图片失败不整体报错
            return this._resp(103, null, `图片解析失败: ${e.message}`);
          }
          const ri = await this.bridge.sendImage(chatType, String(to), src.buf, { filename: src.filename, mime: src.mime });
          if (!ri || !ri.ok) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, (ri && ri.error) || '图片发送失败');
          }
          ids.push(ri.msgId);
          if (ri.msgId) remember(ri.msgId);
        }
        // 链接分享 / 个人名片：学习通把富内容挂在 txt 消息的 ext.attachment 上
        for (const sh of (shares || [])) {
          const rs = await this.bridge.sendShare(chatType, String(to), sh);
          if (!rs || !rs.ok) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, (rs && rs.error) || '分享发送失败');
          }
          ids.push(rs.msgId);
          if (rs.msgId) remember(rs.msgId);
        }
        for (const ct of (contacts || [])) {
          // v11 两类名片走不同的学习通附件：qq → att_user(20)，group → att_chat_group(23)
          const isGroupCard = ct.type === 'group';
          const send = isGroupCard ? this.bridge.sendGroupContact : this.bridge.sendContact;
          if (typeof send !== 'function') {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(102, null, `当前 bridge 不支持${isGroupCard ? '群名片' : '个人名片'}（缺少 ${isGroupCard ? 'sendGroupContact' : 'sendContact'}）`);
          }
          const rc = await send.call(this.bridge, chatType, String(to), ct);
          if (!rc || !rc.ok) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            // 名片失败最常见的原因：个人名片要 uid→puid，群名片要该群有可用邀请码。
            // 把原因原样透出（不静默降级）
            return this._resp(102, null, (rc && rc.error) || '名片发送失败');
          }
          ids.push(rc.msgId);
          if (rc.msgId) remember(rc.msgId);
        }
        // 语音段（学习通只认 AMR；非 amr 会自动用 ffmpeg 转码，没有 ffmpeg 则明确报错）
        for (const rec of records) {
          let src;
          try {
            src = await resolveImageFile(rec.file, { allowAny: true });   // 语音不是图片，跳过格式嗅探
          } catch (e) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, `语音解析失败: ${e.message}`);
          }
          // 格式适配：OneBot 不限制音频格式，但学习通只认 amr → 这里做等价翻译
          const { toAmr } = require('./audioFormat');
          const conv = await toAmr(src.buf, { ffmpegPath: this.cfg.ffmpegPath });
          if (!conv.ok) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, conv.error);
          }
          const { amrDuration } = require('./imageSource');
          const ra = await this.bridge.sendAudio(chatType, String(to), conv.buf, {
            filename: src.filename.replace(/\.[^.]*$/, '.amr'),
            // OneBot 的 record 段没有时长字段，但客户端画语音条需要它 → 从 AMR 帧数算
            duration: amrDuration(conv.buf),
          });
          if (!ra || !ra.ok) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, (ra && ra.error) || '语音发送失败');
          }
          ids.push(ra.msgId);
          if (ra.msgId) remember(ra.msgId);
        }
        // 视频段 → easemob 原生 video 消息。v11 的 video 段没有时长字段，但客户端显示要它
        // → 用 ffmpeg 探（和语音转码同一套二进制）；探不到就按 0 发，不因此失败
        // （官方 PC 端用 <video> 元素探、500ms 超时也是给三个 0）。
        for (const v of (videos || [])) {
          let src;
          try {
            // toFile：远程流式落盘、本地直接用磁盘路径 —— 与客户端一致，内存占用与文件大小无关
            src = await resolveImageFile(v.file, { allowAny: true, toFile: true, name: v.name });
          } catch (e) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, `视频解析失败: ${e.message}`);
          }
          let meta = { duration: 0, width: 0, height: 0 };
          try {
            const { probeVideo, probeVideoBuffer } = require('./videoMeta');
            const m = src.path
              ? await probeVideo(src.path, { ffmpegPath: this.cfg.ffmpegPath })
              : await probeVideoBuffer(src.buf, { filename: src.filename, ffmpegPath: this.cfg.ffmpegPath });
            if (m.ok) meta = { duration: m.duration, width: m.width, height: m.height };
            else console.log('[video] 元数据探测失败（按 0 发送）:', m.error);
          } catch (e) {
            console.log('[video] 元数据探测异常（按 0 发送）:', e.message);
          }
          const rv = await this.bridge.sendVideo(chatType, String(to), {
            ...(src.path ? { path: src.path, size: src.bytes } : { buf: src.buf }),
            name: v.name || src.filename,
            mime: src.mime || 'video/mp4',
            ...meta,
          });
          if (!rv || !rv.ok) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, (rv && rv.error) || '视频发送失败');
          }
          ids.push(rv.msgId);
          if (rv.msgId) remember(rv.msgId);
        }
        // 文件段 → 上传学习通云盘 + 发 txt 带 att_clouddisk（客户端不渲染原生 file 消息）
        for (const f of (files || [])) {
          let src;
          try {
            src = await resolveImageFile(f.file, { allowAny: true, toFile: true, name: f.name });
          } catch (e) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, `文件解析失败: ${e.message}`);
          }
          const rf = await this.bridge.sendFile(chatType, String(to), {
            ...(src.path ? { path: src.path, size: src.bytes } : { buf: src.buf }),
            name: f.name || src.filename,       // v11 的 name 优先
            mime: src.mime || 'application/octet-stream',
          });
          if (!rf || !rf.ok) {
            if (ids.length) return this._resp(0, { message_id: toInt32(ids[0]) });
            return this._resp(103, null, (rf && rf.error) || '文件发送失败');
          }
          ids.push(rf.msgId);
          if (rf.msgId) remember(rf.msgId);
        }
        if (!ids.length) return this._resp(100, null, '消息内容为空');
        return this._resp(0, { message_id: toInt32(ids[ids.length - 1]) });
      }
      case 'get_login_info': {
        const self = await this.bridge.getSelfInfo();
        return this._resp(0, { user_id: Number(self.user_id) || 0, nickname: self.nickname || '' });
      }
      case 'get_group_list': {
        const list = await this.bridge.listGroups();
        // 学习通 getJoinedGroups 只返回 groupid / groupname / disabled 三个字段，
        // 没有成员数来源，故 member_count 恒为 0（需要准确人数请调 get_group_info）。
        return this._resp(0, list.map((g) => ({
          group_id: Number(g.groupid || g.id) || 0,
          group_name: g.groupname || g.name || '',
          member_count: Number(g.memberCount) || 0,
          max_member_count: 2000,
        })));
      }
      case 'get_group_member_list': {
        if (p.group_id == null) return this._resp(100, null, '缺少 group_id');
        const ms = await this.bridge.listGroupMembers(String(p.group_id));
        return this._resp(0, ms.map((m) => this._member(m, p.group_id)));
      }
      case 'get_group_member_info': {
        if (p.group_id == null || p.user_id == null) return this._resp(100, null, '缺少 group_id / user_id');
        const ms = await this.bridge.listGroupMembers(String(p.group_id));
        const hit = ms.find((m) => this._memberUid(m) === String(p.user_id));
        if (!hit) return this._resp(103, null, '成员不存在');
        return this._resp(0, this._member(hit, p.group_id));
      }

      // ---------------- 消息操作 ----------------
      case 'delete_msg': {
        // 撤回消息。只能撤回本进程见过的消息（映射表），且服务端通常只允许撤回自己发的。
        if (p.message_id == null) return this._resp(100, null, '缺少 message_id');
        const rec = this._msgIndex.get(Number(p.message_id));
        if (!rec) {
          return this._resp(103, null,
            `找不到 message_id=${p.message_id}（反查表只保留最近 ${this._msgIndexMax} 条、且仅含本进程处理过的消息）`);
        }
        const r = await this.bridge.recallMessage({ mid: rec.mid, to: rec.to, chatType: rec.chatType });
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '撤回失败');
        return this._resp(0, null);
      }

      case 'get_msg': {
        // 规范返回的是一个「消息对象」（不含 post_type/self_id，调用方自行补）
        if (p.message_id == null) return this._resp(100, null, '缺少 message_id');
        const rec = this._msgIndex.get(Number(p.message_id));
        if (!rec) {
          return this._resp(103, null,
            `找不到 message_id=${p.message_id}（反查表只保留最近 ${this._msgIndexMax} 条、且仅含本进程处理过的消息）`);
        }
        const raw = await this.bridge.getMessage({ mid: rec.mid, to: rec.to, chatType: rec.chatType });
        if (!raw) return this._resp(103, null, '该消息已不在服务端历史中（可能已被撤回或超出历史范围）');

        const isGroup = rec.chatType === 'groupChat';
        const segs = [];
        if (raw.type === 'img' || raw.type === 'audio' || raw.type === 'video') {
          const segType = raw.type === 'img' ? 'image' : raw.type === 'audio' ? 'record' : 'video';
          segs.push({ type: segType, data: { file: raw.url || '', url: raw.url || '' } });
        }
        if (raw.msg) segs.push({ type: 'text', data: { text: String(raw.msg) } });
        if (!segs.length) segs.push({ type: 'text', data: { text: '' } });

        const uid = String(raw.from || '');
        return this._resp(0, {
          message_id: Number(p.message_id),
          real_id: Number(p.message_id),
          message_type: isGroup ? 'group' : 'private',
          sub_type: isGroup ? 'normal' : 'friend',
          user_id: Number(uid) || 0,
          ...(isGroup ? { group_id: Number(rec.to) || 0 } : {}),
          message: segs,
          raw_message: String(raw.msg || ''),
          font: 0,
          sender: {
            user_id: Number(uid) || 0,
            nickname: uid,
            sex: 'unknown',
            age: 0,
            ...(isGroup ? { card: uid, role: 'member' } : {}),
          },
          time: Math.floor((raw.time || Date.now()) / 1000),
        });
      }

      // ---------------- 媒体与缓存 ----------------
      case 'get_file': {
        // ⚠️ `get_file` **不是** OneBot v11 规范里的动作（v11 公开 38 个动作、隐藏只有
        // `.handle_quick_operation`），它是 go-cqhttp / NapCat 系的扩展；这里按那套的响应形状
        // 返回 `{file, url, file_size}`。
        // 与 `get_image` 的关键区别：**不做图片格式校验、不套 20MB 图片上限**，
        // 而是**流式**下载到文件缓存目录（客户端同款做法），所以任何文件都下得下来。
        if (!p.file) return this._resp(100, null, '缺少 file');
        if (typeof this.bridge.getFile !== 'function') return this._resp(140, null, 'bridge 未实现 getFile');
        const r = await this.bridge.getFile(String(p.file));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '获取文件失败');
        return this._resp(0, { file: r.path, url: String(p.file), file_size: String(r.bytes) });
      }
      case 'get_image': {
        // 参数 file 支持图片地址（image 段的 file/url）或本地路径
        if (!p.file) return this._resp(100, null, '缺少 file');
        const r = await this.bridge.getImage(String(p.file));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '获取图片失败');
        return this._resp(0, { file: r.path });   // 规范：返回本地文件绝对路径
      }
      case 'get_record': {
        // 语音与图片同为 chatfiles 资源，复用同一套下载逻辑
        if (!p.file) return this._resp(100, null, '缺少 file');
        const r = await this.bridge.getImage(String(p.file));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '获取语音失败');
        return this._resp(0, { file: r.path });
      }
      case 'clean_cache': {
        const n = await this.bridge.cleanImageCache();
        return this._resp(0, null);
      }

      // ---------------- 群管理 ----------------
      case 'set_group_ban': {
        // duration=0 表示解除禁言；单位秒（规范），SDK 用毫秒
        if (p.group_id == null || p.user_id == null) return this._resp(100, null, '缺少 group_id / user_id');
        const duration = Number(p.duration) || 0;
        const r = duration > 0
          ? await this.bridge.muteGroupMember(String(p.group_id), String(p.user_id), duration * 1000)
          : await this.bridge.unmuteGroupMember(String(p.group_id), String(p.user_id));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '禁言操作失败');
        return this._resp(0, null);
      }
      case 'set_group_whole_ban': {
        if (p.group_id == null) return this._resp(100, null, '缺少 group_id');
        const enable = p.enable === undefined ? true : !!p.enable;
        const r = enable
          ? await this.bridge.disableSendGroupMsg(String(p.group_id))
          : await this.bridge.enableSendGroupMsg(String(p.group_id));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '全员禁言操作失败');
        return this._resp(0, null);
      }
      case 'set_group_kick': {
        if (p.group_id == null || p.user_id == null) return this._resp(100, null, '缺少 group_id / user_id');
        const r = await this.bridge.removeGroupMember(String(p.group_id), String(p.user_id));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '踢出失败');
        return this._resp(0, null);
      }
      case 'set_group_admin': {
        if (p.group_id == null || p.user_id == null) return this._resp(100, null, '缺少 group_id / user_id');
        const enable = p.enable === undefined ? true : !!p.enable;
        const r = enable
          ? await this.bridge.setGroupAdmin(String(p.group_id), String(p.user_id))
          : await this.bridge.removeGroupAdmin(String(p.group_id), String(p.user_id));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '设置管理员失败');
        return this._resp(0, null);
      }
      case 'set_group_card': {
        if (p.group_id == null || p.user_id == null) return this._resp(100, null, '缺少 group_id / user_id');
        const r = await this.bridge.setGroupMemberAttributes(String(p.group_id), String(p.user_id), { name: String(p.card || '') });
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '设置群名片失败');
        return this._resp(0, null);
      }
      case 'set_group_name': {
        if (p.group_id == null || !p.group_name) return this._resp(100, null, '缺少 group_id / group_name');
        const r = await this.bridge.setGroupName(String(p.group_id), String(p.group_name));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '修改群名失败');
        return this._resp(0, null);
      }
      case 'set_group_leave': {
        if (p.group_id == null) return this._resp(100, null, '缺少 group_id');
        const r = await this.bridge.leaveGroup(String(p.group_id));
        if (!r || !r.ok) return this._resp(103, null, (r && r.error) || '退群失败');
        return this._resp(0, null);
      }
      case 'get_status': {
        // 连接健康 + 运行计数（去重拦截、收发量、重连次数），便于外部监控
        const h = this.bridge.health ? await this.bridge.health() : { online: true };
        return this._resp(0, {
          online: h.online !== false,
          good: h.online !== false && h.stale !== true,
          stat: { ...h, uptime: Math.floor(Date.now() / 1000) - this.startedAt },
        });
      }
      case 'get_version_info':
        return this._resp(0, VERSION);
      case 'set_restart': {
        // 规范：重启会掐断当前 API 连接，因此**先回 async 响应、再异步重启**；
        // 参数 delay 是要延迟的毫秒数（默认 0；规范建议起不来时给 2000 左右）。
        // 谁来回拉起进程由启动器决定（父进程守护 / 外部守护 / 自己 re-exec），
        // 都没有则明确回 102，而不是假装成功。
        const plan = this.bridge.restartPlan ? this.bridge.restartPlan() : { ok: false, reason: '未实现' };
        if (!plan.ok) return this._resp(102, null, `不支持重启：${plan.reason}`);
        const delay = Math.max(0, Number(p.delay) || 0);
        setTimeout(() => {
          Promise.resolve(this.bridge.performRestart(delay)).catch((e) => {
            console.error('[onebot] 重启失败:', e && e.message);
          });
        }, 300);                                  // 300ms 让 async 响应先写出去
        return this._resp(1, null, null, 'async');
      }
      case 'can_send_image':
        return this._resp(0, { yes: true });
      case 'can_send_record':
        return this._resp(0, { yes: true });
      case 'get_group_info': {
        // getGroupInfo（单群）比群列表丰富：直接带 affiliations_count（真实成员数）、
        // maxusers（真实群上限）、owner、created 等，一次请求即可，无需再数成员列表。
        const info = this.bridge.getGroupInfo ? await this.bridge.getGroupInfo(String(p.group_id)) : null;
        if (info && info.id != null) {
          return this._resp(0, {
            group_id: Number(info.id) || 0,
            group_name: info.name || '',
            member_count: Number(info.affiliations_count) || 0,
            max_member_count: Number(info.maxusers) || 0,
          });
        }
        // 兜底：退化为查群列表
        const list = await this.bridge.listGroups();
        const hit = list.find((g) => String(g.groupid || g.id) === String(p.group_id));
        if (!hit) return this._resp(103, null, '群不存在');
        return this._resp(0, {
          group_id: Number(hit.groupid || hit.id),
          group_name: hit.groupname || hit.name || '',
          member_count: 0,
          max_member_count: 0,
        });
      }
      default:
        return this._resp(102, null, `不支持的 action: ${action}`);
    }
  }

  _resp(retcode, data, msg, status) {
    // v11 的 status 只有 ok / failed / async 三种；retcode 规范没定义枚举值，
    // 生态（go-cqhttp / NapCat）约定 0=ok、1=async、其余为各类失败。
    const st = status || (retcode === 0 ? 'ok' : (retcode === 1 ? 'async' : 'failed'));
    const out = { status: st, retcode, data: data === undefined ? null : data };
    if (msg && retcode !== 0) out.msg = msg;
    return out;
  }

  /**
   * 群成员原始项 → OneBot 成员对象
   *
   * 学习通 listGroupMembers 的返回项形如 `{"member":"100000001"}` 或 `{"owner":"100000002"}`，
   * **SDK 只给 uid**；bridge 会顺手用学习通自己的接口补上 `name`（真实昵称）。
   * 补不到时回落 uid 字符串（留空会让插件显示为空白，回落 uid 至少可辨识）。
   */
  _memberUid(m) {
    return String((m && (m.member || m.owner)) || '');
  }

  _member(m, groupId) {
    const uid = this._memberUid(m);
    const isOwner = !!(m && m.owner);
    const name = (m && m.name) || uid;
    return {
      group_id: Number(groupId) || 0,
      user_id: Number(uid) || 0,
      nickname: name,
      card: name,
      sex: 'unknown',
      age: 0,
      area: '',
      join_time: 0,
      last_sent_time: 0,
      level: '0',
      role: isOwner ? 'owner' : 'member',
      unfriendly: false,
      title: '',
    };
  }

  // ---------------- 正向 HTTP ----------------
  /**
   * OneBot v11 的 HTTP 通信方式：本实现作为 HTTP 服务端，
   * 框架 POST `{action, params, echo}` 到 `/`（或 /api），返回与 WS 完全相同的响应体。
   * API 处理逻辑与 WS 共用 handleAction，所以两种方式行为一致。
   */
  startHttpServer() {
    const port = Number(this.cfg.httpPort) || 0;
    if (!port) return null;
    const host = this.cfg.httpHost || '127.0.0.1';
    const server = http.createServer((req, res) => {
      const send = (code, obj) => {
        try {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        } catch (_) { /* 连接可能已断 */ }
      };
      const path = (req.url || '/').split('?')[0];
      if (req.method !== 'POST') {
        return send(405, { status: 'failed', retcode: 1404, data: null, msg: '仅支持 POST' });
      }
      if (path !== '/' && path !== '/api') {
        return send(404, { status: 'failed', retcode: 1404, data: null, msg: '路径应为 / 或 /api' });
      }
      if (!this._checkAuth(req)) {
        return send(401, { status: 'failed', retcode: 1403, data: null, msg: '鉴权失败' });
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4 * 1024 * 1024) { req.destroy(); }   // 防超大 body
      });
      req.on('end', async () => {
        let reqObj = null;
        try { reqObj = JSON.parse(body || '{}'); } catch (_) {
          return send(400, { status: 'failed', retcode: 1400, data: null, msg: 'body 不是合法 JSON' });
        }
        if (!reqObj || !reqObj.action) {
          return send(400, { status: 'failed', retcode: 1400, data: null, msg: '缺少 action' });
        }
        try {
          const out = await this.handleAction(reqObj.action, reqObj.params);
          if (reqObj.echo !== undefined) out.echo = reqObj.echo;
          send(200, out);
        } catch (e) {
          send(200, { status: 'failed', retcode: 1200, data: null, msg: String(e && e.message), ...(reqObj.echo !== undefined ? { echo: reqObj.echo } : {}) });
        }
      });
      req.on('error', () => {});
    });
    server.listen(port, host, () => console.log(`[onebot] 正向 HTTP 监听 http://${host}:${port}  (POST /)`));
    this._httpServer = server;
    return server;
  }

  // ---------------- 正向 WS ----------------
  startWsServer() {
    if (!WebSocketServer) { console.error('[onebot] 未找到 ws 库，跳过正向 WebSocket'); return null; }
    const host = this.cfg.wsHost || '127.0.0.1';
    const port = this.cfg.wsPort || 6700;
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      if (!this._checkAuth(req)) { try { ws.close(1008, 'auth failed'); } catch (_) {} return; }
      const path = (req.url || '/').split('?')[0];
      const role = path.startsWith('/api') ? 'API' : path.startsWith('/event') ? 'EVENT' : 'UNIVERSAL';
      console.log(`[onebot] 正向 WS 连接: ${role} ${path}`);
      if (role === 'API' || role === 'UNIVERSAL') this.apiSockets.set(ws, role);
      if (role === 'EVENT' || role === 'UNIVERSAL') this.eventSockets.add(ws);
      ws.on('message', async (raw) => {
        if (role === 'EVENT') return; // event 通道不接受 API 调用
        let reqObj = null;
        try { reqObj = JSON.parse(raw.toString()); } catch (_) { return; }
        if (!reqObj || !reqObj.action) return;
        const out = await this.handleAction(reqObj.action, reqObj.params);
        if (reqObj.echo !== undefined) out.echo = reqObj.echo;
        try { ws.send(JSON.stringify(out)); } catch (_) {}
      });
      const cleanup = () => { this.apiSockets.delete(ws); this.eventSockets.delete(ws); };
      ws.on('close', cleanup); ws.on('error', cleanup);
    });
    server.listen(port, host, () => console.log(`[onebot] 正向 WebSocket 监听 ws://${host}:${port}  (/api /event /)`));
    this._wsServer = server;
    return server;
  }

  // ---------------- 反向 WS ----------------
  startReverseWs() {
    if (!this.cfg.reverseWsUrl) return null;
    if (!WebSocketClient) { console.error('[onebot] 未找到 ws 库，跳过反向 WebSocket'); return null; }
    const selfId = this.cfg.selfId || 0;
    const connect = async () => {
      try {
        const opts = { headers: { 'X-Self-ID': String(selfId), 'X-Client-Role': 'Universal' } };
        if (this.cfg.accessToken) opts.headers['Authorization'] = `Bearer ${this.cfg.accessToken}`;
        const ws = new WebSocketClient(this.cfg.reverseWsUrl, opts);
        ws.on('open', () => console.log('[onebot] 反向 WS 已连接:', this.cfg.reverseWsUrl));
        ws.on('message', async (raw) => {
          let reqObj = null;
          try { reqObj = JSON.parse(raw.toString()); } catch (_) { return; }
          if (!reqObj || !reqObj.action) return;
          const out = await this.handleAction(reqObj.action, reqObj.params);
          if (reqObj.echo !== undefined) out.echo = reqObj.echo;
          try { ws.send(JSON.stringify(out)); } catch (_) {}
        });
        ws.on('close', () => {
          this.reverseSockets.delete(ws);
          console.log('[onebot] 反向 WS 断开，3s 后重连');
          setTimeout(connect, this.cfg.reconnectInterval || 3000);
        });
        ws.on('error', (e) => console.error('[onebot] 反向 WS 错误:', e.message));
        this.reverseSockets.add(ws);
      } catch (e) {
        console.error('[onebot] 反向 WS 连接失败:', e.message);
        setTimeout(connect, this.cfg.reconnectInterval || 3000);
      }
    };
    connect();
    return true;
  }

  // ---------------- 生命周期 / 心跳 ----------------
  startHeartbeat() {
    const interval = this.cfg.heartbeatInterval || 5000;
    this.sendMetaEvent('lifecycle', { sub_type: 'connect' });
    this._heartbeatTimer = setInterval(async () => {
      // v11 心跳的 status 规范定义为 {online, good}，不放实现私货；
      // 运行计数走 get_status 的 stat 字段（那才是规范里给实现留的位置）。
      let status = { online: true, good: true };
      try {
        if (this.bridge.health) {
          const h = await this.bridge.health();
          status = { online: h.online !== false, good: h.online !== false && h.stale !== true };
        }
      } catch (_) { status = { online: false, good: false }; }
      this.sendMetaEvent('heartbeat', { status, interval });
    }, interval);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }
  sendMetaEvent(meta_event_type, extra = {}) {
    this._broadcast({ time: Math.floor(Date.now() / 1000), self_id: Number(this.cfg.selfId) || 0, post_type: 'meta_event', meta_event_type, ...extra });
  }
  stop() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    for (const ws of [...this.apiSockets.keys(), ...this.eventSockets, ...this.reverseSockets]) { try { ws.close(); } catch (_) {} }
    if (this._wsServer) { try { this._wsServer.close(); } catch (_) {} }
    if (this._httpServer) { try { this._httpServer.close(); } catch (_) {} }
  }
}

module.exports = { OneBotV11, VERSION };
