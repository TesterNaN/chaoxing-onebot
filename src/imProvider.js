// ============================================================================
// IMProvider —— 群聊消息适配层「接口契约」
// ----------------------------------------------------------------------------
// 业务系统只依赖本接口。当前实现 = 学习通用户级通道（robot 账号 hxToken）；
// 超星开放平台 API 上线后，另写 officialProvider 实现同一接口并替换工厂。
// ============================================================================

/**
 * 群消息（已归一化的业务消息体）
 * @typedef {Object} GroupMessage
 * @property {string} id        消息id
 * @property {string} groupId   群id
 * @property {string} fromUid   发送者uid
 * @property {string} fromName  发送者昵称
 * @property {'txt'|'img'|'file'|'custom'|'cmd'} type
 * @property {string} text      文本内容（txt 类型；媒体消息为空串）
 * @property {?{url:string,thumb:string,filename:string,filetype:string,size:number,width:number,height:number}} image
 *                              图片/文件资源（type 为 img/file 时非空，url 内含 share-secret）
 * @property {number} ts        服务端时间戳(ms)
 */

/**
 * 发送结果
 * @typedef {Object} SendResult
 * @property {boolean} ok
 * @property {string} [msgId]     成功时的服务端消息id
 * @property {string} [error]     失败原因
 */

class IMProvider {
  /**
   * 使用账号凭据登录并建立连接（幂等，已连接则复用）
   * @param {{cookie?:string, tuid?:string|number}} cred
   */
  async connect(cred) { throw new Error('not implemented'); }

  /**
   * 发送群文本消息（支持普通文本与 @提及：@后跟 uid 用分隔符约定）
   * @param {string} groupId
   * @param {string} text
   * @param {{atUids?: string[]}} [opts]
   * @returns {Promise<SendResult>}
   */
  async sendGroupText(groupId, text, opts) { throw new Error('not implemented'); }

  /**
   * 发送群图片消息（SDK 内部完成 chatfiles 上传后再发消息）
   * @param {string} groupId
   * @param {Buffer} buf      图片字节
   * @param {{filename?:string, mime?:string}} [opts]
   * @returns {Promise<SendResult & {url?: string}>}
   */
  async sendGroupImage(groupId, buf, opts) { throw new Error('not implemented'); }

  /**
   * 注册群消息回调（收消息 → 推给学校系统）
   * @param {(msg: GroupMessage) => void} cb
   */
  onGroupMessage(cb) { throw new Error('not implemented'); }

  /**
   * 断开
   */
  async disconnect() { throw new Error('not implemented'); }
}

/**
 * 工厂：根据实现名返回 Provider 实例。
 * @param {'cx-user'|'official'} impl
 */
function createIMProvider(impl = 'cx-user') {
  if (impl === 'cx-user') {
    return require('./imClient'); // 学习通用户级通道（本 POC）
  }
  if (impl === 'official') {
    throw new Error('official provider pending: implement same interface when CX open API lands');
  }
  throw new Error('unknown impl: ' + impl);
}

module.exports = { IMProvider, createIMProvider };
