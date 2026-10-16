# dsh-media-sidebar

DSH 右侧栏的**媒体播放器** tab：在侧栏里就地播放本地音频与视频文件。

## 为什么单独做一个

- 内置的 **Document Preview** 只注册了 Office / Markdown / 代码 / 图片 / PDF / HTML / 纯文本，**没有媒体渲染器**，媒体文件会落到"不支持预览"。
- 已装的 **dsh-knit** 覆盖了图片与视频（`mp4 m4v webm mov ogv`），但**没有音频**，且只在工作区根目录内解析路径。
- `workspaceFiles` Remote 读字节**有大小上限**，视频动辄几百 MB，不适合。

所以本插件补的是：**音频**，以及**工作区外的文件**。

## 组件

| 半边 | 文件 | 作用 |
|---|---|---|
| 宿主 | `src/host/index.js` | `GET /dsh-media/api/raw?path=<绝对或相对路径>&sessionId=<会话 id>`，只读、只回环、扩展名白名单、**HTTP Range（206）** |
| 客户端 | `src/client/client.js` | 右侧栏**两个** tab 类型 + 播放器 UI |

客户端无需构建：它由 `window.__ModuleLoader__` 直接装载（与 dsh-knit 同一形态，用 `React.createElement` 而非 JSX）。

### 两个 tab 类型

| id | kind | 认什么 | 用途 |
|---|---|---|---|
| `dsh-media-sidebar:player` | `media` | 无 patterns（页类型） | guide 入口 + 手动输入路径 |
| `dsh-media-sidebar:file` | `media-file` | `patterns: ['dsh-resource://file/**']` + `canOpen` | **聊天里点文件引用直接起播** |

地址类型的契约来自官方 bundle（非推测）：

- 注册字段 `{ id, kind, patterns, priority, canOpen, title }`
  —— `ui-deliverables` 的 `changesReviewDefinition`、`ui-sidebar-documentpreview` 的 `textDefinition`
- 正文 props 为 `{ useTabInfo, useResource, t }`，地址读作 `useTabInfo().tab.navigation.address`
  —— `ui-plan` 的 `PlanPreview`
- 顶层导出形状 `exports.inject = ['slots','locale']` —— dsh-knit

内置文件预览是 `priority: 'fallback'` 认同一批地址且 `canOpen` 更宽，我们档位更高、`canOpen` 只认媒体扩展名 ——
所以**只有媒体文件落到这里**，其它文件仍走内置预览。

## 路径解析

- **绝对路径**：直接用。
- **相对路径**：必须带 `sessionId`，相对该会话的工作区根（`session.header.cwd`）解析；
  没有会话就返回 `400 session-required-for-relative`，**绝不落到宿主进程的 CWD**。

## 支持的类型

**原生**（浏览器能直接解码，按原文件 + **支持 Range** 服务）：

- 音频：`mp3 wav m4a aac flac oga opus weba`
- 视频：`mp4 m4v webm mov ogv`

**转码**（浏览器普遍解不了，用 ffmpeg 实时转 H.264/AAC 流式送出）：

- 视频：`mkv avi flv wmv`
- 音频：`wma`

想加格式只需改 `resolveKind` 旁边那张表一行（决策逻辑只有一处）。

## 转码（ffmpeg）

- **发现**：`DSH_MEDIA_SIDEBAR_FFMPEG_PATH` 优先，否则用 PATH 上的 `ffmpeg`。
- **能力探测**：启动时跑一次 `ffmpeg -encoders`，**只认 `libx264`**。拿不到就**不提供**转码、
  明确返回 `415 transcode-unavailable`（带 `reason`），而不是给一个必然失败的流。原生格式不受影响。
- **怎么转**：`libx264 -preset veryfast -crf 23 -pix_fmt yuv420p` + `aac 160k`，
  输出 `-movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1`。
  `-map 0:v:0? -map 0:a:0?` 的 `?` 让纯音频源也能走同一条命令。
- **令牌响应**里多了 `mode`：`native` 或 `transcode`，客户端据此显示提示。

### ⚠️ 转码模式不支持拖动进度

实时转码产出的是**无索引的分片流**：浏览器能播，但**拿不到时长**，因此通常不能 seek。
响应会如实声明 `accept-ranges: none`，客户端也会显示一行说明。

要做到**可拖动**，只能改成"先转码落盘缓存、再按 Range 服务已完成文件"——那是另一种实现
（多一个缓存目录 + 清理策略 + 首次播放的等待）。当前版本**刻意不做**，换的是"点开就能播、不落盘"。

### 资源保护（转码吃 CPU，必须封顶）

- **并发上限 2**：超出返回 `429 transcode-busy`（带 `active`）。
- **客户端断开即杀**：切文件 / 关面板 / 拖动都会中断请求，此时立刻 `kill` 掉 ffmpeg 子进程。
- **硬超时 30 分钟**：到点杀掉，避免僵尸进程长期占 CPU。
- ffmpeg 的 stderr 只在退出码非 0 时记进宿主日志（截断 500 字符），不回给客户端。

## 安全边界

1. **只接回环来源**，非回环一律 `403 loopback-only`；
2. **来源围栏**（`rejectReason`）：`Sec-Fetch-Site: cross-site`、跨源 `Origin`、以及**任何转发头**
   （`forwarded` / `x-forwarded-for` / `x-forwarded-host` / `x-forwarded-proto` / `x-real-ip`）
   一律 `403 origin-rejected`。
   少了这条，任何用户访问的网页都能对本路由发请求，并用 200/415/404 的差异
   **探测本机媒体文件是否存在**；而若把 `dsh web` 挂在 localhost 反代之后，
   `remoteAddress` 全是回环，远端就能直读。
3. **扩展名白名单**，不在表里的一律 `415 media-only` —— 这条端点**读不到非媒体文件**；
4. **HMAC 令牌**：`/raw` 必须带 `?token=`，令牌 = `HMAC-SHA256(secret, 文件的 realpath)`，
   用 `timingSafeEqual` 校验（格式先卡 `^[0-9a-f]{64}$`，再定长比较）。
   见下方「令牌」。
5. **相对路径限定在会话根内**：`..` 逃逸返回 `403 outside-session-root`；
6. 只读（`GET` / `HEAD`），无写入通道；`cache-control: no-store` + `nosniff`；
7. 字节用 `stream.pipeline` 送出：源流错误不会变成未捕获异常（**不会崩掉宿主进程**），
   客户端中断（拖动进度）也会销毁源流，**不泄漏 fd**。

### 令牌

- **签发**：`GET /dsh-media/api/token?path=<...>[&sessionId=<...>]` → `{ ok, path, contentType, token }`。
  它同样受回环、围栏、白名单约束，只认 `GET`；**不回字节**，只发令牌。
- **绑定**：令牌绑的是 `realpathSync` 之后的目标，所以同一个文件的绝对写法、相对写法（经会话）、
  符号链接、大小写差异都得到**同一个令牌**；换了文件则必然不同。
  客户端因此必须"先要令牌 → 用宿主回的 `path` 拼 `/raw` 地址"。
- **有效期**：**不过期**（与 `OrderG-X/dsh-video-preview` 一致）。播放器整段播放期间会不断发
  分段请求，短过期会让长视频中途断掉。代价是"泄漏的 URL 长期有效"。
- **轮换**：删掉 secret 文件（下次启动重新生成）即让**所有**既有令牌立刻失效。
- **密钥位置**：`$DSH_HOME/cache/dsh-media-sidebar.secret`（可用环境变量
  `DSH_MEDIA_SIDEBAR_SECRET_FILE` 覆盖，测试用它）。写入时带 `mode: 0o600`，
  但**Windows 上 chmod 是空操作** —— 实际保护来自用户 profile 的 ACL，这点不粉饰。
- **fail closed**：密钥准备失败就不注册任何路由，不会退化成"无签名端点"。

### 仍未消除的风险（已知并接受）

- **本地进程可读**：能连 `127.0.0.1` 的本机进程可以自己调 `/token` 拿令牌，再按绝对路径取文件。
  它本来就能直接读同一文件，所以本端点**不扩大它的能力**。令牌真正挡住的是
  **"URL 被记录 / 分享 / 出现在日志里"**这一类，以及围栏之外的第二道"你这个调用方有没有被授权读过这个文件"。
- **绝对路径按设计放行**：因此"可读集合"是**整台机器上的音频/视频文件**，仅由扩展名白名单约束。
  这是"工作区外的文件也要能播"的代价。需要的话可改成"只允许配置的目录前缀"。
- 无速率 / 并发上限；无 `ETag` / `Last-Modified`（每次拖动重读，无正确性问题）；
  令牌不过期（见上）。
- 客户端打开即自动播放（`autoPlay`，符合"点链接直接开始播放"的预期）；
  "最近打开"把绝对路径写进 `localStorage`。

## 测试

```sh
node --test test/     # 或 npm test
```

不打网络：用假的 `ctx` / `req` / `res` 直接驱动 `apply()` 注册出来的 handler，
测的就是真正会运行的那份代码。当前 **28 条**用例，覆盖：

- 回环检查、来源围栏（跨站 / 跨源 / 转发头）
- 扩展名白名单、未知子路由、方法限制
- Range：`start-end` / `start-` / `-suffix` / 不可解析回落到 200 / HEAD
- 相对路径的会话解析、`..` 逃逸
- **令牌**：缺令牌 / 别的文件的令牌 / 五种非法格式 / token 路由的围栏与 415 /
  绝对与相对写法归一到同一 `path` 与同一 `token` / 换密钥后旧令牌失效
- **转码**：原生格式 `mode = native`、转码不影响原生 Range、
  mkv 判为 `mode = transcode`（无 libx264 时必须是 `415 transcode-unavailable`）、
  以及**真跑一次 ffmpeg**，断言 `/raw` 回的是以 `ftyp` 开头的 MP4 流且 `accept-ranges: none`

> 转码那两条用例需要 ffmpeg + libx264；环境不具备时自动跳过（并用 `transcode-unavailable` 那条兜住）。

## 安装

从 GitHub 源码装（推荐；本包没有构建步骤，装完即用）：

```sh
dsh plugin --profile web add github:guwenwu112233-dot/dsh-media-sideba
```

或从本地目录装：

```sh
dsh plugin --profile web add /path/to/dsh-media-sidebar
```

装完**重启 DSH Desktop**（宿主插件只在进程启动时装载，客户端 bundle 按 revision 不可变，热重载都不管用）。

可选的转码支持：装好 `ffmpeg`（需要 **libx264**）并确保它在 PATH 上，或用
`DSH_MEDIA_SIDEBAR_FFMPEG_PATH` 指到具体可执行文件。没有 ffmpeg 时原生格式照常工作。

## 用法

右侧栏开始页 → **媒体播放器** → 输入文件绝对路径 → 播放。最近打开会记住（`localStorage`）。

聊天里点**媒体文件引用**（`dsh-resource://file/...`）也会直接开这个播放器并起播；
右侧栏**文件树**里点音视频文件同理。

## 已知限制

- **链接点击的适用范围**：本插件认领的是 `dsh-resource://file/...` 这类**应用内文件地址**。
  如果聊天里是一个普通 `http(s)` 链接，它归官方 Browser tab（受"链接偏好"控制），不会进本播放器。
- 聊天是否把某个文件渲染成可点击引用，取决于消息侧的引用形式，不由本插件决定；本插件只负责
  "一旦产生媒体文件地址，就由我接走并播放"。
- 不做播放列表。
- **解码取决于浏览器，转码取决于 ffmpeg**：原生格式（`flac`/`opus`/`mov` 等）在部分环境可能不被解码；
  转码格式（`mkv/avi/flv/wmv/wma`）**必须**有 ffmpeg + libx264，且**不支持拖动进度**（见上方「转码」）。
- 宿主半边与客户端半边都**只在进程启动时装载**：改完 `src/` 需要**重启 DSH Desktop**，
  热重载不适用于本插件的宿主模块，客户端 bundle 又是按 revision 不可变的。
