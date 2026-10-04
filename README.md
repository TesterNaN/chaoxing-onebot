# chaoxing-onebot

把超星学习通（cxstudy PC 客户端协议）接入 OneBot v11 的适配器。

适配器只做协议翻译：把学习通的 IM 消息转成 OneBot v11 事件，把 OneBot v11 调用转成学习通的
IM 操作。限速、重试、业务策略由调用方（框架 / 插件）决定。

- 严格遵循 OneBot v11：不发明字段、不发明 action
- 收发均基于学习通自身的 IM 通道（环信 WebSocket SDK）
- 支持正向 / 反向 WebSocket、正向 HTTP、HTTP POST 四种通信方式

## 环境要求

- Node.js ≥ 21（依赖内置 `WebSocket`）
- 可选：`ffmpeg`（发送语音、探测音视频元数据）

## 安装与运行

```bash
npm install
cp config.example.json config.json    # 然后填写 cookie 等字段
npm start                             # 走 supervisor.js 守护进程（崩溃自动重启）
node onebot.js                        # 单进程运行
```

首次运行若 `config.json` 中没有可用凭据，会自动进入二维码登录（学习通 App 扫码），
登录结果写回 `config.json`。

## 配置

`config.json` 顶层字段：

| 字段 | 说明 |
|---|---|
| `cookie` | 学习通会话 cookie（登录后获得） |
| `hxToken` | 环信 token；留空时用 cookie 换 |
| `tuid` / `puid` | 账号标识（登录后写入） |
| `imTokenUrl` | 可选，换取 `hxToken` 的接口地址覆盖 |

`onebot` 段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `reverse` | `forward` / `reverse` / `both` |
| `accessToken` | `""` | 鉴权 token，空表示不校验 |
| `wsHost` / `wsPort` | `127.0.0.1` / `6700` | 正向 WebSocket 监听地址 |
| `reverseWsUrl` | — | 反向 WebSocket 目标地址 |
| `httpHost` / `httpPort` | `127.0.0.1` / `0` | 正向 HTTP，`0` 表示关闭 |
| `httpPostUrl` | `""` | 事件推送地址，空表示关闭 |
| `heartbeatInterval` | `5000` | 心跳间隔（毫秒） |
| `reconnectInterval` | `3000` | 重连间隔（毫秒） |
| `downTimeoutMs` | `60000` | 断线判定时长，超过则重登 |
| `profileSource` | `none` | 昵称来源：`none` / `web` / `pc`。取值非法会启动报错 |
| `cloudDiskDownload` | `api` | 云盘直链取法：`api` / `page` / `auto`。取值非法会启动报错 |
| `cookieInvalidAction` | `qr` | cookie 失效时的动作：`qr` / `warn` / `exit`。取值非法会启动报错 |
| `markRead` | `true` | 收到消息后回已读回执 |
| `onlyAfterStartup` | `true` | 只上报启动之后的消息，不补发历史 |
| `startupGraceMs` | `10000` | 启动静默期（毫秒） |
| `reportSelfMessage` | `false` | 是否上报自己发送的消息 |
| `reportMultiDeviceSelf` | `false` | 是否上报多端同步回来的自己消息 |
| `ffmpegPath` | `""` | 自定义 ffmpeg 路径，空则使用 `ffmpeg-static` |
| `dedup` | `{maxSize:5000,ttlMs:21600000}` | 事件去重表容量与存活时间 |

### 凭据与续期

- `hxToken` 过期：自动用 `cookie` 换取新的 `hxToken` 并写回 `config.json`，无需人工介入。
- `cookie` 失效：启动时探测一次（云盘 token 接口）。失效时按 `cookieInvalidAction` 处理：
  `qr` 在交互式终端下进入二维码登录，非交互式环境下仅告警并继续运行；
  `warn` 只告警；`exit` 直接退出。
- 运行期间 `cookie` 失效：告警一次后静默一段时间，不再重复请求。

## OneBot v11 接口

通信方式：正向 WebSocket（`/`、`/api`、`/event`）、反向 WebSocket、正向 HTTP、HTTP POST。
响应格式为 `{status, retcode, data, echo}`；鉴权支持 `Authorization: Bearer <token>` 与
`?access_token=<token>`。

已实现的 action 以 OneBot v11 公开列表为准，包括：

- 消息：`send_private_msg`、`send_group_msg`、`send_msg`、`get_msg`、`delete_msg`
- 群：`get_group_list`、`get_group_info`、`get_group_member_list`、`get_group_member_info`、
  `set_group_kick`、`set_group_ban`、`set_group_whole_ban`、`set_group_admin`、
  `set_group_card`、`set_group_name`、`set_group_leave`
- 账号：`get_login_info`、`get_status`、`get_version_info`、`get_cookies`、
  `get_online_clients`、`set_restart`、`can_send_image`、`can_send_record`
- 扩展：`get_file`（流式取文件，返回 `{file, url, file_size}`）
- 消息段：`text`、`face`、`image`、`record`、`video`、`at`、`share`、`contact`、
  `location`、`music`、`reply`

未实现的 action 返回 `retcode 102`；执行失败返回 `retcode 103`。

## 事件

- 消息事件：`message.private` / `message.group`，含 `sub_type`（`friend` / `normal` / `anonymous`）
- 通知事件：`notice.group_upload`、`notice.group_admin`、`notice.group_ban`、
  `notice.group_recall`、`notice.friend_recall`、`notice.group_increase`、
  `notice.group_decrease`
- 元事件：`meta_event.lifecycle`、`meta_event.heartbeat`

## 消息段映射

收到的学习通附件按下表映射为 OneBot v11 段；发送时反向映射。

| 学习通附件 | OneBot 段 |
|---|---|
| 文本 / 表情 / 图片 / 语音 / 视频 / 位置 | `text`、`face`、`image`、`record`、`video`、`location` |
| 云盘文件（attachmentType 18） | `file` |
| 群名片 / 个人名片 | `contact`（`group` / `private`） |
| 网页分享、云盘文件夹、话题 / 笔记 / 小组 / 通知 / 笔记本等卡片 | `share` |
| 引用回复 | `reply` |

## 已知限制

- 学习通没有独立的"群文件"模块，因此不提供 `upload_group_file`、`get_group_file_url`、
  `delete_group_file`（这些同样不是 OneBot v11 的 action）。
- 合并转发在学习通侧是网页分享，没有可展开的记录结构，故 `get_forward_msg` 与
  `send_*_forward_msg` 不实现。
- 云盘上传：小于 2GB 走单次上传，大于等于 2GB 使用分片上传（分片大小由服务端下发）。
- 图片上限 20MB，文件上限 2GB。
- 云盘直链下载需要 `Referer` 头。
- 群管理中的不可逆操作（踢人 / 退群 / 解散群）未在真实环境验证。

## 许可

MIT
