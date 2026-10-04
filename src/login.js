#!/usr/bin/env node
// ============================================================================
// 学习通 PC 客户端 扫码登录（纯 API，无需人工操作浏览器/客户端）
// ----------------------------------------------------------------------------
// 协议要点（逆向自客户端登录页 + 实测通过）：
//   1. GET  /login?loginType=1&fid=&newversion=true&refer=<loginComplete>&pcxxtpage=2
//   2. POST /refreshQRCode                          → { enc, uuid }
//   3. GET  /createqr?uuid=&fid=-1&type=3           → 二维码（type=3 = PC学习通）
//   4. POST /getauthstatus/v2 { enc, uuid, `doubleFactorLogin`:0, type:3 }
//      —— 注意字段名带反引号、且必须带 type=3
//      扫码后: type=4 已扫待确认 → status:true 验证通过，
//      登录 cookie (UID/_uid/vc3/uf/...) 在 status:true 的响应头里一并种下
//   5. 用 cookie 请求 learn.chaoxing.com/apis/user/getUserImToken → hxToken
// ============================================================================
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');

// 本文件在 src/ 下，配置在项目根
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PASSPORT = 'https://passport2.chaoxing.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) cxstudy/1.4.2 Chrome/126.0.6478.234 Electron/31.6.0 Safari/537.36 osVersion_10.0.26100 osArch_0 (schild:06b1c2e02291482a19c9d13f30aa37e1) (device:x64) Language/zh_CN com.chaoxing.cxstudy/ChaoXingStudy_1000371_1.4.2_windows_pc_202606021731_230 (@Kalimdor)';

// ---------- HTTP ----------
function req(method, url, { data, jar = [], ref = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': PASSPORT,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    };
    if (ref) h.Referer = ref;
    let body = null;
    if (data) {
      body = new URLSearchParams(data).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    if (jar.length) h.Cookie = jar.join('; ');
    const r = https.request(u, { method, headers: h }, (res) => {
      const sc = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        resolve({ status: res.statusCode, cookies: sc, isImg: ct.startsWith('image/'), body: buf, text: buf.toString('utf8'), loc: res.headers['location'] || null });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 显示二维码：终端字符画（主）+ HTML（备选） ----------
const QR = require('qrcode'); // node_modules/qrcode

function buildAuthUrl(uuid, enc) {
  // 二维码内容 = toauthlogin URL（实测：服务端 PNG 内容即此，App 扫的是它）
  return `${PASSPORT}/toauthlogin?uuid=${uuid}&enc=${enc}&xxtrefer=&clientid=&type=3&mobiletip=`;
}

async function showQR(uuid, enc, jar, loginUrl) {
  // ★ 必须先请求 createqr：该请求把 uuid 登记为"可扫码二维码"（副作用），
  //   只拼 toauthlogin URL 而不请求它会导致扫码无响应/不识别。
  //   这里总是先请求一次（图片留作备用），再打印终端二维码。
  let imgBuf = null;
  try {
    const img = await req('GET', `${PASSPORT}/createqr?uuid=${uuid}&fid=-1&type=3`, { jar, ref: loginUrl });
    if (img.isImg) imgBuf = img.body;
  } catch (_) { /* 登记失败不致命，继续尝试 */ }

  const authUrl = buildAuthUrl(uuid, enc);
  // 主：终端字符二维码
  try {
    const art = await QR.toString(authUrl, { type: 'terminal', small: true });
    console.log('\n================= 使用学习通App扫码 =================\n');
    console.log(art);
    console.log('\n===================================================');
    console.log('扫码后在手机上点【确认登录】');
    if (imgBuf) {
      // 同时落一份 PNG 供查看器/兜底
      const png = path.join(os.tmpdir(), `cx_qr_${Date.now()}.png`);
      fs.writeFileSync(png, imgBuf);
    }
    return;
  } catch (e) {
    console.log('终端二维码失败，改弹窗:', e.message);
  }
  // 备选：HTML 弹窗（终端不支持时）
  if (imgBuf) {
    try {
      const html = path.join(os.tmpdir(), `cx_qr_${Date.now()}.html`);
      fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:95vh;margin:0"><img src="data:image/png;base64,' + imgBuf.toString('base64') + '" style="width:280px;height:280px"/><p style="font-size:17px;color:#333">用<b>学习通App</b>扫码 → 手机确认登录</p></body>');
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', html], { stdio: 'ignore', detached: true }).unref();
      else if (process.platform === 'darwin') spawn('open', [html], { stdio: 'ignore' });
      else spawn('xdg-open', [html], { stdio: 'ignore' });
      console.log('已弹窗显示二维码');
      return;
    } catch (_) {}
  }
  console.log('二维码 URL（可手动转码）: ' + authUrl);
}

// ---------- 主流程 ----------
async function qrLogin() {
  const jar = ['browserLocale=zh_CN'];
  const t = Date.now();
  const refParam = encodeURIComponent(`https://k.chaoxing.com/res/study/loginComplete.html?t=${t}`);
  const loginUrl = `${PASSPORT}/login?loginType=1&fid=&newversion=true&refer=${refParam}&pcxxtpage=2`;

  // 1. 登录页（建会话）
  const page = await req('GET', loginUrl, { jar });
  jar.push(...page.cookies.filter((c) => !jar.includes(c)));

  // 2. 二维码会话
  const rq = await req('POST', `${PASSPORT}/refreshQRCode`, { jar, ref: loginUrl });
  let j = {};
  try { j = JSON.parse(rq.text); } catch (_) { throw new Error('refreshQRCode 失败: ' + rq.text.slice(0, 120)); }
  console.log('等待扫码登录学习通...');

  // 3. 展示二维码（终端字符画）
  await showQR(j.uuid, j.enc, jar, loginUrl);

  // 4. 轮询（字段名带反引号 + type=3）
  for (let i = 0; i < 100; i++) {
    const r = await req('POST', `${PASSPORT}/getauthstatus/v2`, {
      data: { enc: j.enc, uuid: j.uuid, '`doubleFactorLogin`': '0', type: '3' },
      jar, ref: loginUrl,
    });
    jar.push(...r.cookies.filter((c) => !jar.includes(c)));
    let d = {};
    try { d = JSON.parse(r.text); } catch (_) {}
    if (d.status) {
      console.log('✔ 登录成功：' + (d.mes || '') + '  cookie+', r.cookies.length);
      break;
    }
    if (d.type === 4) console.log('已扫码，等待手机端确认...');
    else if (d.type === 7) { throw new Error(d.mes || '二维码失效，需重新获取'); }
    else if (d.type === 6) { throw new Error('已在手机取消登录'); }
    else if (i % 5 === 4) console.log('等待扫码... ' + (d.mes || ''));
    await sleep(2500);
  }

  // 5. 写 config：cookie + 换 hxToken
  const cookie = [...new Set(jar)].join('; ');
  const cfg = loadOrCreate();
  cfg.cookie = cookie;
  try {
    const im = await req('GET', 'https://learn.chaoxing.com/apis/user/getUserImToken', { jar });
    const imj = JSON.parse(im.text);
    if (imj.result === 1 && imj.msg) {
      cfg.hxToken = imj.msg.hxToken;
      cfg.tuid = imj.msg.uid ?? cfg.tuid;
      cfg.puid = imj.msg.puid ?? cfg.puid;
      cfg.hxTokenImportedAt = new Date().toISOString();
      console.log(`✅ 身份已写入 config.json：tuid=${cfg.tuid} puid=${cfg.puid} 昵称=${imj.msg.nick || ''}`);
    } else {
      console.log('⚠ 登录成功，cookie 已存，但换 hxToken 失败: ' + im.text.slice(0, 150));
    }
  } catch (e) {
    console.log('⚠ cookie 已存，换 hxToken 出错: ' + e.message);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  console.log('✅ config.json 已更新，可运行: npm start（或 node onebot.js）');
}

function loadOrCreate() {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
  }
  const ex = path.join(__dirname, '..', 'config.example.json');
  return fs.existsSync(ex) ? JSON.parse(fs.readFileSync(ex, 'utf8')) : {};
}

const cmd = process.argv[2];
if (require.main === module) {
  if (cmd === 'qr') {
    qrLogin().catch((e) => { console.error('失败:', e.message); process.exit(1); });
  } else {
    console.log('说明: 一般不需要直接运行本文件——node onebot.js 会在凭据缺失/失效时自动调用它');
    console.log('若确实要单独登录: node src/login.js qr   （学习通扫码，自动写入 config.json）');
  }
}

module.exports = { qrLogin, loadOrCreate, buildAuthUrl, CONFIG_PATH };
