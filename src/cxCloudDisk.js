'use strict';
/**
 * 学习通云盘上传 —— `file`(att_clouddisk 18) / `video`(att_video 29) 的必经之路
 *
 * 为什么必须走它：**easemob 原生 `file`/`video` 消息客户端不渲染**。
 * 实测发出去后 PC 端显示「[暂不支持该类型…]」，手机端也加载不出来。
 * PC 端气泡渲染器（`index-0fc0d582.js`）只认 TEXT（附件挂在 txt 的 ext.attachment 上）、
 * AUDIO、IMAGE，其余一律落到 `UNSUPPORTED` 那个 span —— 消息类型枚举里有 FILE/VIDEO
 * 不代表能渲染（那枚举是给会话列表预览等别处用的）。
 * 所以文件/视频必须做成「一条 txt 消息 + ext.attachment{18|29}」。
 *
 * 上传流程（算法来自明文包 `@cx/cxcore/dist/main/CloudDiskBaseHelper.js`）：
 *
 *   1) 取 pan token（**只带 cookie，不需要签名**，也跟 hxToken 无关）：
 *        GET https://pan-yz.chaoxing.com/api/token/uservalid
 *        → {"result":true,"_token":"07e168130d3e035eb5d9b01b23c6af21"}
 *
 *   2) 上传（<50MB 单次；≥50MB 官方走 calcFileCRC → initTask → 分片，这里只做单次）：
 *        POST https://pan-yz.chaoxing.com/upload/uploadfile
 *             ?_token=<token>&puid=<puid>&uploadtype=normal&hideFile=true
 *        multipart 字段名 "file"，filename=<文件名>
 *        → {"result":true,"data":{residstr, objectId, name, suffix, size,
 *              thumbnail, preview, extinfo, filetype, isfile, uploadDate, duration, ...}}
 *
 * 实测：视频上传后服务端**会给 thumbnail**（`…/thumbnail/v2/origin/<objectId>?type=video`），
 * 但 `duration` 恒为 0 —— 所以 att_video 的 videoLength 需在本地探测（见 videoMeta.js）。
 */
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAN_HOST = 'pan-yz.chaoxing.com';
const PAN_BASE = `https://${PAN_HOST}`;
const TOKEN_PATH = '/api/token/uservalid';
const UPLOAD_PATH = '/upload/uploadfile';
// 分片上传（官方 CloudDiskBaseHelper 里的那三个接口：calcFileCRC → initTask → 逐片）
const CRC_PATH = '/upload/chunk/calcFileCRC';       // POST，body = 前 512KB + 后 512KB
const INIT_TASK_PATH = '/upload/chunk/initTask';    // GET，返回 fileChunkList
/**
 * 分片上传的下限：**2GB**。
 *
 * ⚠️ 这不是可选项，是服务端强制的 —— 实测拿 82MB 文件打 initTask：
 *   `{"code":-5,"msg":"小于2GB文件禁止使用分片上传!","newCode":200008}`
 * 同一个 82MB 文件走**单次上传**则成功（181s）。
 *
 * ⚠️ PC 客户端自己写的是"≥50MB 就分片"（`uploadFileToCloudDisk` 里 `stat.size < 50*1024*1024`），
 * 那条路现在会被服务端拒 —— 也就是说客户端当前传不了 50MB~2GB 的文件（服务端规则改了、客户端没跟）。
 * 因此按服务端实际规则处理。
 */
const SPLIT_MIN_BYTES = 2 * 1024 * 1024 * 1024;
const CRC_PROBE_BYTES = 512 * 1024;
/**
 * 上传超时按体积放大。
 *
 * 实测：82.2MB 单次上传耗时 **181s**（约 0.46MB/s），而默认超时只有 120s
 * → 首次调用即会因超时被中断。此处按 128KB/s 这一保守速度放宽超时；
 * 小文件仍用默认的 120s 下限，不会拖慢日常小文件。
 */
function uploadTimeoutFor(bytes) {
  return Math.max(DEFAULT_TIMEOUT_MS, Math.ceil(Number(bytes) / (128 * 1024)) * 1000);
}
// 云盘资源 → 直链（三个端点，来自明文包 `CloudDiskHelper.getDownloadUrl`）
const DOWNLOAD_PATH = '/api/getDownloadUrl';                 // 按 fleid(=resid)
const OBJECTID_DOWNLOAD_PATH = '/api/objectid2DownloadUrl';  // 按 objectid(小写)
const SHARE_DOWNLOAD_PATH = '/api/share/downloadUrl';        // 别人云盘里的资源，另带 sarepuid
// 第二条路：换一个「已签名的资源详情页 URL」，页面里的 fileinfo.download 就是直链
const RESOURCE_DETAIL_PATH = '/api/v2/getResourceDetailUrl';
const DEFAULT_TIMEOUT_MS = 120000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
/**
 * PC 客户端的 User-Agent。
 *
 * ⚠️ **只用于 appid 签名那条路**（`/api/v2/getResourceDetailUrl` 等）。
 * 实测：不带客户端标记的普通 UA 会被服务端拒成
 * `{"code":-36,"msg":"参数校验错误, IP 不被允许访问"}` —— **那句"IP 不被允许"是假消息，
 * 真正的门是 UA**（只要 UA 里含 `ChaoXingStudy_…_pc_` 就通过）。
 *
 * ⚠️ **绝不要全局统一换成这个 UA**：实测换成它会让 `learn/apis/service/config`
 * 返回 HTML 错误页、`learn/im/addcg` 变成"信息提示"页。所以只在需要的那一个请求上带。
 */
const PC_CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ChaoXingStudy_4_1.4.2_1_1_1_1_pc_1';
// appid / appKey：硬编码在 PC 客户端 `CloudDiskHelper.js` 里
const PAN_APP_ID = 'CD7DD36F-96B6-47F5-A7A4-4F3449FADD16';
const PAN_APP_KEY = 'B9CC827AA11248DCA35327127EC4D2FE';

/** 取直链的两条路（依赖不同，互备） */
const DOWNLOAD_MODES = ['api', 'page', 'auto'];

/**
 * 解析配置里的取直链方式（纯函数）。
 * 非法值不静默兜底 —— 返回 error 让启动器直接退出，避免"以为切了其实没切"。
 * @returns {{mode:string}|{error:string}}
 */
function resolveDownloadMode(cfg = {}) {
  const raw = cfg.cloudDiskDownload;
  if (raw === undefined || raw === null || raw === '') return { mode: 'api' };   // 默认 api
  const mode = String(raw).toLowerCase();
  if (!DOWNLOAD_MODES.includes(mode)) {
    return { error: `onebot.cloudDiskDownload 取值非法: "${raw}"（应为 api / page / auto）` };
  }
  return { mode };
}

/** 小工具：POST/GET 拿文本（复用 cxProfile 那套解压逻辑） */
function requestText(url, { cookie, method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: cookie || '',
        referer: `${PAN_BASE}/`,
      }, headers),
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
        resolve(text);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

/** 人读体积（官方 `u.formatSize` 也是人读串，客户端直接显示它） */
function formatSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)}MB`;
  return `${(v / 1073741824).toFixed(1)}GB`;
}

/** 官方 createCid 是 UUID v4 */
const createCid = () => crypto.randomUUID();

/**
 * appid 签名：拼出被 md5 的那个字符串（纯函数，便于单测）
 *
 * 照抄 PC 客户端 `CloudDiskHelper.getEncRequestUrlPanYz`：
 *   parms = [appid=…, nonce=…, timestamp=…, ...原 query 的 `key=encodeURI(value)`]
 *   parms.sort() 后 join('#')，再把所有 '=' 换成 '#'，末尾拼 '#<appKey>'
 * @param {string[]} parms 已经是 `key=value` 形式的数组（未排序）
 */
function panSignString(parms) {
  const arr = [...parms];
  arr.sort();
  return arr.join('#').replaceAll('=', '#') + `#${PAN_APP_KEY}`;
}

/**
 * 给 URL 加上 appid/nonce/timestamp/signature（纯函数：nonce / timestamp 可注入，便于单测）
 * @param {string} url
 * @param {{nonce?:string, timestamp?:number}} [opts]
 */
function signPanUrl(url, opts = {}) {
  const nonce = opts.nonce != null ? String(opts.nonce) : Math.random().toString(36).substring(2, 15);
  const timestamp = opts.timestamp != null ? opts.timestamp : Date.now();
  const extra = [`appid=${PAN_APP_ID}`, `nonce=${nonce}`, `timestamp=${timestamp}`];
  // ⚠️ 参与签名的是**原样的 query 文本**，不是解码后的值 —— 官方就是这么拼的。
  // 别用 url.searchParams（它会解码，空格还会变 '+'，再 encodeURI 回来就成了 %20，签名会
  // 静默对不上，而且只在值含特殊字符时才炸）。
  const parms = [];
  const qi = url.indexOf('?');
  if (qi !== -1) {
    for (const kv of url.slice(qi + 1).split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      parms.push(eq === -1 ? `${kv}=` : kv);
    }
  }
  parms.splice(0, 0, ...extra);
  const signature = crypto.createHash('md5').update(panSignString(parms)).digest('hex');
  return `${url}${url.includes('?') ? '&' : '?'}${extra.join('&')}&signature=${signature}`;
}

/**
 * 从资源详情页的 HTML 里抠 `var fileinfo = {...}`（纯函数）
 * 页面里那段内联数据长这样（实测原文）：
 *   var fileinfo = {
 *     'download': 'https://d0.cldisk.com/download/<objectId>?at_=…&ak_=…&ad_=…&fn=…',
 *     'type': '11', 'suffix': 'txt', 'objectId': '…', 'filesize': '66',
 *     'thumbnail': '', 'name': '能力测试.txt', 'puid': '406636731',
 *     'selfFile': 'true', 'id': '…', 'encryptedId': '…', 'creator': '…'
 *   };
 * @returns {{download:string, name:string, size:number, puid:string, selfFile:boolean}|null}
 */
function parseResourceDetail(html) {
  const s = String(html || '');
  const i = s.indexOf('var fileinfo');
  if (i === -1) return null;
  const seg = s.slice(i, i + 2000);
  const pick = (k) => {
    const m = seg.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*['"]([^'"]*)['"]`, 'i'));
    return m ? m[1] : '';
  };
  const download = pick('download');
  if (!download) return null;
  return {
    download,
    name: pick('name'),
    size: Number(pick('filesize')) || 0,
    puid: pick('puid'),
    selfFile: pick('selfFile') === 'true',
  };
}

/**
 * 云盘返回 → `att_clouddisk`(18)（纯函数）
 *
 * 字段名照 PC 端附件工厂 `createAttachment` 那条
 * （`v=({data,file,createFakeMsg})=>({att_clouddisk:{…}, cid, attachmentType:18})`）；
 * 另外把 `downPath` 填成 preview —— 官方网页端工厂
 * （`Go(j)=>({attachmentType:18,att_clouddisk:{downPath:j.preview,fileId:j.objectId,resid:j.residstr,
 *   name:j.name,size:j.size,fileSize:…,suffix:j.suffix,icon:j.thumbnail||""}})`）
 * 与实测里真实客户端发出的消息都是这么填的，两边渲染器读的字段都覆盖到了。
 */
function buildCloudDiskAttachment(d = {}) {
  return {
    attachmentType: 18,
    att_clouddisk: {
      name: d.name || '',
      downPath: d.preview || '',
      suffix: d.suffix || '',
      modtime: Number(d.uploadDate) || Date.now(),
      fileSize: formatSize(d.size),
      size: Number(d.size) || 0,
      isfile: d.isfile !== false,
      objectId: d.objectId || '',
      resid: d.residstr || '',
      fileId: d.objectId || '',
      thumbnail: d.thumbnail || '',
      preview: d.preview || '',
      icon: d.thumbnail || '',
      extinfo: d.extinfo || '',
      filetype: d.filetype || '',
      filePath: '',
      puid: d.puid != null ? String(d.puid) : '',
      parentPath: '',
      duration: Number(d.duration) || 0,
    },
    cid: createCid(),
  };
}

/**
 * 云盘返回 + 视频元数据 → `att_video`(29)（纯函数）
 * 字段名照 PC 端附件工厂：`_=async({data,file,createFakeMsg})=>({att_video:{…}, attachmentType:29})`
 * 注意官方这个工厂**不加 cid**。
 * @param {object} d 云盘上传返回的 data
 * @param {{width?:number,height?:number,duration?:number}} meta ffmpeg 探到的宽高时长
 */
function buildVideoAttachment(d = {}, meta = {}) {
  const thumb = d.thumbnail || '';
  return {
    attachmentType: 29,
    att_video: {
      coverUrl: thumb,
      createTime: Number(d.uploadDate) || Date.now(),
      fileLength: Number(d.size) || 0,
      fileTitle: d.name || '',
      isMirror: 0,
      objectId: d.objectId || '',
      objectId2: d.objectId || '',
      resid: d.residstr || '',
      status: 0,
      thumbnails_url: thumb,
      titleEdited: 0,
      type: d.suffix || '',
      url: d.preview || '',
      videoHeight: Number(meta.height) || 0,
      videoWidth: Number(meta.width) || 0,
      videoLength: Number(meta.duration) || 0,
      filePath: '',
    },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.cookie  与适配器其它请求同一份 cookie
 * @param {string|number} opts.puid
 * @param {'api'|'page'|'auto'} [opts.downloadMode] 取直链走哪条路，默认 'api'
 * @param {Function} [opts.requestText] 注入用（单测）
 */
function createCloudDiskUploader(opts = {}) {
  const cookie = opts.cookie || '';
  const puid = opts.puid != null ? String(opts.puid) : '';
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const reqText = opts.requestText || requestText;
  // 流式上传用的 POST（走 https.request，无法复用 requestText 的 Buffer body）→ 同样可注入
  const postStreamFn = opts.postStream || postStream;
  const downloadMode = DOWNLOAD_MODES.includes(opts.downloadMode) ? opts.downloadMode : 'api';
  // 分片下限：默认 2GB（服务端规则）。可注入 —— 单测用小值就能覆盖两条路，
  // 服务端哪天改规则也不必改代码。
  const splitMinBytes = Number.isFinite(Number(opts.splitMinBytes)) && Number(opts.splitMinBytes) > 0
    ? Number(opts.splitMinBytes)
    : SPLIT_MIN_BYTES;

  let cachedToken = '';
  let tokenAt = 0;
  const TOKEN_TTL_MS = 10 * 60 * 1000;
  const stats = {
    tokenReq: 0, tokenFail: 0, uploadReq: 0, uploadFail: 0,
    chunkReq: 0, chunkFail: 0,          // 分片上传：算 CRC / 初始化 / 每片各记一次
    dlReq: 0, dlFail: 0, pageReq: 0, pageFail: 0,
  };

  /** 取 pan token（带缓存；官方也是缓存到登出为止） */
  async function getPanToken(force) {
    if (!force && cachedToken && Date.now() - tokenAt < TOKEN_TTL_MS) return cachedToken;
    stats.tokenReq++;
    let j;
    try {
      const text = await reqText(`${PAN_BASE}${TOKEN_PATH}`, { cookie, timeoutMs });
      j = JSON.parse(text);
    } catch (e) {
      stats.tokenFail++;
      throw new Error(`取云盘 token 失败: ${e.message}`);
    }
    if (!j || !j.result || !j._token) {
      stats.tokenFail++;
      throw new Error(`取云盘 token 失败: ${(j && j.msg) || '返回里没有 _token（cookie 可能已失效）'}`);
    }
    cachedToken = String(j._token);
    tokenAt = Date.now();
    return cachedToken;
  }

  /**
   * 把「上传源」统一成 `{ buf }` 或 `{ path, size }` 两种形态。
   * 之所以要支持路径：客户端上传时是 `fs.createReadStream(filePath)` 边读边发的，
   * 内存占用与文件大小无关，所以它才能传大文件；整块 Buffer 做不到这一点。
   */
  function normalizeSource(src) {
    if (Buffer.isBuffer(src)) {
      if (!src.length) throw new Error('文件数据为空');
      return { buf: src, size: src.length };
    }
    if (typeof src === 'string' && src) {
      const st = fs.statSync(src);
      if (!st.size) throw new Error('文件数据为空');
      return { path: src, size: st.size };
    }
    throw new Error('文件数据为空');
  }

  /** 取源的 [start, end) 字节；路径源只读这一小段出来（不整文件入内存） */
  function sliceOf(source, start, end) {
    if (source.buf) return source.buf.subarray(start, end);
    const len = Math.max(0, end - start);
    const b = Buffer.alloc(len);
    const fd = fs.openSync(source.path, 'r');
    try { fs.readSync(fd, b, 0, len, start); } finally { fs.closeSync(fd); }
    return b;
  }

  /**
   * 用**流**发一个 multipart POST（照抄客户端 `uploadFileToCloudDiskSingle` 的写法）。
   *
   * 两个要点：
   *   1. 只写头部 → `fs.createReadStream` 边读边 `req.write` → 最后补结尾边界；
   *   2. **故意不设 Content-Length**，让 Node 自动用 `Transfer-Encoding: chunked` ——
   *      客户端就是这么干的，所以它事先不需要知道（也不需要持有）整个文件。
   * 额外加了一点客户端没有的东西：`write()` 返回 false 时暂停读流、等 drain 再继续
   * （客户端固定使用 5MB 的 highWaterMark；同样补上更稳妥，且不改变协议）。
   */
  function postStream(url, { filePath, prelude, epilogue, contentType, timeoutMs: t = timeoutMs }) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        host: u.host,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          cookie: cookie || '',
          referer: `${PAN_BASE}/`,
          // ⚠️ 这个头不能少：少了服务端解析不出分片，会回「参数错误, file不能为空」
          // （客户端 `uploadFileToCloudDiskSingle` 也是先 setHeader("Content-Type", multipart…)
          //  再写头部的；漏掉它会直接导致校验失败）
          'content-type': contentType,
        },
      }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
      });
      req.setTimeout(t, () => req.destroy(new Error(`上传超时(${Math.round(t / 1000)}s)`)));
      req.on('error', reject);
      req.write(prelude);
      const rs = fs.createReadStream(filePath, { highWaterMark: 5 * 1024 * 1024 });
      rs.on('data', (chunk) => { if (!req.write(chunk)) { rs.pause(); req.once('drain', () => rs.resume()); } });
      rs.on('end', () => req.end(epilogue));
      rs.on('error', (e) => { req.destroy(e); reject(e); });
    });
  }

  /** 流式单次上传（<2GB；≥2GB 服务端不收单次，见 SPLIT_MIN_BYTES） */
  async function uploadFileSingle(filePath, filename, size, { retried = false } = {}) {
    const token = await getPanToken(retried);
    const qs = new URLSearchParams({
      _token: token, puid, uploadtype: 'normal', hideFile: 'true',
    });
    const boundary = '----cxonebot' + crypto.randomBytes(12).toString('hex');
    const name = String(filename || path.basename(filePath)).replace(/"/g, '');
    const prelude = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n';
    const epilogue = `\r\n--${boundary}--\r\n`;

    stats.uploadReq++;
    let j;
    try {
      const r = await postStreamFn(`${PAN_BASE}${UPLOAD_PATH}?${qs.toString()}`, {
        filePath,
        prelude,
        epilogue,
        contentType: `multipart/form-data; boundary=${boundary}`,
        timeoutMs: Math.max(timeoutMs, uploadTimeoutFor(size)),
      });
      j = JSON.parse(r.text);
    } catch (e) {
      stats.uploadFail++;
      throw new Error(`云盘上传失败: ${e.message}`);
    }
    if (j && j.result === true && j.data) return j.data;
    const msg = (j && (j.msg || j.errorMsg)) || '未知错误';
    if (!retried && /token|登录|失效/i.test(String(msg))) {
      cachedToken = '';
      return uploadFileSingle(filePath, filename, size, { retried: true });
    }
    stats.uploadFail++;
    throw new Error(`云盘上传失败: ${msg}`);
  }

  /**
   * 分片上传（照抄官方 `CloudDiskBaseHelper.uploadFileToCloudDiskSplit` 的三步协议）
   *
   * ⚠️ 只有 **≥2GB** 才允许走这条路（服务端强制，见 SPLIT_MIN_BYTES 注释）；
   *    小于 2GB 走单次上传 —— 实测 82MB 单次上传能成功。
   * ⚠️ 这两个 chunk 接口的成功判定是 `code === 2`（不是 `result: true`），别照着单次上传抄。
   * ⚠️ initTask 参数名很短、和单次上传不同：`fn` / `fs` / `crc` / `hideFile=1` / `panType=2`。
   * ⚠️ 分片大小由服务端在 initTask 里给（`fileChunkList`），不是本实现决定；`startByte`/`endByte`
   *    是左闭右开（官方 `createReadStream({start, end: endByte - 1})`）。
   */
  async function uploadSplit(source, filename, { retried = false, onProgress = null } = {}) {
    const src = normalizeSource(source);
    const token = await getPanToken(retried);
    const name = String(filename || (src.path ? path.basename(src.path) : `file_${Date.now()}.bin`)).replace(/"/g, '');
    const size = src.size;
    const probe = Math.min(CRC_PROBE_BYTES, size);

    /** 发一个 multipart 请求（分片这几个接口都是 multipart） */
    const postParts = async (url, parts) => {
      const boundary = '----cxonebot' + crypto.randomBytes(12).toString('hex');
      const segs = [];
      for (const p of parts) {
        segs.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${p.field}"; filename="${name}"\r\n\r\n`, 'utf8'));
        segs.push(p.data);
        segs.push(Buffer.from('\r\n', 'utf8'));
      }
      segs.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
      const body = Buffer.concat(segs);
      const text = await reqText(url, {
        cookie,
        method: 'POST',
        body,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
        },
        timeoutMs: Math.max(timeoutMs, uploadTimeoutFor(body.length)),
      });
      return JSON.parse(text);
    };

    // ① 算 CRC：body 是前 512KB(file0) + 后 512KB(file1)
    const crcQs = new URLSearchParams({ _token: token, puid, size: String(size) });
    stats.chunkReq++;
    let crcRet;
    try {
      crcRet = await postParts(`${PAN_BASE}${CRC_PATH}?${crcQs.toString()}`, [
        { field: 'file0', data: sliceOf(src, 0, probe) },
        { field: 'file1', data: sliceOf(src, size - probe, size) },
      ]);
    } catch (e) {
      stats.chunkFail++;
      throw new Error(`云盘分片上传失败(算 CRC): ${e.message}`);
    }
    if (!crcRet || crcRet.code !== 2 || !(crcRet.data && crcRet.data.crc)) {
      stats.chunkFail++;
      if (!retried && /token|登录|失效/i.test(JSON.stringify(crcRet || {}))) {
        cachedToken = '';
        return uploadSplit(source, filename, { retried: true, onProgress });
      }
      throw new Error(`云盘分片上传失败(算 CRC): ${JSON.stringify(crcRet).slice(0, 200)}`);
    }

    // ② 初始化任务：服务端返回分片清单
    const initQs = new URLSearchParams({
      _token: token,
      puid,
      fn: name,
      fs: String(size),
      crc: String(crcRet.data.crc),
      hideFile: '1',
      panType: '2',
    });
    stats.chunkReq++;
    let init;
    try {
      init = JSON.parse(await reqText(`${PAN_BASE}${INIT_TASK_PATH}?${initQs.toString()}`, { cookie, timeoutMs }));
    } catch (e) {
      stats.chunkFail++;
      throw new Error(`云盘分片上传失败(初始化): ${e.message}`);
    }
    const list = (init && init.data && init.data.fileChunkList) || [];
    if (!init || init.code !== 2 || !list.length) {
      stats.chunkFail++;
      throw new Error(`云盘分片上传失败(初始化): ${JSON.stringify(init).slice(0, 200)}`);
    }

    // ③ 逐片上传；最后一片的响应里带 resid / objectId / suffix
    // 大文件（≥2GB）会传很久，所以按片打进度：片数少就每片一行，片数多就约 20 行
    const logEvery = Math.max(1, Math.ceil(list.length / 20));
    let sentBytes = 0;
    let last = null;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const start = Number(c.startByte) || 0;
      const end = Number(c.endByte) || 0;
      // 每片都取一次 token（内部有 10 分钟缓存）——3GB 级上传要跑很久，
      // 使用起始 token 会漏掉"中途刷新过 token"的情况
      let chunkToken = token;
      try { chunkToken = await getPanToken(); } catch (_) { /* 取不到就沿用旧的 */ }
      const chunkUrl = () => `${PAN_BASE}${c.fileChunkUploadUrl}?`
        + new URLSearchParams({ _token: chunkToken, puid }).toString();
      stats.chunkReq++;
      let r;
      try {
        r = await postParts(chunkUrl(), [{ field: 'file', data: sliceOf(src, start, end) }]);
      } catch (e) {
        stats.chunkFail++;
        throw new Error(`云盘分片上传失败(第 ${i + 1}/${list.length} 片): ${e.message}`);
      }
      // token 中途失效：强换一次 token 重发这一片（长传里这比整单重来划算得多）
      if ((!r || !r.result) && /token|登录|失效/i.test(JSON.stringify(r || {}))) {
        try {
          chunkToken = await getPanToken(true);
          r = await postParts(chunkUrl(), [{ field: 'file', data: sliceOf(src, start, end) }]);
          console.log(`[clouddisk] 第 ${i + 1}/${list.length} 片 token 失效，换 token 重发成功`);
        } catch (e) {
          stats.chunkFail++;
          throw new Error(`云盘分片上传失败(第 ${i + 1}/${list.length} 片，换 token 重发后仍失败): ${e.message}`);
        }
      }
      if (!r || !r.result) {
        stats.chunkFail++;
        throw new Error(`云盘分片上传失败(第 ${i + 1}/${list.length} 片): ${JSON.stringify(r).slice(0, 200)}`);
      }
      last = r;
      sentBytes += Math.max(0, end - start);
      const done = i + 1;
      if (done % logEvery === 0 || done === list.length) {
        console.log(`[clouddisk] 分片 ${done}/${list.length} · 已传 ${formatSize(sentBytes)} / ${formatSize(size)}`);
      }
      if (typeof onProgress === 'function') {
        try { onProgress({ done, total: list.length, sentBytes, size }); } catch (_) { /* 忽略回调异常 */ }
      }
    }
    if (!last || !last.chunkUploadCompleted) {
      stats.chunkFail++;
      throw new Error('云盘分片上传失败: 分片传完但服务端没回 chunkUploadCompleted');
    }

    // ④ 拼成与单次上传一致的 data 形状（调用方的 buildCloudDiskAttachment 直接用）
    const fi = last.fileInfo || {};
    const d = init.data || {};
    return Object.assign({}, d, {
      fileChunkList: undefined,
      name: d.name || name,
      size: Number(d.fileSize) || size,
      isfile: fi.isfile !== undefined ? fi.isfile : true,
      objectId: fi.objectId || '',
      suffix: fi.suffix || '',
      residstr: last.residStr != null ? String(last.residStr) : '',
      resid: last.resid,
      puid: String(puid),
    });
  }

  /**
   * 上传：<2GB 单次；≥2GB 分片（**服务端规则**，不是客户端的 50MB 阈值）
   * @param {Buffer|string} source Buffer，或本地文件绝对路径（路径走流式，不占内存）
   */
  async function upload(source, filename, opts = {}) {
    const src = normalizeSource(source);
    if (src.size >= splitMinBytes) {
      stats.uploadReq++;
      try {
        return await uploadSplit(source, filename, opts);
      } catch (e) {
        stats.uploadFail++;
        throw e;
      }
    }
    // 路径源走流式；Buffer 源只能整块发（调用方给的就是内存里的字节）
    if (src.path) return uploadFileSingle(src.path, filename, src.size, opts);
    return uploadSingle(src.buf, filename, opts);
  }

  /** 单次上传 */
  async function uploadSingle(buf, filename, { retried = false } = {}) {
    const token = await getPanToken(retried);
    const qs = new URLSearchParams({
      _token: token,
      puid,
      uploadtype: 'normal',
      hideFile: 'true',
    });
    const boundary = '----cxonebot' + crypto.randomBytes(12).toString('hex');
    const name = String(filename || `file_${Date.now()}.bin`).replace(/"/g, '');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n', 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buf, tail]);

    stats.uploadReq++;
    let j;
    try {
      const text = await reqText(`${PAN_BASE}${UPLOAD_PATH}?${qs.toString()}`, {
        cookie,
        method: 'POST',
        body,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
        timeoutMs: Math.max(timeoutMs, uploadTimeoutFor(buf.length)),
      });
      j = JSON.parse(text);
    } catch (e) {
      stats.uploadFail++;
      throw new Error(`云盘上传失败: ${e.message}`);
    }
    if (j && j.result === true && j.data) return j.data;

    // token 失效（官方在登出/重登时清缓存）→ 强制换一次再试
    const msg = (j && (j.msg || j.errorMsg)) || '未知错误';
    if (!retried && /token|登录|失效|失效/i.test(String(msg))) {
      cachedToken = '';
      return upload(buf, filename, { retried: true });
    }
    stats.uploadFail++;
    throw new Error(`云盘上传失败: ${msg}`);
  }

  /**
   * 云盘资源 → 可直接下载的直链。
   *
   * 附件里的 `resid` / `objectId` 只是资源号，真正能下的地址要靠这三个端点换
   * （来自明文包 `CloudDiskHelper.getDownloadUrl`，实测三个都通）：
   *
   *   /api/getDownloadUrl?puid&_token&fleid=<resid>                    首选（实测自己的和别人的都能取）
   *   /api/objectid2DownloadUrl?puid&_token&objectid=<objectId>        只有 objectId2 时（如笔记音频）
   *   /api/share/downloadUrl?puid&_token&fleid…&sarepuid=<owner puid>  兜底：知道资源所有者时才用
   *
   * ⚠️ 别以为"别人的资源必须走 share 端点"：实测用户客户端发进来的 82MB mp4（别人云盘的）
   * 用普通 `/api/getDownloadUrl?fleid=` 直接就成功了。所以顺序是普通端点优先、share 兜底 ——
   * 因为 `sarepuid` 常是按 uid 反查得到的，猜错会把本来能成的请求带偏。
   *
   * ⚠️ 返回的 url 形如 `https://d0.cldisk.com/download/<objectId>?at_&ak_&ad_&fn=<名字>`：
   *   - **带时效**（`at_` 是时间戳），所以按需解析、别缓存；
   *   - **下载时必须带 Referer**（任一 chaoxing / cldisk 域都行），否则 403。
   *
   * @param {{resid?:string, objectId?:string, sharePuid?:string|number}} p
   * @returns {Promise<{ok:true, url:string, name:string, size:number}|{ok:false, error:string}>}
   */
  async function resolveDownloadUrlViaApi(p = {}) {
    const id = p.resid ? String(p.resid) : '';
    const oid = p.objectId ? String(p.objectId) : '';
    if (!id && !oid) return { ok: false, error: '缺少 resid 与 objectId，无法解析云盘地址' };

    let token;
    try {
      token = await getPanToken();
    } catch (e) {
      return { ok: false, error: e.message };
    }

    // ⚠️ 端点顺序很重要。**别人的资源用普通端点也能取到**（只要会话能访问到它），
    // 例如用户客户端发进来的 82MB mp4，`/api/getDownloadUrl?fleid=<它的 resid>` 直接成功。
    // 所以**先试普通端点**；失败且知道 owner puid 时，才退到 share 端点。
    // 反过来"owner≠自己就先走 share"有风险：owner 常是按 uid 反查得到的，猜错会把
    // 本来能成的请求带偏。
    const owner = p.sharePuid != null && p.sharePuid !== '' ? String(p.sharePuid) : '';
    const attempts = [];
    if (id) attempts.push([DOWNLOAD_PATH, { fleid: id }]);
    else attempts.push([OBJECTID_DOWNLOAD_PATH, { objectid: oid }]);
    if (owner && owner !== puid) {
      attempts.push([SHARE_DOWNLOAD_PATH, id ? { fleid: id, sarepuid: owner } : { objectid: oid, sarepuid: owner }]);
    }

    let lastErr = '';
    for (const [path, extra] of attempts) {
      const qs = new URLSearchParams();
      qs.set('puid', puid);
      qs.set('_token', token);
      for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));

      stats.dlReq++;
      let j;
      try {
        const text = await reqText(`${PAN_BASE}${path}?${qs.toString()}`, { cookie, timeoutMs });
        j = JSON.parse(text);
      } catch (e) {
        stats.dlFail++;
        lastErr = `解析云盘地址失败: ${e.message}`;
        continue;
      }
      if (j && j.result && j.url) {
        const d = j.data || {};
        return {
          ok: true,
          url: String(j.url),
          name: String(d.name || ''),
          size: Number(d.size) || 0,
          via: 'api',
        };
      }
      // dlReq / dlFail 是"按请求"对称计数：每次失败的请求记一次（不管是网络错还是返回里没 url），
      // 这样 dlFail/dlReq 才是有意义的失败率。别在循环外再补一次，否则会重复计。
      stats.dlFail++;
      lastErr = `解析云盘地址失败: ${(j && (j.msg || j.newCode)) || '返回里没有 url'}`;
    }
    return { ok: false, error: lastErr || '解析云盘地址失败' };
  }

  /**
   * 第二条路：先用 appid 签名换「已签名的资源详情页 URL」，再抓页面解析 `fileinfo.download`。
   *
   * 与 API 那条路的依赖完全不同 —— 这条**不需要 pan token、也不需要资源所有者的 puid**，
   * 只要 resid 或 objectId；代价是要带 PC 客户端 UA、并且多一次请求 + HTML 解析。
   * （不是"API 取不了别人的"才补这条路 —— 两条路的依赖链不同，互为备份；
   *  API 挂 token 过期、page 挂签名 / PC UA，各自会坏在不一样的地方。）
   */
  async function resolveDownloadUrlViaPage(p = {}) {
    const id = p.resid ? String(p.resid) : '';
    const oid = p.objectId ? String(p.objectId) : '';
    if (!id && !oid) return { ok: false, error: '缺少 resid 与 objectId，无法解析云盘地址' };

    const qs = new URLSearchParams({ menuButtonControl: '1111' });
    if (id) qs.set('resid', id); else qs.set('objectId', oid);
    const mintUrl = signPanUrl(`${PAN_BASE}${RESOURCE_DETAIL_PATH}?${qs.toString()}`);

    stats.pageReq++;
    let pageUrl;
    try {
      const text = await reqText(mintUrl, {
        cookie, timeoutMs, headers: { 'user-agent': PC_CLIENT_UA },   // ← 这个请求才需要客户端 UA
      });
      const j = JSON.parse(text);
      if (!j || !j.result || !j.data) {
        stats.pageFail++;
        return { ok: false, error: `换资源详情页失败: ${(j && (j.msg || j.newCode)) || '返回里没有 data'}` };
      }
      pageUrl = String(j.data);
    } catch (e) {
      stats.pageFail++;
      return { ok: false, error: `换资源详情页失败: ${e.message}` };
    }

    try {
      const html = await reqText(pageUrl, {
        cookie, timeoutMs, headers: { 'user-agent': PC_CLIENT_UA },
      });
      const info = parseResourceDetail(html);
      if (!info) {
        stats.pageFail++;
        return { ok: false, error: '资源详情页里没有 fileinfo.download（可能无权限或链接已过期）' };
      }
      return { ok: true, url: info.download, name: info.name, size: info.size, via: 'page' };
    } catch (e) {
      stats.pageFail++;
      return { ok: false, error: `抓资源详情页失败: ${e.message}` };
    }
  }

  /**
   * 取直链（统一入口，按 `downloadMode` 选路）
   *
   *   'api'  → 只用 `_token` 那条（默认）
   *   'page' → 只用签名页面那条（不需要 pan token / owner puid）
   *   'auto' → 先 api，失败再 page（两条路依赖不同，互备）
   *
   * 注意 'api' 内部本身也有顺序：普通端点 → share 端点（仅在知道 owner puid 时），
   * 所以 'auto' 实际是"三级"回退。
   *
   * @param {{resid?:string, objectId?:string, sharePuid?:string|number}} p
   */
  async function resolveDownloadUrl(p = {}) {
    if (downloadMode === 'page') return resolveDownloadUrlViaPage(p);
    const api = await resolveDownloadUrlViaApi(p);
    if (api.ok || downloadMode !== 'auto') return api;
    const page = await resolveDownloadUrlViaPage(p);
    if (page.ok) {
      console.log(`[clouddisk] API 取直链失败（${api.error}），已回退到页面解析`);
      return page;
    }
    return { ok: false, error: `API 与页面解析都失败: ${api.error} / ${page.error}` };
  }

  return {
    getPanToken,
    upload,
    uploadSingle,
    uploadSplit,
    resolveDownloadUrl,
    resolveDownloadUrlViaApi,
    resolveDownloadUrlViaPage,
    /** 上传并直接给出 att_clouddisk(18)；source 可以是 Buffer 或本地路径 */
    async uploadAsFile(source, filename, opts) {
      const d = await upload(source, filename, opts);
      return { ok: true, data: d, attachment: buildCloudDiskAttachment(d) };
    },
    /** 上传并直接给出 att_video(29)（meta 由 videoMeta 探）；source 可以是 Buffer 或本地路径 */
    async uploadAsVideo(source, filename, meta, opts) {
      const d = await upload(source, filename, opts);
      return { ok: true, data: d, attachment: buildVideoAttachment(d, meta) };
    },
    stats: () => ({ ...stats }),
  };
}

module.exports = {
  createCloudDiskUploader,
  resolveDownloadMode,
  buildCloudDiskAttachment,
  buildVideoAttachment,
  panSignString,
  signPanUrl,
  parseResourceDetail,
  formatSize,
  createCid,
  requestText,
  PAN_BASE,
  TOKEN_PATH,
  UPLOAD_PATH,
  DOWNLOAD_PATH,
  OBJECTID_DOWNLOAD_PATH,
  SHARE_DOWNLOAD_PATH,
  RESOURCE_DETAIL_PATH,
  CRC_PATH,
  INIT_TASK_PATH,
  SPLIT_MIN_BYTES,
  CRC_PROBE_BYTES,
  uploadTimeoutFor,
  PAN_APP_ID,
  PAN_APP_KEY,
  PC_CLIENT_UA,
  DOWNLOAD_MODES,
};
