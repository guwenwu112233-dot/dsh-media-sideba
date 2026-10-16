/**
 * dsh-media-sidebar · 宿主半边
 *
 * 两条只读、只回环的路由：
 *
 *     GET /dsh-media/api/token?path=<绝对或相对路径>&sessionId=<会话 id>   → 签发该文件的令牌
 *     GET /dsh-media/api/raw?path=<...>&sessionId=<...>&token=<...>        → 回字节（原生格式支持 Range）
 *
 * `path` 为绝对路径时直接用；为相对路径时必须带 `sessionId`，相对会话工作区根
 * （`session.header.cwd`，与 dsh-knit 的 rootOfSession 同口径）解析，且必须落在该根之内。
 *
 * 两类文件：
 *   - **原生**：浏览器能直接解码（mp4/webm/mov/ogv/mp3/wav/…），按 Range 服务于原文件；
 *   - **转码**：浏览器普遍解不了的容器（mkv/avi/flv/wmv，音频 wma），用 ffmpeg 实时转成
 *     分片 MP4（H.264/AAC）流式送出。
 *
 * ⚠️ 转码模式的固有限制：实时转码产出的是**无索引的分片流**，浏览器拿不到时长，
 * **不支持拖动进度**。要做到可拖动，必须"先转码落盘缓存、再按 Range 服务"——那是另一种实现。
 * 客户端据 `mode` 字段显示对应提示。
 *
 * 安全模型（五层，逐层收紧）：
 *   1. 只接回环来源；
 *   2. 来源围栏：跨站取源 / 跨源 Origin / 任何转发头一律拒；
 *   3. 扩展名白名单：只有音视频扩展名能被读出，读不到非媒体文件；
 *   4. **HMAC 令牌**：令牌 = HMAC(secret, 文件的 realpath)，时序无关校验；
 *   5. 转码另有资源保护：并发上限、客户端断开即杀进程、硬超时。
 *
 * 密钥落盘 `$DSH_HOME/cache/dsh-media-sidebar.secret`（写入带 mode 0600；
 * **Windows 上 chmod 是空操作**，实际由用户 profile 的 ACL 保护）。删掉即轮换。
 */

import { spawn, execFileSync } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream'

/** 插件名（cordis 用它标识本插件）。 */
export const name = 'dsh-media-sidebar'

/** 路由前缀。 */
const ROUTE_PREFIX = '/dsh-media'

/** 签发令牌的路由。 */
const TOKEN_PATH = `${ROUTE_PREFIX}/api/token`

/** 回字节的路由。 */
const RAW_PATH = `${ROUTE_PREFIX}/api/raw`

/** 单文件上限：4 GiB。 */
const MAX_BYTES = 4 * 1024 * 1024 * 1024

/** 路径长度上限，防止病态长串。 */
const MAX_PATH_CHARS = 4096

/** 令牌形态：sha256 十六进制，固定 64 字符（定长才能安全地做时序无关比较）。 */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

/** 同时进行的转码上限：超出返回 429。转码吃 CPU，必须封顶。 */
const MAX_TRANSCODES = 2

/** 单次转码硬超时：到点杀掉，避免僵尸 ffmpeg 长期占 CPU。 */
const TRANSCODE_TIMEOUT_MS = 30 * 60 * 1000

/** 正在进行的转码数。 */
let activeTranscodes = 0

/**
 * 浏览器能直接解码的格式：按原文件 + Range 服务。
 *
 * @type {Map<string, string>}
 */
const NATIVE_TYPES = new Map([
  // 音频
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/ogg'],
  ['weba', 'audio/webm'],
  // 视频（与 dsh-knit 的 VIDEO_TYPES 对齐）
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['ogv', 'video/ogg'],
])

/**
 * 需要 ffmpeg 转码的格式 → 转码输出的 MIME。
 *
 * 这些容器浏览器普遍解不了（mkv 里可能是 h264 也可能是 vp9/ass 字幕，avi/flv/wmv 多是老编码）。
 * 想加格式就加一行 —— 决策逻辑只有 `resolveKind` 一处。
 *
 * @type {Map<string, string>}
 */
const TRANSCODE_TYPES = new Map([
  ['mkv', 'video/mp4'],
  ['avi', 'video/mp4'],
  ['flv', 'video/mp4'],
  ['wmv', 'video/mp4'],
  ['wma', 'audio/mp4'],
])

/**
 * 判一个扩展名怎么服务。
 *
 * @param {string} ext - 小写扩展名（不含点）
 * @returns {{mime: string, transcode: boolean}|undefined} 决策，未知为 undefined
 */
function resolveKind(ext) {
  const native = NATIVE_TYPES.get(ext)
  if (native !== undefined) return { mime: native, transcode: false }
  const transcoded = TRANSCODE_TYPES.get(ext)
  if (transcoded !== undefined) return { mime: transcoded, transcode: true }
  return undefined
}

/**
 * ffmpeg 可执行文件位置。环境变量覆盖点供测试与自定义安装使用。
 *
 * @returns {string} 可执行文件名或绝对路径
 */
function ffmpegPath() {
  const override = process.env.DSH_MEDIA_SIDEBAR_FFMPEG_PATH
  if (typeof override === 'string' && override !== '') return override
  return 'ffmpeg'
}

/**
 * 探测 ffmpeg 是否具备转码能力（只认 libx264）。
 *
 * 拿不到就**不提供**转码，而不是给出一个必然失败的流。
 *
 * @returns {{ready: boolean, reason: string}} 能力与原因
 */
function probeFfmpeg() {
  const binary = ffmpegPath()
  let output = ''
  try {
    output = execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-encoders'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) {
    return { ready: false, reason: `ffmpeg-unavailable:${String(error?.code ?? error?.message ?? error)}` }
  }
  if (!/libx264/.test(output)) return { ready: false, reason: 'no-libx264' }
  return { ready: true, reason: '' }
}

/**
 * 密钥文件路径。环境变量覆盖点仅供测试使用。
 *
 * @returns {string} 绝对路径
 */
function secretFilePath() {
  const override = process.env.DSH_MEDIA_SIDEBAR_SECRET_FILE
  if (typeof override === 'string' && override !== '') return override
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-media-sidebar.secret')
}

/**
 * 读取或首次生成密钥。
 *
 * 已有文件必须是 64 位十六进制，否则视为损坏并重新生成（旧令牌随之全部失效）。
 *
 * @returns {string} 64 位十六进制密钥
 */
function loadOrCreateSecret() {
  const file = secretFilePath()
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (TOKEN_PATTERN.test(existing)) return existing
  } catch {
    /* 不存在或读不到：下面生成 */
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

/**
 * 算一个文件（以 canonical 路径为准）的令牌。
 *
 * @param {string} secret - 密钥
 * @param {string} canonicalPath - realpath 之后的绝对路径
 * @returns {string} 64 位十六进制令牌
 */
function tokenFor(secret, canonicalPath) {
  return createHmac('sha256', secret).update(canonicalPath).digest('hex')
}

/**
 * 时序无关地校验令牌。
 *
 * @param {string} secret - 密钥
 * @param {string} canonicalPath - canonical 路径
 * @param {string} candidate - 请求带来的令牌
 * @returns {boolean} 是否匹配
 */
function tokenMatches(secret, canonicalPath, candidate) {
  if (typeof candidate !== 'string' || !TOKEN_PATTERN.test(candidate)) return false
  const expected = tokenFor(secret, canonicalPath)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'))
}

/**
 * 是不是回环来源。
 *
 * @param {string|undefined} address - socket 远端地址
 * @returns {boolean} 是否回环
 */
function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 解析一个会话的工作区根（口径照抄 dsh-knit）。
 *
 * @param {object|undefined} session - 宿主会话对象
 * @returns {string} 绝对根路径
 */
function rootOfSession(session) {
  let root = ''
  try {
    if (session && session.header && typeof session.header.cwd === 'string') root = session.header.cwd
  } catch {
    /* 取不到 cwd 就走兜底根 */
  }
  if (!root) root = process.cwd()
  if (root.startsWith('~')) root = join(homedir(), root.slice(1))
  return resolve(root)
}

/**
 * 请求来源围栏：只服务"应用自己发起的同源回环请求"。
 *
 * 判据（任一命中即拒）：
 *   1. `Sec-Fetch-Site: cross-site` —— 跨站取源，浏览器必带；
 *   2. 带 `Origin` 且其 host 与请求 `Host` 不一致 —— 跨源；
 *   3. 出现任何转发头 —— 不是直连回环（否则反代后 `remoteAddress` 全是回环）。
 *
 * @param {import('node:http').IncomingMessage} req - 请求
 * @returns {string|null} 拒绝原因，放行时为 null
 */
function rejectReason(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return 'cross-site-fetch'

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let host = ''
    try {
      host = new URL(origin).host
    } catch {
      return 'bad-origin'
    }
    if (host !== (req.headers.host ?? '')) return 'cross-origin'
  }

  for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
    if (req.headers[header] !== undefined) return 'forwarded'
  }
  return null
}

/**
 * 解析单区间 `Range` 头。
 *
 * 只支持 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；
 * 解析不了（多区间、语法怪异、越界）一律返回 `null`，调用方回退成 200 整文件 ——
 * 不要因为一个边角 Range 把播放掐死。
 *
 * @param {string|undefined} header - Range 头原值
 * @param {number} size - 文件字节数
 * @returns {{start:number,end:number}|null} 字节区间，或 null 表示整文件
 */
function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  if (!hasStart && !hasEnd) return null

  let start
  let end
  if (!hasStart) {
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = hasEnd ? Number(match[2]) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 回一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应对象
 * @param {number} status - HTTP 状态码
 * @param {object} body - 响应体
 * @returns {void}
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

/**
 * 把本地文件流出去。
 *
 * 必须用 `pipeline` 而不是 `readable.pipe(res)`：
 *   1. `pipe` 不处理源流错误 —— 文件在 stat 之后被删/无权限/IO 出错时，Readable 的
 *      'error' 没人接，Node 抛未捕获异常，**直接崩掉 DSH 宿主进程**；
 *   2. `pipe` 也不在目标关闭时销毁源 —— 播放器**每次拖动进度都会中断一个请求**，
 *      于是每拖一次泄漏一个文件描述符。
 *
 * @param {import('node:http').IncomingMessage} req - 请求
 * @param {import('node:http').ServerResponse} res - 响应
 * @param {string} abs - canonical 绝对路径
 * @param {number|undefined} start - 起始字节（整文件时为 undefined）
 * @param {number|undefined} end - 结束字节（含）
 * @returns {void}
 */
function streamFile(req, res, abs, start, end) {
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const source = start === undefined ? createReadStream(abs) : createReadStream(abs, { start, end })
  pipeline(source, res, (error) => {
    if (error === undefined) return
    // 客户端中途断开（拖动进度）也会走到这里，属正常路径：不记日志、不抛。
    try {
      res.destroy()
    } catch {
      /* 连接已销毁 */
    }
  })
}

/**
 * 回媒体字节，支持 Range。
 *
 * @param {import('node:http').IncomingMessage} req - 请求对象
 * @param {import('node:http').ServerResponse} res - 响应对象
 * @param {string} abs - canonical 绝对路径
 * @param {string} mime - MIME
 * @param {number} size - 文件字节数
 * @returns {void}
 */
function sendMedia(req, res, abs, mime, size) {
  const common = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  const part = parseRange(req.headers.range, size)
  if (part === null) {
    res.writeHead(200, { ...common, 'content-length': String(size) })
    streamFile(req, res, abs, undefined, undefined)
    return
  }
  res.writeHead(206, {
    ...common,
    'content-length': String(part.end - part.start + 1),
    'content-range': `bytes ${part.start}-${part.end}/${size}`,
  })
  streamFile(req, res, abs, part.start, part.end)
}

/**
 * 用 ffmpeg 把文件实时转成分片 MP4 流出去。
 *
 * ⚠️ 输出是**无索引的分片流**：浏览器能播但拿不到时长，**不能拖动**。
 * 想要可拖动得改成"转码落盘 + Range 服务"。
 *
 * 资源保护三件套（转码吃 CPU，不能敞口）：
 *   - 并发上限 `MAX_TRANSCODES`，超出 429；
 *   - 客户端断开就杀掉子进程；
 *   - 硬超时兜底。
 *
 * @param {import('node:http').IncomingMessage} req - 请求
 * @param {import('node:http').ServerResponse} res - 响应
 * @param {string} abs - canonical 绝对路径
 * @param {string} mime - 输出 MIME
 * @param {string} binary - ffmpeg 可执行文件
 * @returns {void}
 */
function streamTranscode(req, res, abs, mime, binary) {
  if (activeTranscodes >= MAX_TRANSCODES) {
    sendJson(res, 429, { ok: false, code: 'transcode-busy', active: activeTranscodes })
    return
  }
  if (req.method === 'HEAD') {
    // 转码是实时产物，没有确定的长度可报；给个空 200 而不是假装知道。
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'accept-ranges': 'none' })
    res.end()
    return
  }

  activeTranscodes += 1
  let settled = false
  /** 幂等收尾：计数只减一次。 */
  const release = () => {
    if (settled) return
    settled = true
    activeTranscodes -= 1
  }

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', abs,
    // `?` 让缺流不报错：纯音频文件没有视频流。
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ]
  let child
  try {
    child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    // spawn 同步抛错（参数非法等）不能让它冒到请求监听器外面 —— 那会崩掉宿主进程。
    release()
    sendJson(res, 500, { ok: false, code: 'transcode-failed', reason: String(error?.message ?? error) })
    return
  }
  const timer = setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }, TRANSCODE_TIMEOUT_MS)

  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 2000) stderr += String(chunk)
  })

  res.writeHead(200, {
    'content-type': mime,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'none',
  })

  // 客户端断开（切文件、关面板、拖动）就杀掉转码，别让它继续吃 CPU。
  res.on('close', () => {
    if (res.writableEnded) return
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  })

  child.on('error', (error) => {
    console.error(`[${name}] ffmpeg 启动失败：${String(error?.message ?? error)}`)
    release()
    clearTimeout(timer)
    try {
      res.destroy()
    } catch {
      /* 已销毁 */
    }
  })
  child.on('close', (codeCode) => {
    release()
    clearTimeout(timer)
    if (codeCode !== 0 && stderr !== '') {
      console.error(`[${name}] ffmpeg 退出码 ${codeCode}：${stderr.trim().slice(0, 500)}`)
    }
  })

  pipeline(child.stdout, res, (error) => {
    release()
    clearTimeout(timer)
    if (error !== undefined) {
      try {
        res.destroy()
      } catch {
        /* 已销毁 */
      }
    }
  })
}

/**
 * 解析请求里的路径：绝对路径直接用；相对路径绑定会话根并限制在根内。
 *
 * @param {object} webCtx - 注入了 webServer / sessions 的上下文
 * @param {URL} url - 请求 URL
 * @returns {{abs: string}|{status: number, body: object}} 成功给 abs，失败给要回的 JSON
 */
function resolvePath(webCtx, url) {
  const raw = (url.searchParams.get('path') || '').trim().replace(/^"(.*)"$/s, '$1')
  if (!raw) return { status: 400, body: { ok: false, code: 'missing-path' } }
  if (raw.length > MAX_PATH_CHARS) return { status: 414, body: { ok: false, code: 'path-too-long' } }

  if (isAbsolute(raw)) return { abs: raw }

  const sessionId = url.searchParams.get('sessionId') || ''
  const session = sessionId && typeof webCtx.sessions?.get === 'function'
    ? webCtx.sessions.get(sessionId)
    : undefined
  if (session === undefined) {
    return { status: 400, body: { ok: false, code: 'session-required-for-relative', sessionId } }
  }
  const root = rootOfSession(session)
  const candidate = resolve(root, raw)
  // 相对路径必须落在会话根之内：`..` 不能穿出去。
  // （绝对路径仍然放行 —— 那是调用方显式点名的文件，见 README 的安全边界。）
  const prefix = root.endsWith(sep) ? root : root + sep
  if (candidate !== root && !candidate.startsWith(prefix)) {
    return { status: 403, body: { ok: false, code: 'outside-session-root' } }
  }
  return { abs: candidate }
}

/**
 * 宿主插件体：等 webServer / sessions 到位后挂令牌与字节两条路由。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主根上下文
 * @returns {void}
 */
export function apply(ctx) {
  // 密钥拿不到就 fail closed：宁可不注册路由，也不提供无签名端点。
  let secret
  try {
    secret = loadOrCreateSecret()
  } catch (error) {
    console.error(`[${name}] 无法准备密钥，路由未注册（fail closed）：${String(error?.message ?? error)}`)
    return
  }

  const ffmpeg = ffmpegPath()
  const transcoder = probeFfmpeg()
  if (transcoder.ready) console.log(`[${name}] 转码可用：${ffmpeg}`)
  else console.log(`[${name}] 转码不可用（${transcoder.reason}）—— 原生格式不受影响`)

  ctx.inject(['webServer', 'sessions'], (webCtx) => {
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    const handler = (req, res) => {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, code: 'loopback-only' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
        return
      }

      // 来源围栏：挡住网页发起的跨站请求与反代进来的远端请求。见 rejectReason。
      const rejected = rejectReason(req)
      if (rejected !== null) {
        sendJson(res, 403, { ok: false, code: 'origin-rejected', reason: rejected })
        return
      }

      const url = new URL(req.url || '/', 'http://localhost')
      const isToken = url.pathname === TOKEN_PATH
      const isRaw = url.pathname === RAW_PATH
      if (!isToken && !isRaw) {
        sendJson(res, 404, { ok: false, code: 'not-found-route' })
        return
      }
      // 令牌路由只认 GET：它回的是 JSON，HEAD 回体会违协议。
      if (isToken && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
        return
      }

      const resolved = resolvePath(webCtx, url)
      if (resolved.abs === undefined) {
        sendJson(res, resolved.status, resolved.body)
        return
      }

      const ext = extname(resolved.abs).slice(1).toLowerCase()
      const kind = resolveKind(ext)
      if (kind === undefined) {
        sendJson(res, 415, { ok: false, code: 'media-only', ext })
        return
      }
      if (kind.transcode && !transcoder.ready) {
        sendJson(res, 415, { ok: false, code: 'transcode-unavailable', reason: transcoder.reason })
        return
      }

      // 令牌与下发都以 canonical 路径为准：符号链接、相对写法、大小写差异归一到同一份文件，
      // 于是"同一文件的令牌"唯一；realpath 也就顺手确认了文件存在。
      let canonical
      try {
        canonical = realpathSync(resolved.abs)
      } catch {
        sendJson(res, 404, { ok: false, code: 'not-found' })
        return
      }

      if (isToken) {
        sendJson(res, 200, {
          ok: true,
          path: canonical,
          contentType: kind.mime,
          mode: kind.transcode ? 'transcode' : 'native',
          token: tokenFor(secret, canonical),
        })
        return
      }

      if (!tokenMatches(secret, canonical, url.searchParams.get('token'))) {
        sendJson(res, 403, { ok: false, code: 'bad-token' })
        return
      }

      let stat
      try {
        stat = statSync(canonical)
      } catch {
        sendJson(res, 404, { ok: false, code: 'not-found' })
        return
      }
      if (!stat.isFile()) {
        sendJson(res, 400, { ok: false, code: 'not-a-file' })
        return
      }
      if (stat.size > MAX_BYTES) {
        sendJson(res, 413, { ok: false, code: 'too-large', size: stat.size })
        return
      }

      if (kind.transcode) streamTranscode(req, res, canonical, kind.mime, ffmpeg)
      else sendMedia(req, res, canonical, kind.mime, stat.size)
    }

    webCtx.effect(() => {
      const unregister = webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler,
      })
      console.log(`[${name}] routes ready: ${TOKEN_PATH}?path=<abs|rel> 与 ${RAW_PATH}?path=<abs|rel>&token=<token>`)
      return () => unregister()
    }, 'dsh-media-sidebar: routes')
  })
}
