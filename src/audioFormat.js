'use strict';
/**
 * 音频格式适配：把任意常见格式转成学习通能播的 AMR
 *
 * 为什么适配器要做这件事：
 *   OneBot 的 `record` 段**不限制音频格式**（规范只说 file），插件作者无从得知
 *   学习通只认 AMR——这是平台侧的隐藏约束。把「OneBot record ↔ 学习通能播的音频」
 *   翻译过去，属于适配器的本职（和把 at 段翻译成 atToInfo 是同一类事），
 *   而不是替调用方做业务决策。
 *
 * 设计原则：
 *   - **零硬依赖**：ffmpeg 可选。已经是 amr 就直通，完全不碰外部程序
 *   - **需要转码却没有 ffmpeg 时明确报错**，绝不静默发出一个客户端播不了的音频
 *   - 路径可配置（`onebot.ffmpegPath`），未配则用 PATH 里的 ffmpeg
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/** 学习通使用的格式 */
const TARGET = 'amr';

/**
 * 按魔术字节识别音频容器/编码
 * @param {Buffer} buf
 * @returns {string|null} 'amr'|'mp3'|'wav'|'ogg'|'m4a'|'flac'|'silk'|'aac'|null
 */
function sniffAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const head = buf.slice(0, 16);

  // AMR-NB / AMR-WB：文件头 "#!AMR\n" / "#!AMR-WB\n"
  if (head.slice(0, 6).toString('latin1') === '#!AMR\n') return 'amr';
  if (head.slice(0, 9).toString('latin1') === '#!AMR-WB\n') return 'amr';

  // SILK（QQ/微信常用）："#!SILK_V3" 或 0x02 "#!SILK"
  if (head.slice(0, 9).toString('latin1') === '#!SILK_V3') return 'silk';
  if (buf[0] === 0x02 && head.slice(1, 9).toString('latin1') === '#!SILK') return 'silk';

  if (head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (head.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (head.slice(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (head.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (head.slice(0, 3).toString('latin1') === 'ID3') return 'mp3';
  // MP3 帧同步（0xFFEx / 0xFFFx）
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  // ADTS AAC
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac';

  return null;
}

/** 能被 ffmpeg 转码的格式（silk 不在其中——ffmpeg 不支持，得先用别的工具） */
const FFMPEG_CAN_HANDLE = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);

function execFileP(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, code: err && err.code, error: err ? String(stderr || err.message).slice(0, 400) : null });
        });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/** 解析可用的 ffmpeg 可执行文件路径（按优先级） */
function resolveFfmpegBin(customPath) {
  // 1) 显式配置优先
  if (customPath) return customPath;
  // 2) npm 包 ffmpeg-static —— 首选：自带二进制，团队无需预装系统 ffmpeg
  //    （实测其构建含 libopencore_amrnb，可编 AMR；个别平台会返回 null）
  try {
    const p = require('ffmpeg-static');
    if (p && typeof p === 'string' && fs.existsSync(p)) return p;
  } catch (_) { /* 未安装或平台不支持 → 回退 */ }
  // 3) 系统 PATH 里的 ffmpeg
  return 'ffmpeg';
}

/** 检测 ffmpeg 是否可用（结果缓存，避免每次都起进程探测） */
let _ffmpegOk = null;
async function probeFfmpeg(ffmpegPath) {
  const cmd = resolveFfmpegBin(ffmpegPath);
  if (_ffmpegOk && _ffmpegOk.cmd === cmd && Date.now() - _ffmpegOk.at < 60000) return _ffmpegOk.ok;
  const r = await execFileP(cmd, ['-hide_banner', '-version'], 8000);
  _ffmpegOk = { cmd, ok: r.ok, at: Date.now(), error: r.error };
  return r.ok;
}

/**
 * 转成 AMR
 * @param {Buffer} buf 源音频
 * @param {{ffmpegPath?:string, sampleRate?:number, bitrate?:string}} [opts]
 * @returns {Promise<{ok:boolean, buf?:Buffer, from?:string, error?:string}>}
 */
async function toAmr(buf, opts = {}) {
  const kind = sniffAudio(buf);
  if (kind === TARGET) return { ok: true, buf, from: kind, transcoded: false };

  if (kind === 'silk') {
    return {
      ok: false,
      error: '语音是 SILK 格式，ffmpeg 不支持解码 SILK。需先用其他工具（如 silk-v3-decoder）'
        + '转成 amr 或 mp3 再发送。',
    };
  }
  if (!kind) {
    return { ok: false, error: '无法识别的音频格式（支持 amr/mp3/wav/ogg/m4a/flac/aac；已是 amr 则原样发送）' };
  }
  if (!FFMPEG_CAN_HANDLE.has(kind)) {
    return { ok: false, error: `不支持的音频格式: ${kind}` };
  }

  const ff = resolveFfmpegBin(opts.ffmpegPath);
  if (!(await probeFfmpeg(opts.ffmpegPath))) {
    return {
      ok: false,
      error: `语音是 ${kind} 格式，而学习通只支持 amr，需要 ffmpeg 转码；`
        + `但找不到可用的 ffmpeg（尝试的命令: ${ff}）。`
        + '需执行 npm install 安装 ffmpeg-static（推荐），'
        + '或安装 ffmpeg 并加入 PATH，或在 config.json 的 onebot 段配置 ffmpegPath。',
    };
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const tmpIn = path.join(os.tmpdir(), `cx-audio-in-${stamp}.${kind}`);
  const tmpOut = path.join(os.tmpdir(), `cx-audio-out-${stamp}.amr`);
  try {
    fs.writeFileSync(tmpIn, buf);
    const r = await execFileP(ff, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', tmpIn,
      '-ar', String(opts.sampleRate || 8000),
      '-ac', '1',
      '-c:a', 'libopencore_amrnb',
      '-b:a', opts.bitrate || '12.2k',
      '-f', 'amr',
      tmpOut,
    ]);
    if (!r.ok) {
      return { ok: false, error: `ffmpeg 转码失败: ${r.error || '未知错误'}` };
    }
    const out = fs.readFileSync(tmpOut);
    if (!out.length) return { ok: false, error: 'ffmpeg 转码结果为空' };
    return { ok: true, buf: out, from: kind, transcoded: true };
  } catch (e) {
    return { ok: false, error: `转码过程出错: ${e.message}` };
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { fs.unlinkSync(f); } catch (_) { /* 忽略 */ } }
  }
}

module.exports = { sniffAudio, toAmr, probeFfmpeg, resolveFfmpegBin, TARGET, FFMPEG_CAN_HANDLE };
