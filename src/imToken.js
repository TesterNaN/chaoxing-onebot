// ① 换环信 token：GET learn.chaoxing.com/apis/user/getUserImToken
// 实现参照解包代码 ImOut.js（electron/out/im/ImOut.js）
// 需要机器人账号在 learn.chaoxing.com 的登录 cookie。
const https = require('https');
const { URL } = require('url');

/**
 * @param {{cookie: string, url: string}} opts
 * @returns {Promise<{fid:string,pic:string,dept:string,schoolname:string,tuid:string|number,puid:string|number,hxToken:string}>}
 */
function getImToken({ cookie, url = 'https://learn.chaoxing.com/apis/user/getUserImToken' }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Cookie: cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) cxstudy/1.4.2',
          Referer: 'https://im.chaoxing.com/',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.result !== 1 || !json.msg) {
              reject(new Error('getUserImToken failed: ' + body.slice(0, 300)));
              return;
            }
            const m = json.msg;
            resolve({
              fid: m.fid,
              pic: m.pic,
              dept: m.dept,
              schoolname: m.schoolname,
              tuid: m.uid,
              puid: m.puid,
              hxToken: m.hxToken,
            });
          } catch (e) {
            reject(new Error('bad json from getUserImToken: ' + body.slice(0, 300)));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

module.exports = { getImToken };
