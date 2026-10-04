// 最小 XMLHttpRequest shim —— 覆盖 easemob SDK 在 Node 下需要的成员
// 支持：
//   - 文本/JSON 请求（httpDNS、REST）
//   - FormData 上传（图片/文件，序列化为 multipart）
//   - Blob / ArrayBuffer / TypedArray body
//   - onXxx 属性 与 addEventListener('load'|'error'|'timeout'|'abort'|'progress')
//   - xhr.upload.addEventListener('progress')（进度事件占位）
'use strict';
const http = require('http');
const https = require('https');

class MiniXMLHttpRequest {
  constructor() {
    this.readyState = 0; // 0 UNSENT / 1 OPENED / 2 HEADERS_RECEIVED / 3 LOADING / 4 DONE
    this.status = 0;
    this.statusText = '';
    this.responseText = '';
    this.response = '';
    this.responseType = '';
    this.responseXML = null;
    this.timeout = 0;
    this._method = 'GET';
    this._url = '';
    this._headers = {};
    this._body = null;
    this._timer = null;
    this._req = null;
    this._done = false;
    this._listeners = Object.create(null);
    // 属性式回调
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.ontimeout = null;
    this.onabort = null;
    this.onloadstart = null;
    this.onloadend = null;
    // upload 对象（SDK 会调用 upload.addEventListener('progress', fn)）
    const self = this;
    this.upload = {
      addEventListener(type, fn) { self._on('upload:' + type, fn); },
      removeEventListener(type, fn) { self._off('upload:' + type, fn); },
      onprogress: null,
    };
  }

  // ---------- 事件 ----------
  _on(type, fn) {
    if (typeof fn !== 'function') return;
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  }
  _off(type, fn) {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  addEventListener(type, fn) { this._on(type, fn); }
  removeEventListener(type, fn) { this._off(type, fn); }
  _fire(type, ev) {
    const evt = Object.assign({ type, target: this, currentTarget: this }, ev || {});
    for (const fn of this._listeners[type] || []) {
      try { fn.call(this, evt); } catch (_) {}
    }
    const prop = this['on' + type];
    if (typeof prop === 'function') { try { prop.call(this, evt); } catch (_) {} }
    // onreadystatechange 也要在 readyState 变化时触发
    if (type === 'readystatechange') {
      if (typeof this.onreadystatechange === 'function') { try { this.onreadystatechange.call(this, evt); } catch (_) {} }
    }
  }
  _setReadyState(rs) {
    this.readyState = rs;
    this._fire('readystatechange');
  }

  // ---------- 请求 ----------
  open(method, url) {
    this._method = String(method || 'GET').toUpperCase();
    this._url = String(url);
    this._setReadyState(1);
  }

  setRequestHeader(k, v) { this._headers[String(k)] = String(v); }
  getResponseHeader(name) {
    const n = String(name).toLowerCase();
    return (this._respHeaders && this._respHeaders[n]) || null;
  }
  getAllResponseHeaders() {
    if (!this._respHeaders) return '';
    return Object.entries(this._respHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  }

  /** body 可为：string | Buffer | ArrayBuffer | TypedArray | Blob | FormData | null */
  send(body) {
    this._body = body != null ? body : null;
    this._setReadyState(2);
    this._fire('loadstart');
    this._doRequest().catch((e) => this._fail(e));
  }

  abort() {
    if (this._done) return;
    this._done = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._req) { try { this._req.destroy(); } catch (_) {} }
    this._setReadyState(0);
    this._fire('abort');
    this._fire('loadend');
  }

  // ---------- 内部 ----------
  async _serializeBody() {
    const b = this._body;
    if (b == null) return null;
    // FormData → multipart（用 undici Request 序列化）
    if (typeof FormData !== 'undefined' && b instanceof FormData) {
      const req = new Request(this._url || 'http://localhost/', { method: this._method, body: b });
      const ct = req.headers.get('content-type');
      if (ct && !this._hasHeader('content-type')) this._headers['Content-Type'] = ct;
      return Buffer.from(await req.arrayBuffer());
    }
    // Blob → Buffer
    if (typeof Blob !== 'undefined' && b instanceof Blob) {
      if (b.type && !this._hasHeader('content-type')) this._headers['Content-Type'] = b.type;
      return Buffer.from(await b.arrayBuffer());
    }
    if (Buffer.isBuffer(b)) return b;
    if (b instanceof ArrayBuffer) return Buffer.from(b);
    if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    // 字符串 / URLSearchParams
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) {
      if (!this._hasHeader('content-type')) this._headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      return Buffer.from(b.toString(), 'utf8');
    }
    const s = typeof b === 'string' ? b : String(b);
    if (!this._hasHeader('content-type')) this._headers['Content-Type'] = 'application/json';
    return Buffer.from(s, 'utf8');
  }
  _hasHeader(name) {
    const n = name.toLowerCase();
    return Object.keys(this._headers).some((k) => k.toLowerCase() === n);
  }

  async _doRequest() {
    let u;
    try { u = new URL(this._url); }
    catch (e) { return this._fail(new Error('MiniXHR: invalid url ' + this._url)); }

    let bodyBuf = null;
    try { bodyBuf = await this._serializeBody(); }
    catch (e) { return this._fail(e); }
    if (this._done) return;

    const headers = { ...this._headers };
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length;
    const lib = u.protocol === 'https:' ? https : http;

    await new Promise((resolve) => {
      const req = lib.request(
        { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: this._method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => {
            chunks.push(c);
            // 模拟进度事件
            try {
              const loaded = chunks.reduce((n, x) => n + x.length, 0);
              this.upload && this._fire('upload:progress', { lengthComputable: false, loaded, total: 0 });
            } catch (_) {}
          });
          res.on('end', () => {
            if (this._done) return resolve();
            this._respHeaders = res.headers;
            this._setReadyState(3);
            this.status = res.statusCode || 0;
            this.statusText = res.statusMessage || '';
            const buf = Buffer.concat(chunks);
            this.responseText = buf.toString('utf8');
            this.response = this.responseText;
            this._done = true;
            if (this._timer) clearTimeout(this._timer);
            this._setReadyState(4);
            this._fire('load');
            this._fire('loadend');
            resolve();
          });
        }
      );
      this._req = req;
      req.on('error', (err) => { this._fail(err); resolve(); });
      if (this.timeout > 0) {
        req.setTimeout(this.timeout, () => {
          if (this._done) return;
          this._done = true;
          try { req.destroy(); } catch (_) {}
          this._fire('timeout');
          this._fire('loadend');
        });
      }
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  _fail(err) {
    if (this._done) return;
    this._done = true;
    if (this._timer) clearTimeout(this._timer);
    this._lastError = err;
    this._fire('error', { error: err, message: err && err.message });
    this._fire('loadend');
  }
}

module.exports = { MiniXMLHttpRequest };
