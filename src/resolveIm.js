// 身份解析：config 里有已导入 hxToken → 直接用；否则用 cookie 调 getUserImToken
// hxToken 的导入见 src/login.js（官方桥 _getImInfo 返回 {fid,pic,dept,schoolname,tuid,puid,hxToken}）。
const { getImToken } = require('./imToken');

/**
 * @param {{cookie?:string, hxToken?:string, tuid?:string|number, imTokenUrl?:string}} cfg
 * @returns {Promise<{tuid:string|number,puid?:string|number,fid?:string,hxToken:string}>}
 */
async function resolveImInfo(cfg) {
  if (cfg.hxToken) {
    console.log(`[im] 使用已导入 hxToken（导入于 ${cfg.hxTokenImportedAt || '未知时间'}），跳过 cookie 换取`);
    return {
      tuid: cfg.tuid,
      puid: cfg.puid,
      hxToken: cfg.hxToken,
    };
  }
  if (!cfg.cookie || String(cfg.cookie).length < 20) {
    throw new Error('config 中既没有已导入的 hxToken，也没有有效 cookie —— 直接启动 node onebot.js 即可（它会自己触发扫码登录）');
  }
  console.log('[im] 使用 cookie 换取 hxToken ...');
  const info = await getImToken({ cookie: cfg.cookie, url: cfg.imTokenUrl });
  return {
    tuid: info.tuid,
    puid: info.puid,
    fid: info.fid,
    hxToken: info.hxToken,
  };
}

module.exports = { resolveImInfo };
