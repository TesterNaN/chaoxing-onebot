#!/usr/bin/env node
// ============================================================================
// 学习通 → OneBot v11 适配器入口
// ----------------------------------------------------------------------------
// 启动流程（与 bot.js 一致）：
//   1. 凭据自检（cookie + hxToken）
//   2. 无效 → 自动二维码登录（终端出码）
//   3. 连接学习通环信通道
//   4. 启动 OneBot v11 服务（正向 WS / 反向 WS）
//   5. 学习通消息 → OneBot 事件；OneBot API → 学习通发送
//
// 用法：
//   node onebot.js                  # 按 config.json 的 onebot 配置启动
//   node onebot.js --ws-port=6700   # 覆盖正向 WS 端口
//
// config.json 中 onebot 段示例：
//   "onebot": {
//     "accessToken": "",                    // 鉴权 token（可空）
//     "wsHost": "127.0.0.1", "wsPort": 6700,// 正向 WS
//     "reverseWsUrl": "ws://127.0.0.1:8080/onebot/v11/ws",  // 反向 WS（NoneBot2）
//     "heartbeatInterval": 5000
//   }
// ============================================================================
const path = require('path');
const { qrLogin, loadOrCreate } = require('./src/login');
const { resolveImInfo } = require('./src/resolveIm');
const { CxImClient } = require('./src/imClient');
const { createProfileResolver, resolveProfileSource } = require('./src/cxProfile');
const { createGroupCardResolver } = require('./src/cxGroupCard');
const { createCloudDiskUploader, resolveDownloadMode } = require('./src/cxCloudDisk');
const { DedupCache } = require('./src/dedup');
const { makeStartupFilter } = require('./src/startupFilter');
const { OneBotV11 } = require('./src/onebot');

async function main() {
  // 「只处理启动后的事件」的基准时刻：取**进程启动**（含可能的扫码登录耗时），
  // 不是取连接成功时刻——否则离线补发的旧消息会被算成"启动后"。
  const processStartedAt = Date.now();
  const args = process.argv.slice(2);
  const argOf = (name) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : undefined;
  };

  let cfg = loadOrCreate();
  const obCfg = cfg.onebot || {};
  if (argOf('ws-port')) obCfg.wsPort = Number(argOf('ws-port'));
  if (argOf('reverse-ws')) obCfg.reverseWsUrl = argOf('reverse-ws');

  // ---- 1) 凭据自检 ----
  console.log('== 凭据自检 ==');
  const usable = (cfg.cookie || '').length > 30 && (cfg.hxToken || '').length > 20;
  if (!usable) {
    console.log('无有效凭据，进入二维码登录...');
    await qrLogin();
    cfg = loadOrCreate();
  } else {
    console.log('已有 cookie + hxToken，尝试直连');
    // ⚠️ 光看长度不够 —— cookie 会过期/被顶，那时"直连"起来云盘和昵称都会一路报错，
    // 用户看到一堆莫名其妙的失败而不是一句"登录失效了"。所以启动时真探一次
    // （云盘 token 接口，一个只读请求，成本最低）。
    const { resolveCookieInvalidAction, checkCookie, decideStartupAction } = require('./src/credCheck');
    const act = resolveCookieInvalidAction(obCfg);
    if (act.error) { console.error(`❌ ${act.error}`); process.exit(1); }
    const chk = await checkCookie(cfg.cookie, { timeoutMs: obCfg.cookieCheckTimeoutMs });
    if (!chk.ok) {
      const dec = decideStartupAction({
        cookieOk: false, action: act.action, isTTY: process.stdout.isTTY === true,
      });
      console.warn('');
      console.warn('⚠️ ================ cookie 已失效 ================');
      console.warn(`   探测结果：${chk.reason}`);
      console.warn('   影响：昵称解析、云盘（发文件/视频）、取直链、get_file 都会失效；');
      console.warn('         消息收发仍然正常（那条路只靠 hxToken）。');
      console.warn(`   处置：${dec.why}`);
      console.warn('   手动刷新：node src/login.js qr   （扫码后 cookie + hxToken 一起写回 config.json）');
      console.warn('================================================');
      if (dec.action === 'exit') { process.exit(2); }
      if (dec.action === 'qr') {
        console.log('进入二维码登录（扫完自动继续启动）...');
        await qrLogin();
        cfg = loadOrCreate();
        const again = await checkCookie(cfg.cookie, { timeoutMs: obCfg.cookieCheckTimeoutMs });
        if (!again.ok) {
          console.warn(`⚠️ 扫码后复检仍不通过（${again.reason}）—— 先用 hxToken 继续跑，云盘相关功能仍不可用`);
        } else {
          console.log('✅ cookie 已恢复，云盘/昵称功能可用');
        }
      }
      // action === 'warn'：不阻塞，用 hxToken 继续跑（降级模式）
    } else {
      console.log('✅ cookie 有效（云盘/昵称功能可用）');
    }
  }

  // ---- 1.5) 连接方式（前移到这里：配置填错就立即失败，不必等连上学习通）----
  // 显式 mode 优先；缺省时按旧逻辑推断（配了 reverseWsUrl 就反向、wsPort!==0 就正向）
  //   forward = 本适配器监听，框架来连（NoneBot2 常见）
  //   reverse = 本适配器主动连框架（AstrBot 的 aiocqhttp 默认）
  //   both    = 两种都开
  const mode = String(obCfg.mode || '').toLowerCase();
  let wantForward; let wantReverse;
  if (mode === 'forward') { wantForward = true; wantReverse = false; }
  else if (mode === 'reverse') { wantForward = false; wantReverse = true; }
  else if (mode === 'both') { wantForward = true; wantReverse = true; }
  else if (mode === '') { wantForward = obCfg.wsPort !== 0; wantReverse = !!obCfg.reverseWsUrl; }
  else {
    console.error(`❌ onebot.mode 取值非法: "${obCfg.mode}"（应为 forward / reverse / both）`);
    process.exit(1);
  }
  // 选了某种方式却没配好参数 → 明确报错，而不是静默不启动
  if (wantForward && !obCfg.wsPort) {
    console.error('❌ mode=forward 需要 onebot.wsPort 为有效端口（当前为 0/未设置）');
    process.exit(1);
  }
  if (wantReverse && !obCfg.reverseWsUrl) {
    console.error('❌ mode=reverse 需要 onebot.reverseWsUrl（例如 ws://127.0.0.1:6199/ws）');
    process.exit(1);
  }
  // ---- 2) 连接（失败自动重扫） ----
  // 稳定性相关配置（口径见 README「五、稳定性内核」）
  // 注意：适配器不决定「要不要补发」——离线消息照常上报，是否响应由插件按事件的
  // 标准 time 字段自行判断——适配器不过滤任何消息。
  const stabilityOpts = {
    reportMultiDeviceSelf: obCfg.reportMultiDeviceSelf,     // 多端回声是否上抛到 self 通道
    dedup: obCfg.dedup,                                     // 去重表容量/TTL
  };
  // ---- 资料补充方案（onebot.profileSource）----
  // none（默认）/ web / pc：三个值都只影响"资料来自哪"，与消息收发无关。
  // 鉴权本来就是同一套（cookie 为根：网页端和 PC 客户端都用它换 hxToken，并用 hxToken 连同一个环信 WS）。
  // 所以"选方案"能选的只有**资料来自哪**：
  //   none（默认）→ 只用环信 SDK，与 PC 客户端完全一致；uid 就是昵称
  //   web         → 额外用网页端私有 HTTP 接口（im.chaoxing.com/webim/*）把 uid 补成真实姓名
  // 注意：web 方案依赖 cookie 新鲜度（只读、带缓存、失败一律回落 uid，不影响消息收发）。
  const ps = resolveProfileSource(obCfg);
  if (ps.error) {
    console.error(`❌ ${ps.error}`);
    process.exit(1);
  }
  // 群事件去重表：放在启动器层，跨重登存活（relogin 会重建 client，
  // 表若跟着实例走，重连后的离线补发会把同一批群事件再发一遍）
  const noticeDedup = new DedupCache(obCfg.dedup || {});
  const profile = ps.source !== 'none'
    ? createProfileResolver({
      cookie: cfg.cookie || '',
      source: ps.source,                                    // web：网页端（单个查询）
      puid: cfg.puid || '',                                 // pc：签名身份参数（必须 puid）
      tuid: cfg.tuid || '',                                 // pc：用它查自己资料
      ttlMs: obCfg.profileCacheTtlMs,
      maxSize: obCfg.profileCacheMax,
      batchSize: obCfg.profileBatchSize,
    })
    : null;
  let client = null;
  // 群名片（contact type=group）：码的值走 addcg 落地页（只读免登录），
  // 码"能不能用"只能看群详情里的 showQRCode —— 而 description 只有 IM SDK 读得到。
  const groupCard = createGroupCardResolver({
    cookie: cfg.cookie || '',
    timeoutMs: obCfg.groupCardTimeoutMs,
    // client 在下面才创建、重登时还会被替换，所以这里用闭包变量延迟取
    fetchGroupDescription: async (gid) => {
      if (!client) return null;
      const d = await client.conn.getGroupInfo({ groupId: String(gid) })
        .then((r) => { const x = r && r.data; return Array.isArray(x) ? x[0] : x; })
        .catch(() => null);
      return d ? d.description : null;
    },
  });
  // 云盘上传（file → att_clouddisk 18 / video → att_video 29）。
  // 必须先上传云盘：easemob 原生 file/video 消息客户端不渲染（实测显示「暂不支持该类型」）。
  // 取直链有两条路（onebot.cloudDiskDownload，默认 api）：
  //   api  = pan-yz 的 /api/getDownloadUrl 系（要 pan token；普通端点取自己的/别人的都行，
  //          share 端点 + sarepuid 只作兜底）
  //   page = appid 签名换资源详情页再解析 fileinfo.download（不要 token / 不要 owner puid，但要 PC UA）
  //   auto = 先 api，失败回退 page（两条依赖不同，互备）
  const dlm = resolveDownloadMode(obCfg);
  if (dlm.error) { console.error(`❌ ${dlm.error}`); process.exit(1); }
  const cloudDisk = createCloudDiskUploader({
    cookie: cfg.cookie || '',
    puid: cfg.puid || '',
    downloadMode: dlm.mode,
  });
  console.log(`[clouddisk] 取直链方式: ${dlm.mode}`);
  const makeClient = (info) => new CxImClient({
    appKey: cfg.appKey,
    puid: cfg.puid || info.puid,
    profile,                                                // 昵称解析（热路径异步补全）
    noticeDedup,                                            // 群事件幂等（跨重登存活）
    ...stabilityOpts,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const info = await resolveImInfo(cfg);
      client = makeClient(info);
      await client.connect({ hxToken: info.hxToken, tuid: info.tuid });
      console.log('✅ 学习通连接成功');
      break;
    } catch (e) {
      console.log('连接失败:', e.message);
      if (attempt >= 2) throw e;
      console.log('== 进入二维码登录 ==');
      await qrLogin();
      cfg = loadOrCreate();
    }
  }

  const myUid = String(cfg.tuid || 0);
  const myNick = cfg.nickname || cfg.name || `cxstudy_${myUid}`;
  obCfg.selfId = myUid;

  // ---- 3) 桥接对象（OneBot ↔ 学习通） ----
  const groupCache = new Map();
  let lastMessageAt = 0;   // 最近一次收到消息的时间（health 用）
  const bridge = {
    async getSelfInfo() {
      // 只有在开启 profileEnrich 时才去网页端接口要真实姓名，否则保持原样（uid 形态）
      let nick = myNick;
      if (profile) {
        try {
          const u = await profile.loginUser();
          if (u && u.name) nick = u.name;
        } catch (_) { /* 忽略，回落 */ }
      }
      return { user_id: Number(myUid) || 0, nickname: nick };
    },
    async sendText(chatType, to, text, opts = {}) {
      return client.sendText(chatType, to, text, opts);
    },
    async sendImage(chatType, to, buf, opts = {}) {
      return client.sendImage(chatType, to, buf, opts);
    },
    async sendAudio(chatType, to, buf, opts = {}) {
      return client.sendAudio(chatType, to, buf, opts);
    },
    /**
     * 文件（v11 file 段）→ 先上传学习通云盘，再发一条 txt 消息带 `att_clouddisk`(18)。
     *
     * ⚠️ 不能发 easemob 原生的 `file` 消息：客户端不渲染，实测显示
     * 「[暂不支持该类型…]」。学习通的富内容一律是
     * 「txt 消息 + ext.attachment」。
     */
    async sendFile(chatType, to, f) {
      try {
        // f.path（大文件走流式，不占内存）或 f.buf（内联小文件）都支持
        const r = await cloudDisk.uploadAsFile(f.path || f.buf, f.name);
        // 文本照官方：附件消息的正文就是 `[文件]`（实测真实客户端发出来的就是这三个字，不带文件名）
        return await client.sendText(chatType, String(to), '[文件]', {
          attachment: r.attachment,
        });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /**
     * 视频（v11 video 段）→ 上传云盘 + 发 txt 带 `att_video`(29)。
     * 时长由协议层用 ffmpeg 探好后传进来（云盘返回的 duration 恒为 0）；
     * 封面用云盘自动生成的 thumbnail（实测视频上传后会返回 `…/thumbnail/v2/origin/<objectId>?type=video`）。
     */
    async sendVideo(chatType, to, v) {
      try {
        const r = await cloudDisk.uploadAsVideo(v.path || v.buf, v.name, {
          duration: v.duration, width: v.width, height: v.height,
        });
        return await client.sendText(chatType, String(to), '[视频]', {
          attachment: r.attachment,
        });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /**
     * 链接分享（v11 share 段）→ 学习通的 att_web（attachmentType 25）。
     * 它本质就是一条 txt 消息带 ext.attachment，所以完全走 sendText，不需要新机制。
     */
    async sendShare(chatType, to, sh) {
      try {
        const web = {
          title: String((sh && sh.title) || (sh && sh.url) || ''),
          url: String((sh && sh.url) || ''),
          logo: String((sh && sh.image) || ''),
          showContent: 1,
        };
        if (sh && sh.content) web.content = String(sh.content);
        return await client.sendText(chatType, String(to), web.title, {
          attachment: { attachmentType: 25, att_web: web },
        });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /**
     * 个人名片（v11 contact 段，type=qq）→ 学习通的 att_user（attachmentType 20）。
     *
     * ⚠️ 这里依赖 profileSource：插件给的是账号 id（uid 或 puid），而名片要的是
     * {puid, name, pic}。解析不出来就**明确报错**，不发明信片。
     */
    async sendContact(chatType, to, ct) {
      if (!profile) {
        return {
          ok: false,
          error: '发送个人名片需要把账号 id 解析成 puid/姓名/头像：需将 onebot.profileSource 设为 "pc"（推荐）或 "web"',
        };
      }
      try {
        const id = String((ct && ct.id) || '');
        let u = await profile.userInfo(id);              // 先按 uid（tuid）查
        if (!u) u = await profile.userInfoByPuid(id);     // 再按 puid 查（收到名片时上报的就是 puid）
        if (!u) return { ok: false, error: `找不到账号 ${id} 的资料（uid / puid 都试过），无法生成名片` };
        const att = {
          attachmentType: 20,
          att_user: { name: u.name || '', puid: u.puid, pic: u.pic || '' },
        };
        return await client.sendText(chatType, String(to), `[个人名片]${u.name || ''}`, { attachment: att });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /**
     * 群名片（v11 contact 段，type=group）→ 学习通的 att_chat_group（attachmentType 23）。
     *
     * 邀请码是**现取**的：GET learn.chaoxing.com/im/addcg?cgid=<群id> 是「加入群聊」落地页，
     * 服务端把该群当前有效的邀请码渲染成页面里的 `var inviteCode = "..."`——
     * 空串就代表"现在没有可用邀请码"，这种情况明确报错，不发一张点不开的卡片。
     * 全程只读，不碰 createChatGroupIncode（那是写接口，会开启邀请码）。
     */
    async sendGroupContact(chatType, to, ct) {
      const gid = String((ct && ct.id) || '').trim();
      const r = await groupCard.resolve(gid);
      if (!r.ok) return { ok: false, error: r.error };
      try {
        return await client.sendText(chatType, String(to), `[群名片]${r.groupName || ''}`, {
          attachment: r.attachment,
        });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /**
     * 云盘资源号 → 可直接下载的直链。
     * `sharePuid` 优先用附件体里的 `ext.fromPuid`；官方客户端的消息常不带它，
     * 这时按发送者 uid 反查 puid（需要 profileSource）。查不到就按"自己云盘"试。
     */
    async resolveCloudUrl({ resid, objectId, sharePuid, fromUid } = {}) {
      try {
        let owner = sharePuid != null && sharePuid !== '' ? String(sharePuid) : '';
        if (!owner && fromUid && profile) {
          const u = await profile.userInfo(String(fromUid));
          if (u && u.puid) owner = String(u.puid);
        }
        return await cloudDisk.resolveDownloadUrl({ resid, objectId, sharePuid: owner });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    async listGroups() {
      try {
        const r = await client.conn.getJoinedGroups({ pageNum: 1, pageSize: 100 });
        const data = (r && r.data) || [];
        groupCache.clear();
        for (const g of data) groupCache.set(String(g.groupid), g);
        return data;
      } catch (e) {
        console.error('[bridge] getJoinedGroups 失败:', e.message);
        return [];
      }
    },
    async listGroupMembers(gid) {
      try {
        const r = await client.conn.listGroupMembers({ groupId: String(gid), pageNum: 1, pageSize: 1000 });
        const list = (r && r.data) || [];
        // SDK 只给 uid；开启 profileEnrich 时才去网页端接口补昵称
        // （并发受限、失败回落 uid，不影响成员列表本身）
        const uids = profile ? list.map((m) => String((m && (m.member || m.owner)) || '')).filter(Boolean) : [];
        if (uids.length) {
          try {
            const names = await profile.namesOf(uids, { concurrency: 8 });
            for (const m of list) {
              const uid = String((m && (m.member || m.owner)) || '');
              const nm = names[uid];
              if (nm) m.name = nm;
            }
          } catch (e) {
            console.error('[bridge] 昵称补全失败（不影响成员列表）:', e.message);
          }
        }
        return list;
      } catch (e) {
        console.error('[bridge] listGroupMembers 失败:', e.message);
        return [];
      }
    },

    // ---- 群管理：统一把 SDK 的返回/异常收敛成 {ok, error} ----
    // 注意 SDK 的参数名是 username（单数），不是 usernames
    _mgmt(name, fn) {
      return async (...args) => {
        try {
          const r = await fn(...args);
          return { ok: true, data: r };
        } catch (e) {
          const msg = (e && (e.message || e.error_description)) || String(e);
          console.error(`[bridge] ${name} 失败:`, msg);
          return { ok: false, error: msg };
        }
      };
    },
    getGroupInfo(gid) {
      // SDK 返回 data 为数组，取第一条
      return client.conn.getGroupInfo({ groupId: String(gid) }).then((r) => {
        const d = r && r.data;
        return Array.isArray(d) ? d[0] : d;
      }).catch((e) => {
        console.error('[bridge] getGroupInfo 失败:', e.message);
        return null;
      });
    },
    muteGroupMember(gid, uid, durationMs) {
      return this._mgmt('muteGroupMember', () => client.conn.muteGroupMember({ groupId: String(gid), username: String(uid), muteDuration: durationMs }))();
    },
    unmuteGroupMember(gid, uid) {
      return this._mgmt('unmuteGroupMember', () => client.conn.unmuteGroupMember({ groupId: String(gid), username: String(uid) }))();
    },
    disableSendGroupMsg(gid) {
      return this._mgmt('disableSendGroupMsg', () => client.conn.disableSendGroupMsg({ groupId: String(gid) }))();
    },
    enableSendGroupMsg(gid) {
      return this._mgmt('enableSendGroupMsg', () => client.conn.enableSendGroupMsg({ groupId: String(gid) }))();
    },
    removeGroupMember(gid, uid) {
      return this._mgmt('removeSingleGroupMember', () => client.conn.removeSingleGroupMember({ groupId: String(gid), username: String(uid) }))();
    },
    setGroupAdmin(gid, uid) {
      return this._mgmt('setGroupAdmin', () => client.conn.setGroupAdmin({ groupId: String(gid), username: String(uid) }))();
    },
    removeGroupAdmin(gid, uid) {
      return this._mgmt('removeGroupAdmin', () => client.conn.removeGroupAdmin({ groupId: String(gid), username: String(uid) }))();
    },
    setGroupMemberAttributes(gid, uid, attrs) {
      return this._mgmt('setGroupMemberAttributes', () => client.conn.setGroupMemberAttributes({ groupId: String(gid), userId: String(uid), memberAttributes: attrs }))();
    },
    setGroupName(gid, name) {
      return this._mgmt('modifyGroup', () => client.conn.modifyGroup({ groupId: String(gid), groupName: String(name) }))();
    },
    leaveGroup(gid) {
      return this._mgmt('leaveGroup', () => client.conn.leaveGroup({ groupId: String(gid) }))();
    },
    async recallMessage({ mid, to, chatType }) {
      // 双管齐下逻辑在通道层（src/imClient.js 的 recall）：删服务端数据 + 通知客户端标记
      return client.recall(mid, to, chatType);
    },
    /**
     * 取回单条消息（供 get_msg 用）：借 getHistoryMessages 拉会话历史后按 mid 匹配。
     * 实测群聊与单聊都支持：chatType 传 'groupChat' / 'singleChat'，targetId 传群id/对方uid。
     */
    async getMessage({ mid, to, chatType }) {
      try {
        // searchDirection:'up' 与官方客户端一致（客户端源码同款参数）。
        // 不给这个参数时，SDK 返回的是**未含刚发出消息**的本地缓存页——实测 3 轮只有 1 轮命中；
        // 给上之后 3/3 命中，刚发出的消息恒在首位。
        const r = await client.conn.getHistoryMessages({
          targetId: String(to), chatType, pageSize: 50, searchDirection: 'up',
        });
        const msgs = (r && (r.messages || r.data)) || [];
        return msgs.find((m) => String(m.id) === String(mid)) || null;
      } catch (e) {
        console.error('[bridge] getHistoryMessages 失败:', e.message);
        return null;
      }
    },
    async getImage(file) {
      try {
        const { downloadImage } = require('./src/imageSource');
        // 插件可能回传本实现给出过的本地路径，直接复用
        if (!/^https?:\/\//i.test(file) && require('fs').existsSync(file)) {
          return { ok: true, path: require('path').resolve(file), cached: true };
        }
        const r = await downloadImage(file, { cacheDir: obCfg.imageCacheDir });
        return { ok: true, ...r };
      } catch (e) {
        console.error('[bridge] getImage 失败:', e.message);
        return { ok: false, error: e.message };
      }
    },
    /**
     * `get_file` 用：把远程文件**流式**存到本地并返回路径。
     * 与 getImage 的区别：不校验图片格式、不套 20MB 图片上限、走文件缓存目录。
     */
    async getFile(file) {
      try {
        const { fetchFileToCache } = require('./src/imageSource');
        // 插件可能回传本实现给出过的本地路径，直接复用
        if (!/^https?:\/\//i.test(file) && require('fs').existsSync(file)) {
          const p = require('path').resolve(file);
          return { ok: true, path: p, bytes: require('fs').statSync(p).size, cached: true };
        }
        const r = await fetchFileToCache(file, { cacheDir: obCfg.fileCacheDir });
        return { ok: true, ...r };
      } catch (e) {
        console.error('[bridge] getFile 失败:', e.message);
        return { ok: false, error: e.message };
      }
    },
    async cleanImageCache() {
      try {
        // 图片缓存与文件缓存一起清（clean_cache 的语义就是"把缓存清掉"）
        const { cleanImageCache, cleanFileCache } = require('./src/imageSource');
        const removed = cleanImageCache(obCfg.imageCacheDir) + cleanFileCache(obCfg.fileCacheDir);
        return { ok: true, removed };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /**
     * set_restart 能不能做、由谁拉起新进程
     *
     * 优先级：有父进程（node supervisor.js fork 出来的）→ 交给父进程；
     * 否则看 onebot.restart：self=自己 re-exec，supervisor=外部守护（systemd/pm2/docker），
     * off=明确不支持。默认 auto：没有父进程时**不猜**，直接回 102 并说明怎么办。
     */
    restartPlan() {
      const mode = String(obCfg.restart || 'auto').toLowerCase();
      if (mode === 'off') return { ok: false, reason: 'onebot.restart 设为 off（有意关闭）' };
      if (typeof process.send === 'function') return { ok: true, via: 'parent' };
      if (mode === 'self') return { ok: true, via: 'self' };
      if (mode === 'supervisor') return { ok: true, via: 'supervisor' };
      return {
        ok: false,
        reason: '当前是独立运行（没有父进程守护）。需使用 node supervisor.js 启动，'
          + '或把 onebot.restart 设为 "self"（自己重启）或 "supervisor"（靠 systemd/pm2/docker 拉起）',
      };
    },
    /**
     * 真正执行重启。顺序很重要：
     *   ① delay 毫秒（规范参数，给响应落地的时间）
     *   ② 优雅断开学习通 —— **必须先断开**，否则新进程连上会互踢
     *   ③ 按方式退出 / 通知父进程
     */
    async performRestart(delayMs = 0) {
      const plan = bridge.restartPlan();
      console.log(`[restart] 开始重启（方式：${plan.via}，delay=${delayMs}ms）`);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try { await client.flushReadSyncs(); } catch (_) {}
      try { if (client.isOpened && client.isOpened()) await client.disconnect(); } catch (_) {}
      console.log('[restart] 学习通连接已断开，交棒');
      if (plan.via === 'parent') {
        try { process.send({ type: 'restart' }); } catch (_) {}
        setTimeout(() => process.exit(0), 200);
        return;
      }
      if (plan.via === 'self') {
        const { spawn } = require('child_process');
        const c = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(), detached: true, stdio: 'ignore',   // 脱离父终端，日志另存
        });
        c.unref();
        setTimeout(() => process.exit(0), 200);
        return;
      }
      // 外部守护：退出即可（非 0 退出码便于 Restart=on-failure 生效）
      setTimeout(() => process.exit(1), 200);
    },
    /** 连接健康 + 运行计数（心跳与 get_status 都用它） */
    async health() {
      const s = client.stats || {};
      return {
        online: client.isOpened(),
        connected: client.isOpened(),
        received: s.received || 0,
        selfIn: s.selfIn || 0,
        selfOut: s.selfOut || 0,
        sent: s.sent || 0,
        sendFailed: s.sendFailed || 0,
        dedupDropped: s.dedupDropped || 0,
        idMissing: s.idMissing || 0,
        reconnects: s.reconnects || 0,
        dedupSize: client.dedup ? client.dedup.size : 0,
        lastMessageAt: lastMessageAt || 0,
      };
    },
  };

  // ---- 4) 启动 OneBot ----
  // 运行时域名表（domainMap）：话题/笔记/小组/通知/笔记本/两种文件夹这几类富内容，
  // 附件体里只有 id、地址要用域名现拼（客户端也是这么干的）。取不到就不带，相关附件走文本兜底。
  const { fetchDomainMap } = require('./src/cxDomains');
  const domains = await fetchDomainMap({ cookie: cfg.cookie });
  console.log(domains
    ? `[domains] 域名表已取到：${Object.keys(domains).map((k) => `${k}=${domains[k]}`).join(' ')}`
    : '[domains] ⚠️ 未取到运行时域名表（话题/笔记/小组/通知等附件将退化为文本兜底，不影响其它功能）');

  const ob = new OneBotV11({ bridge, cfg: { ...obCfg, domains } });

  if (wantReverse) ob.startReverseWs();
  if (wantForward) ob.startWsServer();
  // HTTP 通信方式：与 WS 独立开关（可共存），API 处理走同一个 handleAction
  if (Number(obCfg.httpPort) > 0) ob.startHttpServer();
  ob.startHeartbeat();

  // ---- 5) 学习通消息 → OneBot 事件 ----
  // **默认只上报「启动之后」的事件**：连接时 SDK 会把离线期间的消息补发一遍，
  // 那些都是启动前的旧消息，上报出去会让框架（AI）当新消息再回一次。
  // 想恢复"照常上报、由插件按 time 自行判断"的老行为：onebot.onlyAfterStartup: false。
  const startupFilter = makeStartupFilter({
    enabled: obCfg.onlyAfterStartup !== false,
    startedAt: processStartedAt,
    graceMs: obCfg.startupGraceMs,
  });
  let startupSkipped = 0;
  //
  // 重连会重建 client，所以绑定逻辑抽成函数，重登后必须再调一次。
  const bindHandlers = () => {
    // 探测用：学习通把很多富媒体放在自定义消息的 ext.attachment 里（名片、语音、视频…），
    // 这类消息默认不上报，但每种附件类型首次出现时打印一次结构，便于确认承载方式。
    const seenAttTypes = new Set();
    client.onMessage(async (msg) => {
      if (msg.type === 'cmd' || msg.type === 'custom') {
        if (msg.type === 'custom') {
          const att = (msg.ext && msg.ext.attachment) || null;
          const key = String(att && att.attachmentType);
          if (!seenAttTypes.has(key)) {
            seenAttTypes.add(key);
            console.log(`[probe] custom 消息首次出现 attachmentType=${key}：`,
              JSON.stringify(att || msg.ext).slice(0, 500));
          }
        }
        return;  // 系统类/自定义类不上报
      }
      lastMessageAt = Date.now();
      // 已读回执：让对方看到"已读"（官方客户端同样如此，不发送回执时 →
      // 对方永远停在未读，即使机器人已经回复了）。**不 await**，不让回执拖慢事件上报。
      // 单聊走 easemob 原生 read 消息；群聊按官方条件（ext.showRead == 1）发 CMD_GROUP_MSG_READ。
      // 可用 onebot.markRead: false 关闭。
      if (obCfg.markRead !== false) {
        client.markRead(msg).then((r) => {
          if (!r) return;
          const where = r.kind === 'group' ? '群' + msg.groupId : '私聊' + msg.peerId;
          if (r.peer) console.log(`[read ] 已回执 ${where}`);
          else if (r.sync) console.log(`[read ] 已同步(仅自己) ${where}`);   // 群消息未开 showRead 时只同步自己
          if (r.error) console.error(`[read ] ${where} 回执失败: ${r.error}`);
        }).catch(() => {});
      }
      // 启动前的旧消息：**不回执照发、但不上报**。
      // 回执必须发——否则服务端未读清不掉，每次重连还得把同一批重收一遍。
      if (startupFilter.isPreStartup({ ts: msg.ts, syncing: client.isSyncing() })) {
        startupSkipped++;
        console.log(`[skip ] 启动前的旧消息（已读回执照发、不上报）${msg.isGroup ? '群' + msg.groupId : '私聊' + msg.peerId} ${String(msg.text || msg.type).slice(0, 40)}`);
        return;
      }
      try {
        await ob.pushMessage(msg);
        console.log(`[event] ${msg.isGroup ? '群' + msg.groupId : '私聊' + msg.peerId} ${msg.fromName || msg.fromUid}: ${String(msg.text || msg.type).slice(0, 60)}`);
      } catch (e) {
        console.error('[event] 上报失败:', e.message);
      }
    });

    // 撤回通知 → notice.group_recall / friend_recall
    // （撤回是 cmd 消息，不会走 onMessage，所以单独绑一条回调）
    client.onRecall(async (recall) => {
      try {
        await ob.pushRecall(recall);
        console.log(`[recall] ${recall.isGroup ? '群' + recall.groupId : '私聊' + recall.peerId} `
          + `${recall.isSelfOperator ? '(自己撤回的)' : ''} msgId=${recall.msgId}`);
      } catch (e) {
        console.error('[recall] 上报失败:', e.message);
      }
    });

    // 群事件通知（成员增减 / 管理员变动 / 禁言）→ notice.group_increase / decrease / admin / ban
    // 群事件**不带时间戳**，只能靠"是否在补发窗口内"判断是不是启动前的（窗口内一律跳过）
    client.onNotice(async (n) => {
      if (startupFilter.isPreStartup({ syncing: client.isSyncing() })) {
        console.log(`[skip ] 启动前的群事件 ${n.op}（不上报）`);
        return;
      }
      try {
        await ob.pushNotice(n);
        console.log(`[notice] ${n.op} 群${n.groupId} 发起者${n.actorUid || '-'} 目标${(n.targetUids || []).join(',') || '-'}`);
      } catch (e) {
        console.error('[notice] 上报失败:', e.message);
      }
    });

    // 自己发出的消息：原生 v11 没有对应事件类型，pushMessage 默认会跳过；
    // 只有显式开启 reportSelfMessage 才绑这条回调（作为扩展上报 message_sent）。
    if (obCfg.reportSelfMessage === true) {
      client.onSelfMessage(async (msg) => {
        if (msg.type === 'cmd' || msg.type === 'custom') return;
        try {
          await ob.pushMessage(msg);
        } catch (e) {
          console.error('[sent ] 上报失败:', e.message);
        }
      });
    }
  };
  bindHandlers();

  // ---- 6) 断线 / token 过期自动重登 ----
  let relogging = false;
  let downSince = 0;   // 连接断开时刻（看门狗用）
  const relogin = async (reason) => {
    if (relogging) return;
    relogging = true;
    console.log(`== ${reason}，自动重新登录 ==`);
    try {
      try { await client.disconnect(); } catch (_) {}
      // ⚠️ 先走**不需要人**的那条路：cookie 还有效时，用它换一个新 hxToken 就够。
      // 以前这里是无条件 `await qrLogin()` —— 哪怕 cookie 完好也要人扫码，等于把
      // "hxToken 过期"这件小事变成必须有人值守的故障。只有 cookie 也换不出来才回落到扫码。
      let refreshed = null;
      try {
        const cur = loadOrCreate();
        if (cur.cookie && String(cur.cookie).length > 20) {
          console.log('[im] 用现有 cookie 自动换新 hxToken（不需要扫码）…');
          const { getImToken } = require('./src/imToken');
          const info = await getImToken({ cookie: cur.cookie, url: cur.imTokenUrl });
          if (info && info.hxToken) {
            refreshed = info;
            const next = Object.assign({}, cur, {
              hxToken: info.hxToken,
              hxTokenImportedAt: new Date().toISOString(),
              ...(info.tuid != null ? { tuid: info.tuid } : {}),
              ...(info.puid != null ? { puid: info.puid } : {}),
            });
            require('fs').writeFileSync(require('./src/login').CONFIG_PATH,
              JSON.stringify(next, null, 2) + '\n', 'utf8');
            console.log(`✅ hxToken 已自动刷新（tuid=${next.tuid}），没有打扰任何人`);
          }
        }
      } catch (e) {
        console.log(`[im] cookie 换 hxToken 失败（${e.message}）→ 回落到扫码登录`);
      }
      if (!refreshed) await qrLogin();          // cookie 也没了，只能叫人扫
      cfg = loadOrCreate();
      const info = await resolveImInfo(cfg);
      client = makeClient(info);
      bindHandlers();
      client.onLifecycle({ onTokenExpired: () => relogin('token 过期') });
      await client.connect({ hxToken: info.hxToken, tuid: info.tuid });
      console.log('✅ 重连成功');
    } catch (e) {
      console.error('重登失败:', e.message);
      setTimeout(() => { relogging = false; }, 30000);
      return;
    }
    relogging = false;
  };

  client.onLifecycle({
    onTokenExpired: () => relogin('token 过期'),
    // SDK 自动重连有次数上限（autoReconnectNumMax: 3），超了不会再自己恢复
    onDisconnected: () => { downSince = Date.now(); },
  });

  // ---- 7) 连接看门狗：SDK 自动重连耗尽后兜底 ----
  const downTimeoutMs = obCfg.downTimeoutMs || 60000;
  const watchdog = setInterval(async () => {
    if (client.isOpened()) { downSince = 0; return; }
    if (!downSince) { downSince = Date.now(); console.log('== 连接已断开，等待 SDK 自动重连 =='); return; }
    if (Date.now() - downSince > downTimeoutMs) {
      downSince = Date.now();               // 重置，避免重复触发
      if (client.stats) client.stats.reconnects++;
      await relogin(`断线超过 ${Math.round(downTimeoutMs / 1000)}s`);
    }
  }, 10000);
  if (watchdog.unref) watchdog.unref();

  console.log('\n✅ OneBot v11 适配器已就绪');
  console.log('   连接方式: ' + (mode || '(自动推断)'));
  console.log('   正向 WS : ' + (wantForward ? `ws://${obCfg.wsHost || '127.0.0.1'}:${obCfg.wsPort}  (/api /event /)` : '关闭'));
  console.log('   反向 WS : ' + (wantReverse ? `${obCfg.reverseWsUrl}  (本适配器主动连接)` : '关闭'));
  console.log('   正向 HTTP: ' + (Number(obCfg.httpPort) > 0 ? `http://${obCfg.httpHost || '127.0.0.1'}:${obCfg.httpPort}  (POST /)` : '关闭'));
  console.log('   HTTP 推送: ' + (obCfg.httpPostUrl || '关闭'));
  console.log('   事件范围: ' + (startupFilter.enabled
    ? `仅启动后（补发窗口内、以及早于启动 ${Math.round(startupFilter.graceMs / 1000)}s 的旧事件一律不上报）`
    : '全部（离线补发也上报，由插件按 time 自行判断）'));
  console.log('   资料方案: ' + (profile
    ? ps.source + (ps.source === 'pc'
      ? '（PC 客户端接口：cookie + tokenSign，批量补真实姓名；失败回落 uid）'
      : '（网页端接口：只要 cookie，逐个补真实姓名；失败回落 uid）')
    : 'none（只用环信 SDK，昵称即 uid）'));
  console.log('   self_id : ' + myUid + '   Ctrl+C 退出');

  const shutdown = async () => {
    clearInterval(watchdog);
    // 退出前把待发的已读同步冲出去（合并队列最多攒 readSyncWindowMs）
    try { await client.flushReadSyncs(); } catch (_) {}
    ob.stop();
    try { await client.disconnect(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('启动失败:', e.message); process.exit(1); });
