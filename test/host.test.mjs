/**
 * dsh-media-sidebar · 宿主半边单元测试
 *
 * 不打网络：用假的 `ctx` / `req` / `res` 直接驱动 `apply()` 注册出来的 handler。
 * 这样测的就是真正会跑的那份代码，而且改完不必重启就能回归。
 *
 * 运行： node --test test/
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/host/index.js'

/** 测试用的临时“工作区根”。 */
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-media-test-'))

// 密钥落到临时目录：别写进真实的 DSH home。
process.env.DSH_MEDIA_SIDEBAR_SECRET_FILE = join(ROOT, 'secret')

/**
 * 造一个合法的 8-bit 单声道 WAV（44 字节头 + 静音样本）。
 * 注意全部用显式小端写入 —— 不靠字符串拼接。
 *
 * @param {number} [samples] - 样本数
 * @returns {Buffer} 文件字节
 */
function wavBytes(samples = 800) {
  const dataLen = samples
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(8000, 24) // sample rate
  buf.writeUInt32LE(8000, 28) // byte rate
  buf.writeUInt16LE(1, 32) // block align
  buf.writeUInt16LE(8, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataLen, 40)
  buf.fill(128, 44)
  return buf
}

const WAV_PATH = join(ROOT, 'tone.wav')
const WAV_SIZE = 44 + 800
writeFileSync(WAV_PATH, wavBytes())
writeFileSync(join(ROOT, 'not-media.txt'), 'plain text')

/** ffmpeg 可执行文件（与插件同一条解析规则）。 */
const FFMPEG = process.env.DSH_MEDIA_SIDEBAR_FFMPEG_PATH ?? 'ffmpeg'

/**
 * 取 ffmpeg 的编码器清单（失败给空串）。
 *
 * @returns {string} `-encoders` 输出
 */
function ffmpegEncoders() {
  try {
    return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-encoders'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

/** 插件要求 libx264 才提供转码；测试跟着同一判据走。 */
const HAS_LIBX264 = /libx264/.test(ffmpegEncoders())

/** 造一个 mkv 样本（mpeg4 编码，浏览器解不了这种组合）。 */
const MKV_PATH = join(ROOT, 'clip.mkv')
let mkvUsable = false
if (HAS_LIBX264) {
  try {
    execFileSync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'testsrc=duration=1:size=64x64:rate=5', '-c:v', 'mpeg4', MKV_PATH],
      { timeout: 60_000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] },
    )
    mkvUsable = existsSync(MKV_PATH)
  } catch {
    mkvUsable = false
  }
}

after(() => { rmSync(ROOT, { recursive: true, force: true }) })

/**
 * 用假 ctx 挂载插件，拿回它注册的 handler。
 *
 * @returns {Function} HTTP handler
 */
function mountHandler() {
  let handler
  const ctx = {
    inject: (_deps, callback) => callback({
      webServer: {
        register: (route) => {
          handler = route.handler
          return () => {}
        },
      },
      sessions: {
        get: (id) => (id === 'known' ? { header: { cwd: ROOT } } : undefined),
      },
      effect: (fn) => {
        fn()
        return () => {}
      },
    }),
  }
  apply(ctx)
  assert.equal(typeof handler, 'function', 'apply() 必须注册出 handler')
  return handler
}

let handler = mountHandler()

/**
 * 打一次 handler，不做签名。
 *
 * @param {object} options - 参数
 * @param {string} options.url - 请求 URL
 * @param {string} [options.method] - 方法
 * @param {object} [options.headers] - 请求头
 * @param {string} [options.remote] - socket 远端地址
 * @returns {Promise<{status:number, headers:object, body:Buffer}>} 响应
 */
async function callHandler({ url, method = 'GET', headers = {}, remote = '127.0.0.1' }) {
  const chunks = []
  let status = 0
  let outHeaders = {}
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk)
      callback()
    },
  })
  res.writeHead = (code, hdrs) => {
    status = code
    outHeaders = hdrs ?? {}
  }
  const finished = new Promise((resolve) => res.on('finish', resolve))
  handler({ method, url, headers, socket: { remoteAddress: remote } }, res)
  await finished
  return { status, headers: outHeaders, body: Buffer.concat(chunks) }
}

/**
 * 默认走签名的请求：命中 `/raw` 时先向 `/token` 要令牌再带上。
 *
 * 这样"回环 / 围栏 / 白名单 / 会话解析"这些**前置**检查的用例不用改写 ——
 * 它们在令牌那一步就先返回同样的状态码。令牌本身的用例直接用 `callHandler`。
 *
 * @param {object} options - 同 `callHandler`
 * @returns {Promise<{status:number, headers:object, body:Buffer}>} 响应
 */
async function request(options) {
  const url = String(options.url || '')
  if (!url.startsWith('/dsh-media/api/raw')) return callHandler(options)
  const query = url.slice(url.indexOf('?') + 1)
  // 令牌路由只认 GET：HEAD 用例也要能签到令牌。
  const tokenResponse = await callHandler({ ...options, method: 'GET', url: `/dsh-media/api/token?${query}` })
  let token
  try {
    token = JSON.parse(tokenResponse.body.toString()).token
  } catch {
    token = undefined
  }
  return callHandler({ ...options, url: `${url}&token=${token ?? ''}` })
}

/** 拼字节路由。 */
const raw = (query) => `/dsh-media/api/raw?${query}`
const enc = encodeURIComponent

test('非回环来源一律 403', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), remote: '10.0.0.5' })
  assert.equal(r.status, 403)
  assert.equal(JSON.parse(r.body.toString()).code, 'loopback-only')
})

test('跨站取源被拒（网页探测入口）', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(r.status, 403)
  assert.equal(JSON.parse(r.body.toString()).code, 'origin-rejected')
})

test('跨源 Origin 被拒', async () => {
  const r = await request({
    url: raw(`path=${enc(WAV_PATH)}`),
    headers: { origin: 'https://evil.example', host: '127.0.0.1:43129' },
  })
  assert.equal(r.status, 403)
  assert.equal(JSON.parse(r.body.toString()).reason, 'cross-origin')
})

test('出现转发头即拒（反代下别把远端当回环）', async () => {
  for (const header of ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip']) {
    const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), headers: { [header]: '1.2.3.4' } })
    assert.equal(r.status, 403, `${header} 应被拒`)
    assert.equal(JSON.parse(r.body.toString()).reason, 'forwarded')
  }
})

test('合法的同源请求仍然 200，且头正确', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`) })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'audio/wav')
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.equal(r.headers['content-length'], String(WAV_SIZE))
  assert.equal(r.body.length, WAV_SIZE)
  assert.equal(r.body.toString('ascii', 0, 4), 'RIFF')
})

test('Range 返回 206 且 content-range 正确', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), headers: { range: 'bytes=0-99' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], `bytes 0-99/${WAV_SIZE}`)
  assert.equal(r.headers['content-length'], '100')
  assert.equal(r.body.length, 100)
})

test('start 与 suffix 两种 Range 都支持', async () => {
  const open = await request({ url: raw(`path=${enc(WAV_PATH)}`), headers: { range: 'bytes=800-' } })
  assert.equal(open.status, 206)
  assert.equal(open.headers['content-range'], `bytes 800-${WAV_SIZE - 1}/${WAV_SIZE}`)
  const suffix = await request({ url: raw(`path=${enc(WAV_PATH)}`), headers: { range: 'bytes=-10' } })
  assert.equal(suffix.status, 206)
  assert.equal(suffix.body.length, 10)
})

test('无法解析的 Range 回退成 200 整文件，而不是报错', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), headers: { range: 'bytes=0-9,20-29' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.length, WAV_SIZE)
})

test('HEAD 不返回正文', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), method: 'HEAD' })
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 0)
})

test('白名单之外一律 415（读不到任意文件）', async () => {
  const r = await request({ url: raw(`path=${enc(join(ROOT, 'not-media.txt'))}`) })
  assert.equal(r.status, 415)
  assert.equal(JSON.parse(r.body.toString()).code, 'media-only')
})

test('相对路径没有会话 → 400', async () => {
  const r = await request({ url: raw('path=tone.wav') })
  assert.equal(r.status, 400)
  assert.equal(JSON.parse(r.body.toString()).code, 'session-required-for-relative')
})

test('相对路径用 .. 逃出会话根 → 403', async () => {
  const r = await request({ url: raw(`path=${enc('../' + 'tone.wav')}&sessionId=known`) })
  assert.equal(r.status, 403)
  assert.equal(JSON.parse(r.body.toString()).code, 'outside-session-root')
})

test('相对路径落在会话根内 → 200', async () => {
  const r = await request({ url: raw('path=tone.wav&sessionId=known') })
  assert.equal(r.status, 200)
  assert.equal(r.body.length, WAV_SIZE)
})

test('未知会话 → 400', async () => {
  const r = await request({ url: raw('path=tone.wav&sessionId=nope') })
  assert.equal(r.status, 400)
})

test('非 GET/HEAD → 405', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), method: 'POST' })
  assert.equal(r.status, 405)
})

test('未知子路由 → 404', async () => {
  const r = await request({ url: '/dsh-media/api/nope' })
  assert.equal(r.status, 404)
})

test('/raw 不带令牌 → 403 bad-token', async () => {
  const r = await callHandler({ url: raw(`path=${enc(WAV_PATH)}`) })
  assert.equal(r.status, 403)
  assert.equal(JSON.parse(r.body.toString()).code, 'bad-token')
})

test('/raw 令牌不属于这个文件 → 403', async () => {
  const other = join(ROOT, 'other.wav')
  writeFileSync(other, wavBytes(100))
  const issued = await callHandler({ url: `/dsh-media/api/token?path=${enc(other)}` })
  const token = JSON.parse(issued.body.toString()).token
  const r = await callHandler({ url: raw(`path=${enc(WAV_PATH)}&token=${token}`) })
  assert.equal(r.status, 403)
  assert.equal(JSON.parse(r.body.toString()).code, 'bad-token')
})

test('/raw 令牌格式非法 → 403（不进入时序比较）', async () => {
  for (const bad of ['', 'not-a-token', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64)]) {
    const r = await callHandler({ url: raw(`path=${enc(WAV_PATH)}&token=${encodeURIComponent(bad)}`) })
    assert.equal(r.status, 403, `token=${bad} 应被拒`)
  }
})

test('令牌绑定 realpath：绝对写法与相对写法（经会话）得到同一令牌与同一路径', async () => {
  const absolute = await callHandler({ url: `/dsh-media/api/token?path=${enc(WAV_PATH)}` })
  const relative = await callHandler({ url: '/dsh-media/api/token?path=tone.wav&sessionId=known' })
  const a = JSON.parse(absolute.body.toString())
  const b = JSON.parse(relative.body.toString())
  assert.equal(a.status ?? 200, 200)
  assert.equal(b.ok, true)
  assert.equal(a.path, b.path)
  assert.equal(a.token, b.token)
  // 宿主回的路径必须是 canonical 绝对路径（大小写/短名已归一），客户端拿它去拼 /raw
  assert.equal(b.path, realpathSync(WAV_PATH))
})

test('令牌路由对非媒体扩展名仍然 415', async () => {
  const r = await callHandler({ url: `/dsh-media/api/token?path=${enc(join(ROOT, 'not-media.txt'))}` })
  assert.equal(r.status, 415)
})

test('令牌路由只认 GET', async () => {
  const r = await callHandler({ url: `/dsh-media/api/token?path=${enc(WAV_PATH)}`, method: 'POST' })
  assert.equal(r.status, 405)
})

test('令牌路由同样受来源围栏保护', async () => {
  const r = await callHandler({
    url: `/dsh-media/api/token?path=${enc(WAV_PATH)}`,
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(r.status, 403)
  assert.equal(JSON.parse(r.body.toString()).code, 'origin-rejected')
})

test('换掉密钥即让旧令牌全部失效（轮换语义）', async () => {
  const issued = await callHandler({ url: `/dsh-media/api/token?path=${enc(WAV_PATH)}` })
  const oldToken = JSON.parse(issued.body.toString()).token

  // 换一份等长合法密钥并重新挂载，等价于删掉 secret 文件后重启
  writeFileSync(process.env.DSH_MEDIA_SIDEBAR_SECRET_FILE, 'b'.repeat(64))
  handler = mountHandler()

  const stale = await callHandler({ url: raw(`path=${enc(WAV_PATH)}&token=${oldToken}`) })
  assert.equal(stale.status, 403)
  assert.equal(JSON.parse(stale.body.toString()).code, 'bad-token')

  const refreshed = await request({ url: raw(`path=${enc(WAV_PATH)}`) })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.length, WAV_SIZE)
})

test('原生格式的令牌响应 mode = native', async () => {
  const r = await request({ url: `/dsh-media/api/token?path=${enc(WAV_PATH)}` })
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body.toString())
  assert.equal(body.mode, 'native')
  assert.equal(body.contentType, 'audio/wav')
})

test('转码支持不影响原生格式的 Range', async () => {
  const r = await request({ url: raw(`path=${enc(WAV_PATH)}`), headers: { range: 'bytes=0-9' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.equal(r.body.length, 10)
})

test('mkv 判为转码模式；没有 libx264 时明确报 transcode-unavailable', {
  skip: HAS_LIBX264 && !mkvUsable ? '需要 ffmpeg + libx264' : false,
}, async () => {
  const r = await request({ url: `/dsh-media/api/token?path=${enc(MKV_PATH)}` })
  const body = JSON.parse(r.body.toString())
  if (body.code === 'transcode-unavailable') {
    // 没有 ffmpeg/libx264 的环境：必须明确拒绝，而不是给一个必然失败的流
    assert.equal(r.status, 415)
    assert.ok(typeof body.reason === 'string' && body.reason !== '')
    return
  }
  assert.equal(r.status, 200)
  assert.equal(body.mode, 'transcode')
  assert.equal(body.contentType, 'video/mp4')
})

test('mkv 转码：/raw 回的是 MP4 流，不是原文件', { skip: !mkvUsable }, async () => {
  const r = await request({ url: raw(`path=${enc(MKV_PATH)}`) })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'video/mp4')
  assert.equal(r.headers['accept-ranges'], 'none', '转码流不该声称支持 Range')
  assert.ok(r.body.length > 0, '应当有转码输出')
  // ISO-BMFF：偏移 4..8 是 'ftyp' box
  assert.equal(r.body.toString('ascii', 4, 8), 'ftyp')
})
