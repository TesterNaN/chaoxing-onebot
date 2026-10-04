// 轻量图片尺寸解析（PNG / JPEG / GIF / WebP / BMP）
// 学习通 img 消息需要 width/height 字段（客户端按它做布局/缩略图）
'use strict';

function png(buf) {
  // IHDR: 8 字节签名 + 4 长度 + 4 "IHDR" + width(4) + height(4)
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'image/png' };
}

function gif(buf) {
  if (buf.length < 10) return null;
  if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'image/gif' };
}

function bmp(buf) {
  if (buf.length < 26) return null;
  if (buf.toString('ascii', 0, 2) !== 'BM') return null;
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), type: 'image/bmp' };
}

function webp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = buf.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'image/webp' };
  }
  if (fmt === 'VP8L') {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width: w, height: h, type: 'image/webp' };
  }
  if (fmt === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h, type: 'image/webp' };
  }
  return null;
}

function jpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    // SOF0..SOF15（跳过 DHT=0xC4, JPG=0xC8, DAC=0xCC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      return { width, height, type: 'image/jpeg' };
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;
    off += 2 + len;
  }
  return null;
}

/**
 * @param {Buffer} buf 图片二进制
 * @returns {{width:number,height:number,type:string}|null}
 */
function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  return png(buf) || gif(buf) || bmp(buf) || webp(buf) || jpeg(buf) || null;
}

module.exports = { imageSize };
