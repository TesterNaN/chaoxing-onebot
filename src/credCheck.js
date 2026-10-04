'use strict';
/**
 * 启动时的凭据有效性检查
 *
 * 自检若只看**长度**（`cookie.length > 30 && hxToken.length > 20`），
 * 所以 cookie 早就失效了它照样"尝试直连"，然后云盘/资料各处报错 —— 用户看到的是
 * 一堆莫名其妙的失败，而不是明确的登录失效提示。
 *
 * 这里用**云盘 token 接口**当探针（成本最低、且正好是"cookie 失效后最先坏掉"的能力）：
 *   GET https://pan-yz.chaoxing.com/api/token/uservalid   （只带 cookie）
 *   → {"result":true,"_token":"…"}  = 有效；cookie 失效时返回"没有权限"错误
 *
 * ⚠️ 失效后**默认弹二维码**，但只有在**交互式终端**里才真的阻塞等扫码：
 * 无人值守（systemd / pm2 / 计划任务重启）时阻塞等扫码会让机器人彻底不工作，
 * 而此时用 hxToken 收发消息其实还是好的 —— 那种情况只告警、继续跑降级模式。
 * 想强制某一种行为就配 `onebot.cookieInvalidAction`。
 */
const { requestText, PAN_BASE, TOKEN_PATH } = require('./cxCloudDisk');

/** 取值：qr（默认，交互式终端下弹二维码）/ warn（只告警，继续跑）/ exit（退出进程） */
const COOKIE_INVALID_ACTIONS = ['qr', 'warn', 'exit'];

/**
 * 解析 `onebot.cookieInvalidAction`（纯函数）
 * 非法值不静默兜底 —— 与 profileSource / cloudDiskDownload 的做法保持一致。
 * @returns {{action:string}|{error:string}}
 */
function resolveCookieInvalidAction(cfg = {}) {
  const raw = cfg.cookieInvalidAction;
  if (raw === undefined || raw === null || raw === '') return { action: 'qr' };
  const action = String(raw).toLowerCase();
  if (!COOKIE_INVALID_ACTIONS.includes(action)) {
    return { error: `onebot.cookieInvalidAction 取值非法: "${raw}"（应为 qr / warn / exit）` };
  }
  return { action };
}

/**
 * 探一下 cookie 到底还能不能用。
 * 任何异常都当作"不可用"，并把原因带回去（原因会打给用户看，所以要说人话）。
 * @param {string} cookie
 * @param {{timeoutMs?:number, requestText?:Function}} [opts]
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
async function checkCookie(cookie, opts = {}) {
  const reqText = opts.requestText || requestText;
  const timeoutMs = Number(opts.timeoutMs) || 10000;
  if (!cookie || String(cookie).length < 20) return { ok: false, reason: 'cookie 为空或过短' };
  let j;
  try {
    const text = await reqText(`${PAN_BASE}${TOKEN_PATH}`, { cookie, timeoutMs });
    j = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `探测请求失败：${e.message}` };
  }
  if (j && j.result && j._token) return { ok: true };
  return { ok: false, reason: (j && (j.msg || j.errorMsg)) || '返回里没有 _token' };
}

/**
 * 失效了该怎么办（纯函数，便于单测）
 * @param {{cookieOk:boolean, action?:string, isTTY?:boolean}} p
 * @returns {{action:'ok'|'qr'|'warn'|'exit', why:string}}
 */
function decideStartupAction(p = {}) {
  if (p.cookieOk) return { action: 'ok', why: 'cookie 有效' };
  const want = COOKIE_INVALID_ACTIONS.includes(p.action) ? p.action : 'qr';
  if (want === 'exit') return { action: 'exit', why: '配置要求失效即退出' };
  if (want === 'warn') return { action: 'warn', why: '配置要求只告警' };
  // want === 'qr'：交互式终端才阻塞等扫码
  if (p.isTTY) return { action: 'qr', why: '交互式终端，弹二维码等扫码' };
  return { action: 'warn', why: '非交互式（无人值守），不阻塞等扫码，改为告警并继续' };
}

module.exports = {
  COOKIE_INVALID_ACTIONS,
  resolveCookieInvalidAction,
  checkCookie,
  decideStartupAction,
};
