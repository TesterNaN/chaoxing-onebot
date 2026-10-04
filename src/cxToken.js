'use strict';
/**
 * tokenSign：学习通 PC 客户端那条路的接口签名
 *
 * 算法**不是**逆向二进制得到的——`@cx/cxcore` 是明文 JS
 * （`_decrypted_cx/node_modules/@cx/cxcore/dist/util/TokenUtil.js` + `CryptoUtil.js`）：
 *
 *   const token    = "cxxxt1993";        // 硬编码
 *   const tokenKey = "SVnjMTypYuMCO&X";  // 硬编码
 *
 *   tokenSign 时：getParams.token = token; getParams._time = Date.now()
 *   把 getParams 按 key 字典序排成 ["k=v", ...]
 *   inf_enc = md5(`${paramsArray.join('&')}&_key=${tokenKey}`)     // md5 无盐
 *   最终 query = "?" + paramsArray.join('&') + "&inf_enc=" + inf_enc
 *
 * 实测（2026-09）用算出来的签名打 useryd 的批量接口返回 result=1，可用。
 */
const crypto = require('crypto');

const TOKEN = 'cxxxt1993';
const TOKEN_KEY = 'SVnjMTypYuMCO&X';

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

/**
 * 生成签名后的 query string（不含 host/path）
 * @param {object} getParams 会放进 query 的参数
 * @param {boolean} [sign]   是否加 token/_time/inf_enc，默认 true
 * @returns {string} 形如 `?puid=1&_time=2&token=…&inf_enc=…`；无参数时返回 ''
 */
function signQuery(getParams = {}, sign = true) {
  // 与 TokenUtil 一致：入参为空时不产生任何 query（连 token/_time 都不加）
  if (!getParams || !Object.keys(getParams).length) return '';
  const p = { ...getParams };
  if (sign) {
    p.token = TOKEN;
    p._time = Date.now();
  }
  const arr = Object.keys(p).sort().map((k) => `${k}=${p[k] == null ? '' : p[k]}`);
  if (!arr.length) return '';
  if (sign) arr.push(`inf_enc=${md5(`${arr.join('&')}&_key=${TOKEN_KEY}`)}`);
  return '?' + arr.join('&');
}

/** 带签名的完整 URL */
function signUrl(base, path, getParams) {
  return `${base}${path}${signQuery(getParams)}`;
}

/** 按 TokenUtil.getPostFormData 的规则拼 form 表单体（数组用逗号连接） */
function formBody(obj = {}) {
  return Object.keys(obj).map((k) => {
    const v = obj[k];
    return `${k}=${Array.isArray(v) ? v.join(',') : (v == null ? '' : v)}`;
  }).join('&');
}

module.exports = { signQuery, signUrl, formBody, md5, TOKEN, TOKEN_KEY };
