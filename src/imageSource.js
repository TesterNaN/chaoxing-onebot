'use strict';
/**
 * OneBot image 段的 file 字段解析 → Buffer
 *
 * OneBot v11 允许的 file 取值（本适配器支持）：
 *   - http(s)://...            远程 URL
 *   - base64://<base64>        内联 base64（大小写不敏感的前缀）
 *   - data:image/png;base64,... data URI
 *   - file:///C:/path/a.png    file URI
 *   - C:\path\a.png / ./a.png  本地路径（相对路径以 cwd 解析）
 *
 * 返回 { buf, mime, filename }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 图片大小上限：**20MB** —— 这是**客户端自己的限制**，不是本实现决定的。
 * 依据：PC 端选图逻辑 `if (Z.size >= 20971520) { 提示 message.imageFileTooLarge; continue }`
 * （20971520 = 20 × 1024 × 1024，见 `dist/assets/index-0fc0d582.js`）。
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * 文件 / 视频 / 语音的上限：**2GB** —— 客户端对「文件」**没有任何大小检查**
 * （同一处逻辑里，非图片分支直接 `insertEmbed('file')` → 上传云盘，只有图片那一支有检查），
 * 所以真正的天花板在服务端：<2GB 单次上传、≥2GB 分片（详见 `src/cxCloudDisk.js` 的 SPLIT_MIN_BYTES）。
 * 这里就取服务端单次上传的边界，不再自己缩一个数。
 *
 * ⚠️ 但要说清楚：客户端是从磁盘**流式**读的，所以对它而言确实"无上限"；
 *    本实现把整块文件放进 Buffer，实际能承受多大受内存约束（分配失败会抛错，不会静默截断）。
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** 按用途取上限：allowAny（文件/视频/语音）用文件上限，否则用图片上限 */
const limitFor = (allowAny) => (allowAny ? MAX_FILE_BYTES : MAX_IMAGE_BYTES);

/**
 * 拉取学习通 / 云盘 CDN 地址时必须带的请求头（纯函数，便于单测）。
 *
 * 实测（2026-09，云盘直链 `https://d0.cldisk.com/download/<objectId>?at_=…`）：
 *   什么都不带 → 403      只带 UA → 403
 *   只带 Referer → 200（拿到全量 733708 字节）      Referer + UA + cookie → 200
 * 即 **只有 Referer 是必须的**，UA 与 cookie 都无关；Referer 用 chaoxing 域或 cldisk 域都行。
 *
 * 为什么必须在这里兜住：插件把收到的 `file` 段原样发回来时，需要用同一个地址再拉一次；
 * 缺少 Referer 会 403，回传直接失败（表现为`下载图片失败 HTTP 403`）。
 * 这属于"拿不到文件"的协议细节，不是策略（没有加限速/重试/改写语义）。
 */
function mediaHeaders(url) {
  try {
    const h = new URL(String(url)).hostname;
    if (/(^|\.)(chaoxing\.com|cldisk\.com)$/i.test(h)) {
      return { Referer: 'https://pan-yz.chaoxing.com/' };
    }
  } catch (_) { /* 非法 URL 交给调用方报错 */ }
  return {};
}

const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

function _sniffMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

async function resolveImageFile(file, opts = {}) {
  // allowAny: 不校验图片格式（语音等其它媒体复用本函数取字节时用）
  const allowAny = !!opts.allowAny;
  // toFile: 只给「文件 / 视频」这类大对象用 —— 远程流式落盘、本地直接用磁盘路径，
  // 返回值变成 {path, bytes, filename}（没有 buf），从而不受内存约束（客户端同款做法）
  const toFile = !!opts.toFile;
  const val = String(file == null ? '' : file).trim();
  if (!val) throw new Error('file 为空');

  let buf;
  let filename = 'image.png';
  // 只有来源自带真实文件名时才允许用扩展名兜底推断格式；
  // base64/data 来源的文件名是占位值，格式必须靠魔数嗅探判定
  let trustExt = false;

  if (/^base64:\/\//i.test(val)) {
    buf = Buffer.from(val.replace(/^base64:\/\//i, ''), 'base64');
  } else if (/^data:/i.test(val)) {
    const m = val.match(/^data:([^;,]+)?(;base64)?,(.*)$/is);
    if (!m) throw new Error('data URI 格式错误');
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'latin1');
    if (m[1]) filename = 'image.' + (m[1].split('/')[1] || 'png');
  } else if (/^https?:\/\//i.test(val)) {
    // toFile：远程大文件**流式落盘**，不拼 Buffer（客户端就是这么读的，所以它没有大小上限）
    if (toFile) {
      const dir = fileCacheDir(opts.cacheDir);
      fs.mkdirSync(dir, { recursive: true });
      const h = require('crypto').createHash('md5').update(val).digest('hex').slice(0, 8);
      let base = String(opts.name || '');
      if (!base) {
        try {
          const p = new URL(val).pathname;
          if (path.extname(p)) base = path.basename(p);
        } catch (_) { /* 忽略 */ }
      }
      if (!base) base = 'file';
      const dest = path.join(dir, `send_${h}_${base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')}`);
      const r = await streamToFile(val, dest);
      return { path: r.path, bytes: r.bytes, filename: base, mime: null };
    }
    const res = await fetch(val, { redirect: 'follow', headers: mediaHeaders(val) });
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    try {
      const p = new URL(val).pathname;
      if (path.extname(p)) { filename = path.basename(p); trustExt = true; }
      else {
        const ct = res.headers.get('content-type') || '';
        if (ct.startsWith('image/')) filename = 'image.' + ct.slice(6).split(';')[0];
      }
    } catch (_) { /* 忽略 */ }
  } else {
    let p = val;
    if (/^file:\/\//i.test(p)) p = require('url').fileURLToPath(p);
    p = path.resolve(p);
    filename = path.basename(p);
    // toFile：本地文件直接用磁盘上的那份，不读进内存（大文件同样受益）
    if (toFile) {
      const st = fs.statSync(p);
      return { path: p, bytes: st.size, filename, mime: null };
    }
    buf = fs.readFileSync(p);
    trustExt = true;
  }

  if (!buf || !buf.length) throw new Error(allowAny ? '内容为空' : '图片内容为空');
  if (buf.length > limitFor(allowAny)) {
    throw new Error(`${allowAny ? '文件' : '图片'}过大: ${buf.length} 字节 (上限 ${limitFor(allowAny)})`);
  }

  let mime = _sniffMime(buf);
  if (!mime && trustExt) {
    const ext = path.extname(filename).toLowerCase();
    mime = EXT_MIME[ext] || null;
  }
  if (!mime) {
    if (allowAny) return { buf, mime: null, filename };   // 非图片（如 amr 语音）原样返回
    throw new Error('无法识别的图片格式（支持 png/jpg/gif/bmp/webp）');
  }

  // 文件名后缀与真实格式对齐，避免客户端解码失败
  const wantExt = mime === 'image/jpeg' ? '.jpg' : '.' + mime.slice(6);
  if (path.extname(filename).toLowerCase() !== wantExt) {
    filename = filename.replace(/\.[^.]*$/, '') + wantExt;
  }

  return { buf, mime, filename };
}

// ============================================================================
// get_image 支持：把消息里的图片下载到本地缓存并返回绝对路径
// ----------------------------------------------------------------------------
// 实测：学习通的图片地址形如
//   https://a3-vip6.easemob.com/cx-dev/cxstudy/chatfiles/{uuid}?em-redirect=true&share-secret=xxx
// 直接 GET 即可拿到图片（HTTP 200，无需额外鉴权头），但 content-type 是
// application/octet-stream，所以扩展名要靠魔术字节判定。
// ============================================================================

/** 允许下载的域名（防止插件把适配器当任意 URL 代理用 → SSRF） */
const ALLOWED_HOST = /(^|\.)(easemob\.com|agora\.io)$/i;
/**
 * 允许 `get_file` 落盘的域名：图片使用的域名之外，再加上本实现会给出的地址域
 * （云盘预览/下载口 `pan-yz.chaoxing.com`、CDN `d0.cldisk.com`、图片 `p.cldisk.com`）。
 * 仍然**不是**任意 URL 代理 —— 只放本实现会给出的那几个域。
 */
const ALLOWED_FILE_HOST = /(^|\.)(easemob\.com|agora\.io|chaoxing\.com|cldisk\.com)$/i;

function imageCacheDir(customDir) {
  return customDir || path.join(os.tmpdir(), 'chaoxing-onebot-images');
}

/** 文件（非图片）落盘目录：与图片缓存分开，避免 clean_cache 连带把下载好的文件清掉 */
function fileCacheDir(customDir) {
  return customDir || path.join(os.tmpdir(), 'chaoxing-onebot-files');
}

/**
 * **流式**下载到本地文件 —— 内存占用与文件大小无关。
 *
 * 客户端就是这么干的（`fs.createReadStream` 边读边写），所以它才能"没有大小上限"；
 * 只要不把响应拼成一个 Buffer，就同样不受内存约束。
 * 用 `pipeline` 而不是手写 data/end：出错时它会自动销毁流，不会留下半个文件。
 *
 * @param {string} url
 * @param {string} destPath
 * @param {{maxBytes?:number}} [opts] maxBytes 只作保险丝，默认不设（与客户端一致）
 * @returns {Promise<{path:string, bytes:number}>}
 */
async function streamToFile(url, destPath, opts = {}) {
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');
  const val = String(url || '').trim();
  if (!/^https?:\/\//i.test(val)) throw new Error('只接受 http(s) 地址');
  const res = await fetch(val, { redirect: 'follow', headers: mediaHeaders(val) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  if (!res.body) throw new Error('下载失败：响应没有 body');

  const cap = Number(opts.maxBytes) || 0;
  const total = Number(res.headers.get('content-length')) || 0;
  if (cap && total > cap) throw new Error(`文件过大: ${total} 字节 (上限 ${cap})`);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));

  const bytes = fs.statSync(destPath).size;
  if (!bytes) throw new Error('下载内容为空');
  if (cap && bytes > cap) {
    try { fs.unlinkSync(destPath); } catch (_) { /* 忽略 */ }
    throw new Error(`文件过大: ${bytes} 字节 (上限 ${cap})`);
  }
  return { path: destPath, bytes };
}

/**
 * 远程文件 → 本地缓存文件（`get_file` 用）：流式、不限大小、不做图片格式校验。
 * 缓存键 = 文件名 + URL 的 md5 前 8 位，同一地址重复调用直接命中，不重复下载。
 */
async function fetchFileToCache(url, opts = {}) {
  const val = String(url || '').trim();
  if (!val) throw new Error('file 为空');
  let u;
  try { u = new URL(val); } catch (_) { throw new Error('地址格式错误'); }
  if (!ALLOWED_FILE_HOST.test(u.hostname)) {
    throw new Error(`不允许的文件域名: ${u.hostname}（只允许 easemob / agora / chaoxing / cldisk）`);
  }
  const dir = fileCacheDir(opts.cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  const base = String(opts.filename || '').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
    || (u.pathname.split('/').filter(Boolean).pop() || 'file').replace(/[^A-Za-z0-9._-]/g, '');
  const h = require('crypto').createHash('md5').update(val).digest('hex').slice(0, 8);
  const dest = path.join(dir, `${base}_${h}`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { path: dest, bytes: fs.statSync(dest).size, cached: true };
  }
  const r = await streamToFile(val, dest);
  return { path: r.path, bytes: r.bytes, cached: false };
}

/** 清掉文件缓存，返回删除的文件数 */
function cleanFileCache(customDir) {
  const dir = fileCacheDir(customDir);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, f)); n++; } catch (_) { /* 忽略被占用的文件 */ }
  }
  return n;
}

/**
 * 下载图片到本地缓存
 * @param {string} url  图片地址（必须来自环信/学习通域名）
 * @param {{cacheDir?:string}} [opts]
 * @returns {Promise<{path:string, bytes:number, mime:string, cached:boolean}>}
 */
async function downloadImage(url, opts = {}) {
  const val = String(url || '').trim();
  if (!val) throw new Error('file 为空');
  if (!/^https?:\/\//i.test(val)) throw new Error('get_image 只接受 http(s) 图片地址');
  let u;
  try { u = new URL(val); } catch (_) { throw new Error('图片地址格式错误'); }
  if (!ALLOWED_HOST.test(u.hostname)) {
    throw new Error(`不允许的图片域名: ${u.hostname}（只允许 easemob.com / agora.io）`);
  }

  const dir = imageCacheDir(opts.cacheDir);
  fs.mkdirSync(dir, { recursive: true });

  // 以 URL 路径最后一段（chatfiles 的 uuid）作为缓存键，便于命中复用与去重
  const key = (u.pathname.split('/').filter(Boolean).pop() || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!key) throw new Error('无法从地址中解析出图片标识');
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(key + '.'));
  if (hit) {
    const p = path.join(dir, hit);
    const st = fs.statSync(p);
    if (st.size > 0) return { path: p, bytes: st.size, mime: _sniffMime(fs.readFileSync(p)) || '', cached: true };
  }

  const res = await fetch(val, { redirect: 'follow', headers: mediaHeaders(val) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大: ${buf.length} 字节`);

  const mime = _sniffMime(buf);
  if (!mime) throw new Error('下载到的内容不是图片');
  const ext = mime === 'image/jpeg' ? '.jpg' : '.' + mime.slice(6);
  const dest = path.join(dir, key + ext);
  fs.writeFileSync(dest, buf);
  return { path: dest, bytes: buf.length, mime, cached: false };
}

/** 清空图片缓存，返回删除的文件数 */
function cleanImageCache(customDir) {
  const dir = imageCacheDir(customDir);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, f)); n++; } catch (_) { /* 忽略被占用的文件 */ }
  }
  return n;
}

/**
 * 从 AMR-NB 文件算出时长（秒）
 *
 * 学习通语音用 AMR 格式，而 OneBot 的 record 段**没有时长字段**，
 * 客户端却需要它来画语音条长度——所以这里替调用方算出来（属必要的格式适配，不是策略）。
 * AMR-NB 每帧固定 20ms；帧头 1 字节，高 4 位是帧类型，据此查表得帧长。
 * @param {Buffer} buf
 * @returns {number} 秒（至少 1）
 */
function amrDuration(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return 1;
  // 每种 AMR-NB 编码模式的帧长（字节，含 1 字节帧头）
  const FRAME_SIZE = [13, 14, 16, 18, 20, 21, 27, 32, 6, 1, 1, 1, 1, 1, 1, 1];
  let i = buf.slice(0, 6).toString('latin1') === '#!AMR\n' ? 6 : 0;
  let frames = 0;
  while (i < buf.length) {
    const type = (buf[i] >> 3) & 0x0f;
    const size = FRAME_SIZE[type];
    if (!size || i + size > buf.length) break;
    i += size;
    frames++;
  }
  if (!frames) return 1;
  return Math.max(1, Math.round((frames * 20) / 1000));
}

module.exports = {
  resolveImageFile,
  downloadImage,
  cleanImageCache,
  imageCacheDir,
  amrDuration,
  mediaHeaders,
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  limitFor,
  // 以下为流式 / 文件缓存（get_file、大文件发送）
  streamToFile,
  fetchFileToCache,
  cleanFileCache,
  fileCacheDir,
  ALLOWED_FILE_HOST,
};
