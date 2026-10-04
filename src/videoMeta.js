'use strict';
/**
 * 视频元数据探测：宽 / 高 / 时长（秒）
 *
 * 为什么要它：v11 的 `video` 段只给 `file`，而学习通的视频消息要 `length`（秒）。
 * PC 客户端是用浏览器 `<video>` 元素读 `videoWidth/videoHeight/duration`
 * （见 `dist/assets/index-da2f599d.js` 的 `getVideoInfo`，500ms 超时兜底成 0），
 * 运行环境没有 DOM，因此使用 ffmpeg 读取——与语音转码使用同一套二进制，不引入新依赖。
 *
 * 读不出来**不致命**：宽高时长给 0，消息照样发得出去，只是客户端显示成 00:00。
 * 这与官方 PC 端的行为一致（它超时也是返回三个 0）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { resolveFfmpegBin, probeFfmpeg } = require('./audioFormat');

/** 抓 stdout+stderr 的执行（audioFormat 里那个只回 ok/error，会丢掉 ffmpeg 的输出） */
function execCapture(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // `ffmpeg -i` 探信息时本来就以非 0 退出，所以 err 不算失败
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), err });
        });
    } catch (e) {
      resolve({ stdout: '', stderr: '', err: e });
    }
  });
}

/**
 * 从 ffmpeg 的输出里解析宽高与时长（纯函数，便于单测）
 * 典型输出：
 *   Duration: 00:00:01.00, start: 0.000000, bitrate: 137 kb/s
 *   Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 160x120 [SAR 1:1 DAR 4:3], ...
 * @returns {{duration:number, width:number, height:number}}
 */
function parseFfmpegInfo(output) {
  const s = String(output || '');
  let duration = 0;
  let width = 0;
  let height = 0;

  const d = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);

  // 优先取 Video 流那行：像素格式后面紧跟 WxH
  const v = s.match(/Video:[\s\S]{0,400}?,\s*(\d{2,5})x(\d{2,5})/);
  const any = v || s.match(/(\d{2,5})x(\d{2,5})/);
  if (any) {
    width = Number(any[1]);
    height = Number(any[2]);
  }

  return {
    duration: duration > 0 ? Math.round(duration) : 0,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

/** 探测本地文件（路径） */
async function probeVideo(filePath, opts = {}) {
  const ff = resolveFfmpegBin(opts.ffmpegPath);
  if (!(await probeFfmpeg(opts.ffmpegPath))) {
    return {
      ok: false,
      error: `视频元数据需要 ffmpeg，但找不到可用的（尝试的命令: ${ff}）。`
        + '需执行 npm install 安装 ffmpeg-static（推荐），或安装 ffmpeg 并加入 PATH，'
        + '或在 config.json 的 onebot 段配置 ffmpegPath。',
    };
  }
  const r = await execCapture(ff, ['-hide_banner', '-i', filePath], opts.timeoutMs || 30000);
  const info = parseFfmpegInfo(`${r.stderr}\n${r.stdout}`);
  // 一点信息都没解析出来 → 大概率不是视频
  if (!info.duration && !info.width) {
    const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 200);
    return { ok: false, error: `ffmpeg 读不出视频信息（可能不是视频文件）: ${tail}` };
  }
  return { ok: true, ...info };
}

/**
 * 探测 Buffer（适配器的输入都是 Buffer，落临时文件再探，用完删）
 * @param {Buffer} buf
 * @param {{ffmpegPath?:string, filename?:string, timeoutMs?:number}} [opts]
 */
async function probeVideoBuffer(buf, opts = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: '视频数据为空' };
  const ext = (() => {
    const m = String(opts.filename || '').match(/\.([a-z0-9]{1,5})$/i);
    return m ? `.${m[1].toLowerCase()}` : '.mp4';
  })();
  const tmp = path.join(os.tmpdir(), `cx_video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  try {
    fs.writeFileSync(tmp, buf);
    return await probeVideo(tmp, opts);
  } catch (e) {
    return { ok: false, error: `视频元数据探测失败: ${e.message}` };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件删不掉不影响发送 */ }
  }
}

module.exports = { parseFfmpegInfo, probeVideo, probeVideoBuffer, execCapture };
