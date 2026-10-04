// ②③ 环信通道客户端（appKey = cx-dev#cxstudy，Conn 4.15.1 node）
// 实现学习通前端 message-2dc1f205.js 中 WebIMController 的等价逻辑：
//   tokenLogin(tuid, hxToken) -> conn.open({user, accessToken})
//   群消息: message.create({type:'txt', chatType:'groupChat', to, msg}) -> conn.send(...)
// 注意：easemob-websdk 为浏览器形态，Node 需补齐 global shim（下面已处理）。
const path = require('path');
const { DedupCache } = require('./dedup');

// --- browser-ish globals required by easemob-websdk 4.15.1 under Node ---
if (typeof global.self === 'undefined') global.self = global;
if (typeof global.window === 'undefined') global.window = global;
if (!global.navigator) global.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) cxstudy/1.4.2' };
// SDK 在 web 分支读取 window.document.cookie（日志级别持久化）、注册事件监听，Node 无 document
if (typeof global.document === 'undefined') {
  global.document = {
    cookie: '',
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, click() {} }),
    body: { appendChild() {} },
  };
}
// 同上，window.location 可能被读取（协议判定），给个最小值
if (global.window && !global.window.location) {
  Object.defineProperty(global.window, 'location', {
    value: { protocol: 'https:', href: 'https://im.chaoxing.com/' },
    configurable: true,
  });
}
// easemob SDK 走 web 平台分支时需要浏览器 XMLHttpRequest 做 httpDNS/REST；
// 系统 Node 没有，注入最小实现（仅 SDK 内部调用所需成员）。
if (typeof global.XMLHttpRequest === 'undefined') {
  const { MiniXMLHttpRequest } = require('./xhrShim');
  global.XMLHttpRequest = MiniXMLHttpRequest;
}
// localStorage（SDK 保存设备信息）
if (typeof global.localStorage === 'undefined') {
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
  };
}
// 触发 SDK 平台检测在加载后生效：easemob 检测 window.WebSocket 决定 web/node 分支。
// 系统 Node ≥21 自带 undici WebSocket（属性式 onopen/onmessage，与 web 分支匹配），无需替换。
// 若运行时不提供 WebSocket（如老 Node），可在此注入 ws 兼容实现（见 README 备注）。

let WebIM = null;
function sdk() {
  if (!WebIM) {
    let mod = require('easemob-websdk');
    // 4.15.1 导出 { default: { connection, message, ... } }
    WebIM = (mod && mod.default) || mod;
  }
  return WebIM;
}

const HANDLER_ID = 'cxSchoolBridge';

/**
 * 取环信 id 的**裸 uid**（纯函数）。
 *
 * 环信的 `from` / `to` 不保证是纯数字 uid：
 *   - 多端回声、cmd（已读回执）里是 `358400709/webim_web_<设备资源名>`（uid + 设备资源名）
 *   - 有些场景带 `@domain`
 * 后果：拿它去查资料会被服务端拒 `tuids参数请确保为逗号分隔数字!`（日志刷屏），
 * 以及 OneBot 事件里 `Number(uid)` = NaN 让 `user_id` 变 0。
 */
function bareId(v) {
  return String(v == null ? '' : v).split('/')[0].split('@')[0].trim();
}

/**
 * 从原生 loc 消息里取一个经纬度值（纯函数）。
 * 环信约定放在 body 里（{lat, lng, addr}），但不同版本/端可能平铺在顶层，所以两处都看。
 * 取不到返回空串 —— v11 的 location 段 lat/lon 是字符串，空串表示未知。
 */
function pickLoc(raw, keys) {
  const src = [raw, raw && raw.body, raw && raw.ext];
  for (const k of keys) {
    for (const s of src) {
      if (s && s[k] != null && s[k] !== '') return String(s[k]);
    }
  }
  return '';
}

class CxImClient {
  constructor({ appKey, puid, dedup, reportMultiDeviceSelf, profile, noticeDedup, readSyncWindowMs } = {}) {
    this.appKey = appKey;
    // 昵称解析器（src/cxProfile.js，可空）。只用来把 uid 补成真实昵称：
    // 命中缓存直接用；未命中就后台补一条，当前这条消息仍用 uid 发出，绝不阻塞事件。
    this.profile = profile || null;
    this.puid = puid != null ? String(puid) : null; // 超星 puid，发送时写入 ext.fromPuid
    this.conn = null;
    this.user = null;
    this.msgCbs = [];
    this._selfCbs = [];      // 自己发出的消息（message_sent 来源）
    this.recallCbs = [];     // 撤回通知（notice.group_recall / friend_recall 来源）
    this.noticeCbs = [];     // 群事件通知（notice.group_increase / decrease / admin / ban 来源）
    this._syncing = false;   // 是否处于离线补发窗口内（见 onOfflineMessageSyncStart/Finish）
    // 已读同步（给自己那条 cmd）按**会话合并**：停机积压或群里刷屏时，
    // 200 条消息不该变成 200 条 cmd 挤在一起发（会被环信限流）。
    // 官方客户端也是每个会话发一条（打开会话时）。
    this.readSyncWindowMs = Number.isFinite(Number(readSyncWindowMs)) ? Number(readSyncWindowMs) : 400;
    this._syncPending = new Map();   // conversationId → { isGroup, msgId, ts }
    this._syncTimer = null;
    this.handler = null;
    this._openResolvers = [];
    this._lifecycleCbs = []; // { onTokenExpired?, onDisconnected? }
    // 多端回声（连接时同步回来的、本账号已发送的消息）是否上抛到 self 通道。
    // 默认 false：本进程发出的消息已由 _reportSelf 覆盖，多端回声只会造成重启时的历史刷屏。
    this.reportMultiDeviceSelf = !!reportMultiDeviceSelf;
    // 去重 + 运行计数（见 src/dedup.js）
    this.dedup = new DedupCache(dedup || {});
    // 群事件的去重表**要能活过重登**：relogin 会重建 CxImClient，
    // 若表随实例创建，重连后的离线补发会再发一遍（群事件没有时间戳，插件无从判断新旧）。
    // 因此由启动器创建并注入；不注入时自建一份（单测/单实例场景）。
    this.noticeDedup = noticeDedup || new DedupCache(dedup || {});
    this.stats = {
      received: 0,       // 上抛给业务的入站消息
      selfIn: 0,         // 多端同步/离线补发回来的自己消息
      selfOut: 0,        // 本进程发出的消息
      sent: 0,           // 发送成功次数
      sendFailed: 0,     // 发送失败次数
      dedupDropped: 0,   // 被去重拦下的重复消息
      idMissing: 0,      // 无消息 id、无法去重的入站消息
      recalls: 0,        // 收到的撤回通知数
      readAcks: 0,       // 已处理的已读回执次数（含给对方回执 / 给自己同步）
      groupEvents: 0,    // 收到的群事件数（成员增减/管理员/禁言…）
      notices: 0,        // 其中已归一化并上抛的群事件数
      noticeDedupDropped: 0,  // 群事件因重复（离线补发/重连重放）被抑制的次数
      riskWarnings: 0,   // 风控/限流类响应次数（>0 就该警惕）
      reconnects: 0,     // 触发过的重连次数
    };
  }

  /**
   * 生命周期回调：token 过期 / 断线（用于上层自动重登）
   * @param {{onTokenExpired?:()=>void, onDisconnected?:(e:any)=>void}} cbs
   */
  onLifecycle(cbs) { if (cbs) this._lifecycleCbs.push(cbs); }

  _emitLifecycle(name, arg) {
    for (const cb of this._lifecycleCbs) {
      try { if (cb[name]) cb[name](arg); } catch (e) { console.error('[im] lifecycle cb error', e); }
    }
  }

  isOpened() {
    return !!(this.conn && this.conn.isOpened && this.conn.isOpened());
  }

  /**
   * ① 换 token 并连接。cred: {hxToken, tuid}；或直接传 {connection 已建}
   * @param {{hxToken:string, tuid:string|number}} cred
   * @param {(msg:any)=>void} [onMsg] 可选：直接注册收消息回调
   */
  async connect(cred, onMsg) {
    if (onMsg) this.msgCbs.push(onMsg);
    if (this.isOpened()) return this;
    if (cred && cred.tuid != null) this.myUid = String(cred.tuid); // 回声过滤用

    const W = sdk();
    this.conn = new W.connection({
      appKey: this.appKey,
      autoReconnectNumMax: 3,
    });

    this.handler = {
      onConnected: () => console.log('[im] connected'),
      onDisconnected: (e) => {
        console.log('[im] disconnected');
        this._emitLifecycle('onDisconnected', e);
      },
      onTokenExpired: () => {
        console.log('[im] token expired');
        this._emitLifecycle('onTokenExpired');
      },
      onTokenWillExpire: () => console.log('[im] token will expire soon'),
      onTextMessage: (msg) => this._dispatch('txt', msg),
      onImageMessage: (msg) => this._dispatch('img', msg),
      onFileMessage: (msg) => this._dispatch('file', msg),
      // 环信原生语音/视频/位置消息（未注册时，即使收到也会被静默丢弃）
      onAudioMessage: (msg) => this._dispatch('audio', msg),
      onVideoMessage: (msg) => this._dispatch('video', msg),
      onLocationMessage: (msg) => this._dispatch('location', msg),
      onCustomMessage: (msg) => this._dispatch('custom', msg),
      onCmdMessage: (msg) => this._dispatch('cmd', msg),
      // 离线补发窗口：SDK 开始/结束拉取离线消息（官方类型里有定义）。
      // 窗口内投递的都是**启动前**的旧消息/群事件，启动器据此跳过不上报。
      onOfflineMessageSyncStart: () => { this._syncing = true; this.stats.syncWindows = (this.stats.syncWindows || 0) + 1; },
      onOfflineMessageSyncFinish: () => { this._syncing = false; },
      // 群事件（成员增减/管理员变动/禁言…）。未注册时，这些事件全部被静默丢弃。
      // SDK 已在类型里定义 operation 取值，运行时载荷见 _onGroupEvent 注释。
      onGroupEvent: (e) => this._onGroupEvent(e),
      onError: (e) => console.error('[im] error', e),
    };
    this.conn.addEventHandler(HANDLER_ID, this.handler);

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('open timeout')), 15000);
      this.conn.open({ user: String(cred.tuid), accessToken: cred.hxToken }).then(
        () => {
          clearTimeout(to);
          console.log('[im] tokenLogin success, user=', cred.tuid);
          resolve();
        },
        (e) => { clearTimeout(to); reject(new Error('tokenLogin failed: ' + (e && e.message))); }
      );
    });
    return this;
  }

  /**
   * uid → 显示名。命中缓存返回昵称；未命中返回 uid 并后台预取（下次就有名字了）。
   * 查询失败一律回落 uid，不抛错、不阻塞。
   */
  _displayName(uid) {
    const id = String(uid || '');
    if (!id) return '';
    if (!this.profile) return id;
    const cached = this.profile.peekUserName(id);
    if (cached) return cached;
    try { this.profile.primeUser(id); } catch (_) { /* 预取失败无所谓 */ }
    return id;
  }

  /**
   * 群事件归一化（SDK onGroupEvent → 与协议无关的中间形态）
   *
   * 载荷事实（读 easemob-websdk 4.15.1 运行时得到，类型声明里没写全）：
   *   const a = { operation: '', id: t.mucId.name, from: t.from.name }   ← from 是**事件发起者**
   *   memberPresence:  from = 入群的人（自己申请/被拉都算），带 memberCount
   *   membersPresence: 由 memberPresence 复制而来，**delete from**，改为 members 数组
   *   memberAbsence / membersAbsence: 同理（退群）
   *   directJoined:    只带 name（群名），不带 userId/from
   *   removeMember:    不带 userId（语义即"自己被移出"）
   *   setAdmin / muteMember / unmuteMember: userId = t.to[0]（**被操作的人**），from = 发起者
   *   removeAdmin:     不带 userId（语义即"自己被撤"）
   *   muteMember 额外从 ext.user_mute_time 取 muteTimestamp
   * 因此：单人事件里 from 既是发起者、也是主体；多人事件里没有单一主体，故 operator 未知。
   */
  _onGroupEvent(e) {
    try {
      this.stats.groupEvents++;
      const op = String((e && e.operation) || '');
      if (!op) return;
      const bare = (x) => String(x == null ? '' : x).split('/')[0];   // "uid/resource" → uid
      const members = Array.isArray(e.members) ? e.members.map(bare).filter(Boolean) : [];
      const notice = {
        op,
        groupId: bare(e.id),
        actorUid: bare(e.from),
        targetUids: members.length
          ? members
          : (e.userId != null && e.userId !== '' ? [bare(e.userId)] : []),
        memberCount: typeof e.memberCount === 'number' ? e.memberCount : null,
        muteUntil: e.muteTimestamp != null ? Number(e.muteTimestamp) : null,
        groupName: e.name || '',
        announcement: e.announcement || '',
        ts: Date.now(),
      };
      // 幂等：SDK 在重连/离线同步时会把同一批群事件**重复投递**
      // （实测同一组事件每次重连都会重放）。群事件不带时间戳，无法像消息那样靠 time 判断新旧，
      // 所以这里按事件内容去重——同一 (operation, 群, 目标, 成员数) 在 TTL 内只上抛一次。
      // 键里带上 operation：退群与入群是两个不同事件，不会被互相抑制。
      // 键必须带 actorUid：入群/退群事件里成员挂在 from（actorUid）上、targetUids 是空的，
      // 少了它，同群两个不同成员入群且成员数恰好相同时会被误判为重复（单测抓到过）。
      const key = `notice:${op}|${notice.groupId}|${notice.actorUid}|${notice.targetUids.join(',')}|${notice.memberCount == null ? '' : notice.memberCount}`;
      if (this.noticeDedup.check(key)) {
        this.stats.noticeDedupDropped++;
        return;
      }
      this.stats.notices++;
      for (const cb of this.noticeCbs) {
        try { cb(notice); } catch (err) { console.error('[im] onNotice cb error', err); }
      }
    } catch (err) {
      console.error('[im] _onGroupEvent error', err && err.message);
    }
  }

  _dispatch(type, raw) {
    // 群聊与私聊文本都上抛；业务侧按 chatType 区分
    const chatType = raw && raw.chatType;
    if (chatType !== 'groupChat' && chatType !== 'singleChat') return;
    const isGroup = chatType === 'groupChat';
    // ⚠️ 环信的 from/to 不一定是裸 uid：多端回声与 cmd（已读回执）里会是
    // `358400709/webim_web_<设备资源名>` 这种「uid + 设备资源名」，也可能带 `@domain`。
    // 不剥掉会导致两类问题：
    //   1) 拿去查资料时服务端直接拒：`tuids参数请确保为逗号分隔数字!`（日志里刷屏）
    //   2) OneBot 事件里 `Number(fromUid)` = NaN → user_id 变 0（垃圾事件）
    //   3) 自己发的多端回声认不出来（isSelf 比对失败）
    const fromUid = bareId(raw.from);
    const toUid = bareId(raw.to);
    const isSelf = !!(this.myUid && fromUid === String(this.myUid));

    // 断线重连的离线补发 / 多端推送会造成同一条消息多次到达 → 按服务端消息 id 去重
    const key = raw && raw.id != null ? `${chatType}:${raw.id}` : null;
    if (key) {
      if (this.dedup.check(key)) {
        this.stats.dedupDropped++;
        return;
      }
    } else {
      this.stats.idMissing++;
    }

    // 通道层的职责边界：只做归一化、幂等去重、上抛，不做策略、不丢消息。
    //
    // 关于离线补发：SDK 连接时会把离线期间的消息补发（实测一次启动十余条）。
    // 「要不要响应几小时前的消息」是应用层策略，而判断依据用消息自身的 ts 就够，
    // 因此这里既不丢弃、也不额外造标记字段（OneBot v11 事件的 time 已是标准字段）。
    const ts = raw.time || Date.now();

    const ext = raw.ext || {};

    // 撤回通知：学习通以 cmd 消息下发
    // 实测样本：{type:'cmd', action:'REVOKE_FLAG', from, to, chatType, ext:{msgId}}
    // from 是撤回操作者，ext.msgId 是被撤回的消息 id。
    if (type === 'cmd' && raw.action === 'REVOKE_FLAG') {
      const recall = {
        msgId: (raw.ext && raw.ext.msgId) || null,
        operatorId: raw.from != null ? bareId(raw.from) : null,
        chatType,
        isGroup,
        groupId: isGroup ? toUid : null,
        peerId: isGroup ? null : fromUid,
        isSelfOperator: !!(this.myUid && fromUid === String(this.myUid)),
        ts,
      };
      this.stats.recalls++;
      for (const cb of this.recallCbs) {
        try { cb(recall); } catch (e) { console.error('[im] onRecall cb error', e); }
      }
      return;   // 撤回通知不走普通消息回调
    }

    // 超星把不少富内容放在 ext.attachment 里（网页/聊天记录转发、个人名片、位置、笔记音频…）。
    // 字段名按 attachmentType 区分；实测样本：
    //   25 → att_web         {"title":"群聊的聊天记录","logo":"...","url":"https://im.chaoxing.com/message/transfer/data?s=..."}
    //   20 → att_user        {"name":"...","puid":...,"pic":"..."}
    // 字段名按 attachmentType 区分。除实测样本外，10 / 15 由客户端源码确认：
    //   10 → att_notebook      笔记（客户端渲染取 .category）
    //   15 → att_chat_course   课程（客户端渲染取 .atypeName || .title）
    const ATT_FIELD = {
      10: 'att_notebook', 15: 'att_chat_course',
      18: 'att_clouddisk', 20: 'att_user', 23: 'att_chat_group',
      25: 'att_web', 26: 'att_voice',
      29: 'att_video', 31: 'att_linker', 33: 'att_map_location',
    };
    let attachment = null;
    {
      const att = ext.attachment;
      const at = att && Number(att.attachmentType);
      const field = at ? ATT_FIELD[at] : null;
      if (field && att[field]) {
        attachment = { type: at, field, data: att[field] };
        // att_web 内部再按 type 细分（客户端渲染逻辑）：1=群公告  2=聊天记录(转发)  其他=普通网页
        if (at === 25 && att.att_web && att.att_web.type != null) {
          attachment.webType = Number(att.att_web.type);
        }
      }
    }

    let atList = [];
    const atTo = ext.atToInfo;
    if (typeof atTo === 'string') { try { atList = JSON.parse(atTo); } catch (_) {} }
    else if (Array.isArray(atTo)) atList = atTo;
    const atUids = atList.map((x) => (typeof x === 'object' && x ? bareId(x.uid) : bareId(x))).filter(Boolean);
    if (Array.isArray(ext.em_at_list)) atUids.push(...ext.em_at_list.map(bareId));
    // 媒体类消息：SDK 把资源放在 raw.url / raw.thumb（url 带 share-secret 才能访问）
    const fileUrl = raw.url || (raw.body && raw.body.url) || '';
    const isImgLike = type === 'img';
    const isFile = type === 'file';
    // 语音/视频：环信原生消息带 url + file_length + duration（时长秒）
    const isVoiceLike = type === 'audio' || type === 'video';
    const isLoc = type === 'loc';
    const msg = {
      id: raw.id,
      chatType,               // 'groupChat' | 'singleChat'
      isGroup,
      groupId: isGroup ? toUid : null,    // 群聊：群 id
      peerId: isGroup ? null : fromUid,   // 私聊：对方 uid（接收时 from 即对方）
      fromUid,
      // cmd / custom 不是要上报的消息（启动器直接 return），没必要为它们查昵称 ——
      // 以前每条已读回执回声都会打一次资料接口（就是那条刷屏报错的来源）
      fromName: (type === 'cmd' || type === 'custom') ? fromUid : this._displayName(fromUid),
      type,
      // 媒体消息没有 msg 字段，退回 ext 的 JSON 会在事件里显示成乱码，故媒体消息文本留空
      text: raw.msg || ((isImgLike || isVoiceLike || isFile || isLoc) ? '' : (ext && Object.keys(ext).length ? JSON.stringify(ext) : '')),
      image: isImgLike && fileUrl
        ? {
          url: fileUrl,
          thumb: raw.thumb || fileUrl + (raw.file_length > 204800 ? '&thumbnail=true' : ''),
          filename: raw.filename || '',
          filetype: raw.filetype || '',
          size: raw.file_length || raw.size || 0,
          width: raw.width || 0,
          height: raw.height || 0,
        }
        : null,
      // 文件消息：与图片同为 chatfiles 资源，但**不是图片**——必须区分，
      // 否则插件会把文件当图片处理（曾误报为 image 段）
      file: isFile && fileUrl
        ? {
          url: fileUrl,
          filename: raw.filename || '',
          filetype: raw.filetype || '',
          size: raw.file_length || raw.size || 0,
        }
        : null,
      // 语音/视频资源（字段名先按环信约定取，实测确认后再修正）
      media: isVoiceLike
        ? {
          url: fileUrl,
          filename: raw.filename || '',
          filetype: raw.filetype || '',
          size: raw.file_length || raw.size || 0,
          duration: raw.duration || raw.length || 0,
          secret: raw.secret || '',
        }
        : null,
      // 原生 loc 消息 → 经纬度（环信约定放在 body 里：{lat, lng, addr}）。
      // 字段名按各版本可能不同，这里把常见写法都兜一遍；取值失败就给空串，
      // 由 OneBot 层决定要不要上报 location 段（v11 的 location 段 lat/lon 是字符串）。
      location: type === 'loc'
        ? {
          lat: pickLoc(raw, ['lat', 'latitude']),
          lon: pickLoc(raw, ['lng', 'lon', 'longitude']),
          title: String(raw.addr || raw.address || (raw.body && raw.body.addr) || ''),
        }
        : null,
      ts,
      ext,
      atUids,
      atAll: atUids.includes('all'),
      isSelf,
      attachment,   // 富内容（网页/名片/位置…），由 attachmentType 判定
      _raw: raw,
    };
    // 语音/视频消息比较少见，首次遇到时把原始结构打出来，便于确认字段名与承载方式
    if (isVoiceLike && this.stats[type + 'Seen'] !== true) {
      this.stats[type + 'Seen'] = true;
      try {
        console.log(`[im] 首次收到 ${type} 消息，原始结构:`,
          JSON.stringify(raw, (k, v) => (typeof v === 'function' ? undefined : v)).slice(0, 600));
      } catch (_) { /* 忽略 */ }
    }
    // 自己发出的消息走独立通道：业务收消息回调（msgCbs）保持「只收别人发的」语义不变，
    // 避免 AI 自问自答；OneBot 层则据此上报 message_sent 事件。
    //
    // 注意：这里命中 isSelf 的绝大多数是「连接时离线同步回来的、本账号先前发送的消息」
    // （实测一次连接就有 10 余条），本进程真正发出的消息由 _reportSelf 上报，
    // 所以多端回声默认只计数、不上报，否则每次重启都会往事件流里灌历史回声。
    if (isSelf) {
      this.stats.selfIn++;
      if (this.reportMultiDeviceSelf) this._emitSelf(msg);
      return;
    }
    this.stats.received++;
    for (const cb of this.msgCbs) {
      try { cb(msg); } catch (e) { console.error('[im] onMessage cb error', e); }
    }
  }

  /**
   * 自己发出的消息（多端同步 + 本进程主动上报）→ 独立回调
   * @param {(msg:any)=>void} cb
   */
  onSelfMessage(cb) { if (cb) this._selfCbs.push(cb); }

  /**
   * 撤回通知回调
   * @param {(recall:{msgId:string,operatorId:string,chatType:string,isGroup:boolean,groupId?:string,peerId?:string,isSelfOperator:boolean,ts:number})=>void} cb
   */
  onRecall(cb) { if (cb) this.recallCbs.push(cb); }

  /**
   * 把"给自己发已读同步"排进合并队列
   * @returns {boolean} 是否已入队（语义上等同"该次处理已记入同步"）
   */
  _queueReadSync(msg, isGroup) {
    if (!this.myUid) return false;
    const convId = isGroup ? String(msg.groupId || '') : String(msg.fromUid);
    if (!convId) return false;
    const prev = this._syncPending.get(convId);
    if (prev) this.stats.readSyncCoalesced = (this.stats.readSyncCoalesced || 0) + 1;
    // 同会话保留**最新**一条（已读位置只前进不后退）
    if (!prev || Number(msg.ts || 0) >= Number(prev.ts || 0)) {
      this._syncPending.set(convId, { isGroup, msgId: String(msg.id), ts: msg.ts || Date.now() });
    }
    if (this._syncTimer) return true;
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.flushReadSyncs().catch(() => {});
    }, this.readSyncWindowMs);
    if (this._syncTimer.unref) this._syncTimer.unref();   // 不拖住进程退出
    return true;
  }

  /**
   * 立刻把所有待发的已读同步发出去（每个会话一条）
   * @returns {Promise<{sent:number, failed:number}>}
   */
  async flushReadSyncs() {
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
    const pending = [...this._syncPending.entries()];
    this._syncPending.clear();
    let sent = 0; let failed = 0;
    for (const [convId, p] of pending) {
      try {
        const self = String(this.myUid || '');
        await this.conn.sendMsg({
          action: 'CMD_READ_ACK',
          chatType: 'singleChat',
          to: self,
          from: self,
          type: 'cmd',
          id: 'ra' + Date.now() + '_' + sent,
          onlineState: 1,
          time: Date.now(),
          ext: {
            conversationId: convId,
            conversationType: p.isGroup ? 1 : 0,
            messageId: p.msgId,
            timestamp: String(p.ts || Date.now()),
            unreadCount: 0,
          },
        });
        sent++;
        this.stats.readSyncs = (this.stats.readSyncs || 0) + 1;
      } catch (e) {
        failed++;
        const err = (e && (e.message || e.error_description)) || String(e);
        this.stats.readSyncFailed = (this.stats.readSyncFailed || 0) + 1;
        this._noteRisk(err, '已读同步');
        console.error('[im] 已读同步（自己）发送失败:', err);
      }
    }
    return { sent, failed };
  }

  /** 是否正在拉取离线消息（补发窗口内投递的都是启动前的旧事件） */
  isSyncing() { return !!this._syncing; }

  /** 群事件通知（成员增减 / 管理员变动 / 禁言…） */
  onNotice(cb) { if (cb) this.noticeCbs.push(cb); }

  _emitSelf(msg) {
    for (const cb of this._selfCbs) {
      try { cb(msg); } catch (e) { console.error('[im] onSelfMessage cb error', e); }
    }
  }

  /**
   * 本进程主动上报自己刚发出的消息（SDK 不对发送端回显，靠这里补齐 message_sent）
   * @private
   */
  _reportSelf({ type, chatType, to, text = '', image = null, atUids = [], msgId, ts }) {
    const isGroup = chatType === 'groupChat';
    const id = msgId || `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    if (this.dedup.check(`${chatType}:${id}`)) return; // SDK 若也回显，不会重复上报
    const msg = {
      id,
      chatType,
      isGroup,
      groupId: isGroup ? String(to) : null,
      peerId: isGroup ? null : String(to),
      fromUid: this.myUid,
      fromName: this.myUid,
      type,
      text,
      image,
      ts: ts || Date.now(),
      ext: {},
      atUids,
      atAll: atUids.includes('all'),
      isSelf: true,
      _local: true, // 本进程发出的（非多端同步）
    };
    this.stats.selfOut++;
    this._emitSelf(msg);
  }

  /**
   * 发送文本消息（群聊或私聊）。
   * @param {'groupChat'|'singleChat'} chatType
   * @param {string} to  群id（groupChat）或对方uid（singleChat）
   * @param {string} text
   * @param {{atUids?:string[], fromPuid?:string|number, attachment?:object}} [opts]
   *   attachment: 学习通的富内容（share / contact 等）——它们就是挂在 txt 消息的
   *               ext.attachment 上，所以发送路径与文本完全共用，不需要新机制
   *   fromPuid: 超星业务侧 puid，官方消息 ext 携带（客户端据此渲染发件人归属）
   * @returns {Promise<{ok:boolean, msgId?:string, error?:string}>}
   */
  async sendText(chatType, to, text, opts = {}) {
    if (!this.conn) throw new Error('not connected');
    const W = sdk();
    // ext 携带 fromPuid（超星 puid），与官方客户端发送格式对齐
    const ext = {};
    const puid = opts.fromPuid ?? this.puid;
    if (puid != null) ext.fromPuid = String(puid);
    // 富内容：{attachmentType, att_web|att_user|...}，与接收侧解析用的是同一套字段
    if (opts.attachment && typeof opts.attachment === 'object') ext.attachment = opts.attachment;
    if (opts.atUids && opts.atUids.length) {
      // @提及：记录被@的 uid，客户端据此展示提醒（名称文本仍需拼进 msg）
      ext.atToInfo = opts.atUids.map((uid, i) => ({ name: opts.atNames?.[i] || '', uid: String(uid), puid: '' }));
    }
    const body = W.message.create({
      type: 'txt',
      chatType, // 'groupChat' | 'singleChat'
      to: String(to),
      msg: text,
      ext,
    });
    return new Promise((resolve) => {
      try {
        this.conn.send(body).then(
          (ok) => {
            const msgId = ok && ok.serverMsgId ? ok.serverMsgId : ok && ok.data ? ok.data.id : undefined;
            this.stats.sent++;
            // SDK 不对发送端回显，主动上报 → OneBot message_sent
            if (ok) this._reportSelf({ type: 'txt', chatType, to, text, atUids: opts.atUids || [], msgId });
            resolve({ ok: !!ok, msgId });
          },
          (err) => { this.stats.sendFailed++; resolve({ ok: false, error: (err && err.message) || 'send rejected' }); }
        );
      } catch (e) {
        this.stats.sendFailed++;
        resolve({ ok: false, error: e.message });
      }
    });
  }

  /**
   * 兼容别名：发群文本消息
   */
  async sendGroupText(groupId, text, opts = {}) {
    return this.sendText('groupChat', groupId, text, opts);
  }

  /**
   * 兼容别名：发群图片
   */
  async sendGroupImage(groupId, buf, opts = {}) {
    return this.sendImage('groupChat', groupId, buf, opts);
  }

  /**
   * 已读回执 + 已读同步：官方读消息时做**两件事**，缺一不可
   *
   * 官方客户端读消息时（PC 端 index-a5ceda84.js / message-2dc1f205.js）：
   *
   *   单聊：sendReadMessage(对方uid, 'read', 被读消息id)
   *         其内部就是 message.create({chatType:'singleChat', type:'read', to, id: msgId})
   *         —— 一条 **easemob 原生 read 消息**，对方客户端 onReadMessage 收到才显示已读
   *   群聊：给对方看的是 CMD_GROUP_MSG_READ（发给消息发送者本人），
   *         条件是 ext.showRead == 1（或部门群）；另给自己其它端发 CMD_READ_ACK 同步已读
   *
   * 不发送这些回执时，对方持续显示"未读"，即使机器人已经回复。
   *
   * 与官方的一处**有意偏差**：官方对音频消息只在"播放语音"时才发已读回执，
   * 这里所有类型都会回执——机器人处理语音（转码/转写）本身就等于"听了"，
   * 否则语音消息会永远停在未读。
   *
   * @param {object} msg 归一化后的消息（需 id / fromUid / isGroup / groupId / ext）
   * @param {{group?:boolean}} [opts] group=true 时走群聊回执（仅当 ext.showRead === 1）
   * @returns {Promise<{ok:boolean, kind?:string, error?:string}>}
   */
  async markRead(msg, opts = {}) {
    if (!msg || !msg.id || !msg.fromUid) return { ok: false, error: '缺少必要字段' };
    const isGroup = opts.group !== undefined ? !!opts.group : !!msg.isGroup;
    const kind = isGroup ? 'group' : 'private';
    let peer = false;
    let sync = false;
    let error = null;

    // ① 给对方看的"已读"
    try {
      if (isGroup) {
        // 群聊：官方条件是 ext.showRead == 1（或部门群），不满足就只同步自己、不打扰群成员
        const showRead = msg.ext && Number(msg.ext.showRead) === 1;
        if (showRead) {
          await this.conn.sendMsg({
            action: 'CMD_GROUP_MSG_READ',
            chatType: 'singleChat',
            to: String(msg.fromUid),
            from: String(this.myUid || ''),
            type: 'cmd',
            id: 'gr' + Date.now(),
            onlineState: 1,
            time: Date.now(),
            ext: {
              fromPuid: String(this.puid || ''),
              fromUid: String(this.myUid || ''),
              groupId: String(msg.groupId || ''),
              msgId: String(msg.id),
              time: String(Date.now()),
            },
          });
          peer = true;
        }
      } else {
        // 单聊：easemob 原生 read 消息。
        // ⚠️ 必须传 id（官方也是 le.id = msgId）：SDK 会把它映射成 body.ackId 并自己生成 body.id；
        //    直接传 ackId / mid 会被丢弃（单测钉住了，别改）。
        const WIM = require('easemob-websdk');
        const SDK = (WIM && WIM.default) || WIM;
        const body = SDK.message.create({
          chatType: 'singleChat',
          type: 'read',
          to: String(msg.fromUid),
          id: String(msg.id),
        });
        await this.conn.send(body);
        peer = true;
      }
    } catch (e) {
      error = (e && (e.message || e.error_description)) || String(e);
      this.stats.readAcksFailed = (this.stats.readAcksFailed || 0) + 1;
      this._noteRisk(error, '已读回执');          // 限流/禁言类响应计入 riskWarnings
      console.error('[im] 已读回执发送失败（不影响消息处理）:', error);
    }

    // ② 给自己发的已读同步（官方读消息时必做，缺少会导致未读不消）
    //
    // 不发这条的后果**很严重**：学习通侧的未读一直挂着，
    // 于是**每次重连都把整段旧会话重放一遍**，框架会把它当新消息再回复一次。
    //
    // 这里**按会话合并**（见 _queueReadSync）：同一个会话在 readSyncWindowMs 内只发一条，
    // 取最新那条消息的 id——停机积压 200 条也只发一条 cmd，避免短时间几百条请求被限流。
    sync = this._queueReadSync(msg, isGroup);
    if (peer || sync) this.stats.readAcks++;
    // ok 的含义：该次处理已记为已读（**给对方回执成功** 或 **自己的同步已入队**）。
    // 注意 sync=true 只表示「入了合并队列」，真正发送在 flush 时；失败会在 readSyncFailed 计。
    return { ok: peer || sync, kind, peer, sync, queued: sync, error };
  }

  /**
   * 撤回消息 —— 必须「双管齐下」，两种方式各管一层（三格对照实验实测）：
   *
   *   ① 只调 SDK 原生 recallMessage → 服务端数据被删，但**客户端仍显示原文**
   *      （用户看到一条点不开的"幽灵消息"，比不撤还糟）
   *   ② 只发 REVOKE_FLAG cmd → 客户端显示为已撤回，但**服务端数据仍在**
   *      （等于"表面撤回"，getHistoryMessages 仍能查到）
   *   ③ 两者都做 → 服务端已删 + 客户端显示撤回 ✅
   *
   * 注意：学习通渲染层的 isPcRecall / updateStore 是它自己封装的参数，SDK 里不认
   *（全量搜索命中 0 次），不要传。
   *
   * @param {string} mid      被撤回消息的 id（服务端 id，int64 字符串）
   * @param {string} to       群 id 或对方 uid
   * @param {'groupChat'|'singleChat'} chatType
   * @returns {Promise<{ok:boolean, notify?:{ok:boolean,error?:string}, error?:string}>}
   *          ok 以「服务端是否删除成功」为准（它决定撤回是否真正生效）
   */
  async recall(mid, to, chatType) {
    if (!this.conn) throw new Error('not connected');

    // ① 删除服务端数据
    let server = { ok: false };
    try {
      const r = await this.conn.recallMessage({ mid: String(mid), to: String(to), chatType });
      server = { ok: true, data: r };
    } catch (e) {
      server = { ok: false, error: (e && e.message) || String(e) };
      this._noteRisk(server.error, '撤回');
    }
    // ② 通知客户端标记为已撤回（cmd 的 localMsgId 即被撤回消息的 id）
    let notify = { ok: false };
    try {
      await this.conn.sendMsg({
        action: 'REVOKE_FLAG',
        chatType,
        ext: { msgId: String(mid) },
        from: String(this.myUid || ''),
        id: String(mid),
        onlineState: 1,
        time: Date.now(),
        to: String(to),
        type: 'cmd',
      });
      notify = { ok: true };
    } catch (e) {
      notify = { ok: false, error: (e && e.message) || String(e) };
      this._noteRisk(notify.error, '撤回通知');
      console.error('[im] 撤回通知 cmd 发送失败:', notify.error);
    }
    if (server.ok) this.stats.sent++;
    else this.stats.sendFailed++;
    return { ...server, notify };
  }

  /**
   * 识别风控/限制类错误并计数 + 告警（不改变行为，只是让问题可见）
   * 环信侧的限流、禁言、权限相关错误都会命中。
   * @private
   */
  _noteRisk(errMsg, what) {
    if (!errMsg) return;
    const RISK = /limit|muted|forbidden|permission|denied|too many|flood|blocked|frequency/i;
    if (!RISK.test(String(errMsg))) return;
    this.stats.riskWarnings = (this.stats.riskWarnings || 0) + 1;
    console.error(`[im] ⚠️ ${what} 收到疑似风控/限制响应（累计 ${this.stats.riskWarnings} 次）: ${errMsg}`);
  }

  /**
   * 发送语音消息（群/私聊）。
   *
   * 学习通聊天语音走的是**环信原生 audio 消息**（实测原始结构：
   * `{type:'audio', url:chatfiles地址, secret, filename:*.amr, length:秒, file_length:字节}`），
   * 与图片同为 chatfiles 上传机制，因此这里复用同一套 upload-then-send 流程。
   *
   * ⚠️ 学习通使用 **AMR**（8kHz）格式。本方法**不转码**——翻译层不替调用方转换格式，
   * 传进来的字节原样发出；若调用方给出的是 mp3/wav/silk，需自行转成 amr。
   *
   * @param {'groupChat'|'singleChat'} chatType
   * @param {string} to
   * @param {Buffer} buf 音频字节（期望 amr）
   * @param {{filename?:string, duration?:number, fromPuid?:string|number}} [opts]
   *   duration: 时长（秒），客户端据此显示语音条长度
   * @returns {Promise<{ok:boolean, msgId?:string, url?:string, error?:string}>}
   */
  async sendAudio(chatType, to, buf, opts = {}) {
    if (!this.conn) throw new Error('not connected');
    if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: '音频数据为空' };
    const W = sdk();
    const mime = opts.mime || 'audio/amr';
    const filename = opts.filename || `voice_${Date.now()}.amr`;
    const duration = Number(opts.duration) || 1;

    const ext = {};
    const puid = opts.fromPuid ?? this.puid;
    if (puid != null) ext.fromPuid = String(puid);

    const body = W.message.create({
      type: 'audio',
      chatType,
      to: String(to),
      file: { data: new Blob([buf], { type: mime }), filename, filetype: mime },
      length: duration,          // 实测接收侧字段名为 length（秒）
      ext,
      onFileUploadError: (e) => console.error('[im] 语音上传失败:', e && (e.message || JSON.stringify(e).slice(0, 200))),
      onFileUploadProgress: () => {},
      onFileUploadComplete: () => {},
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        if (r.ok) {
          this.stats.sent++;
          this._reportSelf({
            type: 'audio', chatType, to, text: '', atUids: [],
            msgId: r.msgId,
            image: r.url ? { url: r.url, thumb: r.url, filename, filetype: mime, size: buf.length, width: 0, height: 0 } : null,
          });
        } else {
          this.stats.sendFailed++;
        }
        resolve(r);
      };
      try {
        this.conn.send(body).then(
          (ok) => {
            const m = (ok && ok.message) || {};
            finish({
              ok: true,
              msgId: ok && ok.serverMsgId ? ok.serverMsgId : ok && ok.data ? ok.data.id : undefined,
              url: m.url || (body.body && body.body.url) || undefined,
            });
          },
          (err) => finish({ ok: false, error: (err && err.message) || 'send rejected' })
        );
      } catch (e) {
        finish({ ok: false, error: e.message });
      }
      setTimeout(() => finish({ ok: false, error: '语音发送超时(60s)' }), 60000);
    });
  }

  /**
   * 发送图片消息（群/私聊）。SDK 会自动完成：
   *   1. POST {apiUrl}/{org}/{app}/chatfiles   (FormData: file=<blob>)
   *   2. 得到 url = .../chatfiles/{uuid}?em-redirect=true&share-secret=xxx
   *   3. 以 img 类型消息发出（带 size/thumb）
   * @param {'groupChat'|'singleChat'} chatType
   * @param {string} to
   * @param {Buffer} buf 图片二进制
   * @param {{filename?:string, width?:number, height?:number, fromPuid?:string|number}} [opts]
   * @returns {Promise<{ok:boolean, msgId?:string, url?:string, error?:string}>}
   */
  async sendImage(chatType, to, buf, opts = {}) {
    if (!this.conn) throw new Error('not connected');
    if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: '图片数据为空' };
    const W = sdk();

    // 尺寸：优先用调用方提供，否则解析文件头
    let width = opts.width, height = opts.height, mime = 'image/png';
    try {
      const { imageSize } = require('./imageSize');
      const info = imageSize(buf);
      if (info) {
        if (!width) width = info.width;
        if (!height) height = info.height;
        mime = info.type || mime;
      }
    } catch (_) {}
    const filename = opts.filename || `image_${Date.now()}.${(mime.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;

    const ext = {};
    const puid = opts.fromPuid ?? this.puid;
    if (puid != null) ext.fromPuid = String(puid);

    // 参照官方前端 createOptions 的 IMAGE 分支：file 交给 SDK 上传，回调里自动发消息
    const body = W.message.create({
      type: 'img',
      chatType,
      to: String(to),
      file: { data: new Blob([buf], { type: mime }), filename, filetype: mime },
      width: width || 0,
      height: height || 0,
      ext,
      onFileUploadError: (e) => console.error('[im] 图片上传失败:', e && (e.message || JSON.stringify(e).slice(0, 200))),
      onFileUploadProgress: () => {},
      onFileUploadComplete: () => {},
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        if (r.ok) {
          this.stats.sent++;
          this._reportSelf({
            type: 'img', chatType, to, text: '', atUids: opts.atUids || [], msgId: r.msgId,
            image: r.url ? { url: r.url, thumb: r.url, filename, filetype: mime, size: buf.length, width: width || 0, height: height || 0 } : null,
          });
        } else {
          this.stats.sendFailed++;
        }
        resolve(r);
      };
      try {
        this.conn.send(body).then(
          (ok) => {
            const m = (ok && ok.message) || {};
            finish({
              ok: true,
              msgId: ok && ok.serverMsgId ? ok.serverMsgId : ok && ok.data ? ok.data.id : undefined,
              url: m.url || (body.body && body.body.url) || undefined,
            });
          },
          (err) => finish({ ok: false, error: (err && err.message) || 'send rejected' })
        );
      } catch (e) {
        finish({ ok: false, error: e.message });
      }
      // 上传+发送有网络耗时，给 60s 上限
      setTimeout(() => finish({ ok: false, error: '图片发送超时(60s)' }), 60000);
    });
  }

  /**
   * 注册消息回调（群聊 + 私聊都会收到，msg.chatType 区分）
   * @param {(msg:any)=>void} cb
   */
  onMessage(cb) { this.msgCbs.push(cb); }

  /**
   * 兼容别名：只收群聊消息
   */
  onGroupMessage(cb) {
    this.msgCbs.push((m) => { if (m && m.chatType === 'groupChat') cb(m); });
  }

  async disconnect() {
    if (this.handler && this.conn) this.conn.removeEventHandler(HANDLER_ID);
    if (this.conn) { try { this.conn.close(); } catch (_) {} }
    this.conn = null;
  }
}

module.exports = { CxImClient, bareId };
