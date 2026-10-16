/**
 * dsh-media-sidebar · 浏览器半边
 *
 * 在 DSH 自带右侧栏注册**两个** tab 类型，共用同一个宿主字节路由：
 *
 *   1. 页类型 `dsh-media-sidebar:player`（kind `media`，`priority: 'extension'`，带 guide 入口）
 *      —— 手动输入绝对路径播放，用于"任意本地文件"。
 *
 *   2. 地址类型 `dsh-media-sidebar:file`（kind `media`，`priority: 'extension'`，
 *      `patterns: ['dsh-resource://file/**']`）
 *      —— 聊天里的**文件引用**走 `ctx.sidebarRight.openResource(<file 地址>)`，
 *      由 `patterns` + `canOpen` 分派；内置文件预览是 `priority: 'fallback'` 认同一批地址，
 *      我们档位更高、`canOpen` 更窄，所以媒体文件被我们接走，一点链接就起播。
 *
 * 契约来源（都是从官方 bundle 里读出来的，不是猜的）：
 *   - 注册字段 `{ id, kind, patterns, priority, canOpen, title }`
 *     —— `ui-deliverables` 的 changesReviewDefinition / `ui-sidebar-documentpreview` 的 textDefinition
 *   - 地址型正文 props 为 `{ useTabInfo, useResource, t }`，地址读作
 *     `useTabInfo().tab.navigation.address`（`ui-plan` 的 PlanPreview 原文）
 *   - 顶层必需服务导出形状 `exports.inject = ['slots','locale']`（dsh-knit 原文）
 *
 * 构建：无。手写脚本，由 __ModuleLoader__ 直接装载，用 React.createElement 而非 JSX。
 */

window.__ModuleLoader__.load({
  id: 'dsh-media-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 页类型 tab 的稳定 id。 */
    const TAB_ID = 'dsh-media-sidebar:player'
    /** 地址类型 tab 的稳定 id（也是它正文座位的 key）。 */
    const FILE_TAB_ID = 'dsh-media-sidebar:file'
    /** 两个类型共用的 kind。 */
    const KIND = 'media'
    /** 宿主字节路由。 */
    const RAW_API = '/dsh-media/api/raw'
    /** 宿主令牌路由（签发 HMAC(secret, realpath)）。 */
    const TOKEN_API = '/dsh-media/api/token'
    /** 我们认领的地址前缀。 */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    /** 最近打开列表的存储键。 */
    const RECENT_KEY = 'dsh-media-sidebar:recent'
    /** 最近打开最多记几条。 */
    const RECENT_MAX = 8

    /** 浏览器能直接解码的音频扩展名（对应宿主 NATIVE_TYPES 的音频部分）。 */
    const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'opus', 'weba'])

    /**
     * 视频扩展名 = 原生 + 需要转码的容器。
     *
     * 转码容器（mkv/avi/flv/wmv）在这里也要认，否则地址型 tab 的 `canOpen` 放行不了它，
     * 播放器也不会用 `<video>` 渲染。**是否真的转码由宿主决定**（见令牌响应里的 `mode`）。
     */
    const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv', 'avi', 'flv', 'wmv'])

    /** 需要 ffmpeg 转码的音频扩展名。 */
    const AUDIO_TRANSCODE_EXT = new Set(['wma'])

    /**
     * 取小写扩展名（不含点）。
     *
     * @param {string} value - 路径或文件名
     * @returns {string} 扩展名
     */
    function extOf(value) {
      const clean = String(value || '').split(/[?#]/)[0]
      const index = clean.lastIndexOf('.')
      return index < 0 ? '' : clean.slice(index + 1).toLowerCase()
    }

    /**
     * 判媒体种类。
     *
     * @param {string} value - 路径
     * @returns {'audio'|'video'|null} 种类，未知为 null
     */
    function kindOf(value) {
      const ext = extOf(value)
      if (AUDIO_EXT.has(ext) || AUDIO_TRANSCODE_EXT.has(ext)) return 'audio'
      if (VIDEO_EXT.has(ext)) return 'video'
      return null
    }

    /**
     * 从一个 `dsh-resource://file/...` 地址里拆出会话与路径。
     *
     * 地址形态（见 dsh-api-workspace-files README）：
     *   `dsh-resource://file/session/<sessionId>/<path>` —— 相对或绝对路径，前导斜杠保留
     *   `dsh-resource://file/absolute/<path>`            —— 无授权会话
     * 路径按段 URL 编码，所以这里整体解码一次。
     *
     * @param {string} address - 资源地址
     * @returns {{sessionId: string, path: string}} 会话 id 与解码后的路径
     */
    function fileAddressParts(address) {
      const text = String(address || '')
      if (!text.startsWith(FILE_ADDRESS_PREFIX)) return { sessionId: '', path: '' }
      let rest = text.slice(FILE_ADDRESS_PREFIX.length)
      let sessionId = ''
      if (rest.startsWith('session/')) {
        rest = rest.slice('session/'.length)
        const cut = rest.indexOf('/')
        sessionId = cut < 0 ? rest : rest.slice(0, cut)
        rest = cut < 0 ? '' : rest.slice(cut + 1)
      } else if (rest.startsWith('absolute/')) {
        rest = rest.slice('absolute/'.length)
      }
      let path = rest
      try {
        path = decodeURIComponent(path)
      } catch {
        /* 解码失败就用原样 */
      }
      // Windows 盘符：`/G:/dir/a.mp3` → `G:/dir/a.mp3`
      if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
      return { sessionId, path }
    }

    /**
     * 目录尾段（tab 标题用）。
     *
     * @param {string} path - 路径
     * @returns {string} 尾段
     */
    function basenameOf(path) {
      const parts = String(path || '').split(/[\\/]/)
      return parts[parts.length - 1] || path
    }

    /**
     * 拼路径查询串（令牌请求与字节请求共用）。
     *
     * @param {string} path - 绝对或相对路径
     * @param {string} [sessionId] - 相对路径所需的会话 id
     * @returns {string} 查询串
     */
    function mediaQuery(path, sessionId) {
      const head = `path=${encodeURIComponent(path)}`
      return sessionId ? `${head}&sessionId=${encodeURIComponent(sessionId)}` : head
    }

    /**
     * 拼带令牌的字节地址。
     *
     * 地址里用**宿主回的 canonical 路径**：令牌是 HMAC(secret, realpath)，
     * 用原始写法（符号链接 / 相对 / 大小写差异）会算不出一致的值。
     *
     * @param {string} canonicalPath - 宿主 realpath 之后的路径
     * @param {string} token - 宿主签发的令牌
     * @returns {string} URL
     */
    function rawUrl(canonicalPath, token) {
      return `${RAW_API}?${mediaQuery(canonicalPath, '')}&token=${encodeURIComponent(token)}`
    }

    /**
     * 从框架给的 props 里读当前 tab 的地址。
     *
     * 官方正文组件的形态是 `({ useTabInfo, useResource, t })` +
     * `useTabInfo().tab.navigation.address`；这里只防御性取值，不假设字段一定在。
     *
     * @param {object} props - 正文组件 props
     * @returns {{address: string, params: object|undefined}} 地址与附加参数
     */
    function readTabAddress(props) {
      try {
        const info = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : undefined
        const navigation = info?.tab?.navigation
        return { address: navigation?.address ?? '', params: navigation?.params }
      } catch {
        return { address: '', params: undefined }
      }
    }

    /**
     * 读最近打开列表（存储不可用时静默为空）。
     *
     * @returns {string[]} 路径数组
     */
    function readRecent() {
      try {
        const raw = window.localStorage.getItem(RECENT_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string').slice(0, RECENT_MAX) : []
      } catch {
        return []
      }
    }

    /**
     * 写最近打开列表。
     *
     * @param {string[]} list - 路径数组
     * @returns {void}
     */
    function writeRecent(list) {
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
      } catch {
        /* 隐私模式等场景下静默降级 */
      }
    }

    /** 共享样式。 */
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', fontSize: '12px', lineHeight: 1.5 },
      row: { display: 'flex', gap: '6px', alignItems: 'center' },
      input: {
        flex: '1 1 auto', minWidth: '0', boxSizing: 'border-box',
        padding: '5px 7px', fontSize: '12px', borderRadius: '6px',
        border: '1px solid var(--dsw-border, #3a3a3a)', background: 'transparent',
        color: 'inherit', fontFamily: 'inherit',
      },
      button: {
        flex: '0 0 auto', padding: '5px 10px', fontSize: '12px', borderRadius: '6px',
        border: '1px solid var(--dsw-border, #3a3a3a)', background: 'transparent',
        color: 'inherit', cursor: 'pointer', fontFamily: 'inherit',
      },
      muted: { opacity: 0.6 },
      error: { color: 'var(--dsw-danger, #e5534b)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      media: { width: '100%', maxHeight: '52vh', background: '#000', borderRadius: '6px' },
      recents: { display: 'flex', flexDirection: 'column', gap: '2px' },
      recent: {
        textAlign: 'left', padding: '3px 4px', fontSize: '11px', borderRadius: '4px',
        border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'inherit',
      },
    }

    /**
     * 取一个文件的可播放地址：先向宿主要令牌，再拼 `/raw` 地址。
     *
     * 令牌是 HMAC(secret, realpath)，所以顺序必须是"先要令牌 → 用宿主回的 canonical
     * 路径拼地址"；这样符号链接、相对写法、大小写差异都不会让校验失败。
     *
     * @param {string} path - 路径（绝对，或相对 + sessionId）
     * @param {string} [sessionId] - 相对路径所需的会话 id
     * @returns {{status: 'idle'|'loading'|'ready'|'error', src: string, path: string, mode: 'native'|'transcode', error: string}} 状态
     */
    function useMediaSource(path, sessionId) {
      const idle = { status: 'idle', src: '', path: '', mode: 'native', error: '' }
      const [state, setState] = React.useState(idle)
      React.useEffect(() => {
        if (!path) {
          setState(idle)
          return
        }
        let active = true
        setState({ status: 'loading', src: '', path: '', mode: 'native', error: '' })
        fetch(`${TOKEN_API}?${mediaQuery(path, sessionId)}`, { credentials: 'same-origin' })
          .then(async (response) => {
            const body = await response.json().catch(() => undefined)
            if (!active) return
            if (response.ok !== true || body?.ok !== true || typeof body.token !== 'string' || typeof body.path !== 'string') {
              const code = body?.code ?? `http-${response.status}`
              const extra = body?.reason !== undefined ? `（${body.reason}）` : ''
              setState({ status: 'error', src: '', path: '', mode: 'native', error: `宿主拒绝了这次读取：${code}${extra}` })
              return
            }
            setState({
              status: 'ready',
              src: rawUrl(body.path, body.token),
              path: body.path,
              mode: body.mode === 'transcode' ? 'transcode' : 'native',
              error: '',
            })
          })
          .catch((cause) => {
            if (!active) return
            setState({ status: 'error', src: '', path: '', mode: 'native', error: `取令牌失败：${String(cause?.message ?? cause)}` })
          })
        return () => { active = false }
      }, [path, sessionId])
      return state
    }

    /**
     * 带令牌的播放器。两种 tab 共用。
     *
     * @param {{path: string, sessionId?: string, onError?: Function}} props - 参数
     * @returns {import('react').ReactElement} 元素
     */
    function SignedPlayer({ path, sessionId, onError }) {
      const source = useMediaSource(path, sessionId)
      if (source.status === 'error') return h('div', { style: S.error }, source.error)
      if (source.status !== 'ready') return h('div', { style: S.muted }, '准备中…')
      const kind = kindOf(source.path)
      if (kind === null) return h('div', { style: S.error }, `不支持的扩展名：${source.path}`)
      const element = h(kind === 'audio' ? 'audio' : 'video', {
        src: source.src,
        controls: true,
        autoPlay: true,
        preload: 'metadata',
        style: kind === 'audio' ? undefined : S.media,
        onError,
      })
      if (source.mode !== 'transcode') return element
      // 转码模式：说清它为什么可能拖不动，别让用户以为是播放器坏了。
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
        element,
        h('div', { key: 'transcode-hint', style: S.muted },
          '转码播放（ffmpeg 实时转 H.264/AAC）。分片流没有索引，浏览器通常拿不到时长，所以多半不能拖动进度。'),
      ])
    }

    /**
     * guide 条目用的小图标（一个极简播放三角）。
     *
     * @param {{size?: number}} [props] - 尺寸
     * @returns {import('react').ReactElement} 图标元素
     */
    function MediaGlyph({ size = 16 } = {}) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        style: { display: 'block' },
      }, h('path', { d: 'M4 2.5v11l9-5.5-9-5.5z', fill: 'currentColor' }))
    }

    /**
     * 页类型正文：手动输入路径的播放器。
     *
     * @returns {import('react').ReactElement} 面板元素
     */
    function MediaPlayer() {
      const [draft, setDraft] = React.useState('')
      const [current, setCurrent] = React.useState(null)
      const [error, setError] = React.useState('')
      const [recents, setRecents] = React.useState(() => readRecent())

      const load = React.useCallback((input) => {
        const value = String(input || '').trim().replace(/^"(.*)"$/s, '$1')
        if (!value) return
        if (kindOf(value) === null) {
          setCurrent(null)
          setError(`不支持的扩展名。音频：${[...AUDIO_EXT].join(' ')}\n视频：${[...VIDEO_EXT].join(' ')}`)
          return
        }
        setError('')
        setDraft(value)
        setCurrent({ path: value, sessionId: '' })
        setRecents((previous) => {
          const next = [value, ...previous.filter((item) => item !== value)].slice(0, RECENT_MAX)
          writeRecent(next)
          return next
        })
      }, [])

      const children = [
        h('form', {
          key: 'form',
          onSubmit: (event) => {
            event.preventDefault()
            load(draft)
          },
          style: S.row,
        }, [
          h('input', {
            key: 'input',
            style: S.input,
            value: draft,
            spellCheck: false,
            placeholder: '绝对路径，例如 G:\\media\\a.mp3',
            onChange: (event) => setDraft(event.target.value),
          }),
          h('button', { key: 'go', type: 'submit', style: S.button }, '播放'),
        ]),
        h('div', { key: 'hint', style: S.muted },
          '手动打开用绝对路径。聊天里的文件引用会自动进这个播放器，不需要输入。'),
      ]

      if (error) children.push(h('div', { key: 'error', style: S.error }, error))

      if (current) {
        children.push(h(SignedPlayer, {
          key: 'player',
          path: current.path,
          sessionId: current.sessionId,
          onError: () => setError('浏览器无法解码这个文件（宿主已经放行，说明路径与令牌都没问题）。'),
        }))
        children.push(h('div', { key: 'path', style: { ...S.muted, wordBreak: 'break-all' } }, current.path))
      }

      if (recents.length > 0) {
        children.push(h('div', { key: 'recent-label', style: S.muted }, '最近'))
        children.push(h('div', { key: 'recents', style: S.recents },
          recents.map((item) => h('button', {
            key: item,
            type: 'button',
            style: S.recent,
            title: item,
            onClick: () => load(item),
          }, item))))
      }

      return h('div', { style: S.root }, children)
    }

    /**
     * 地址类型正文：聊天里点文件引用后就是这里起播。
     *
     * @param {object} props - 框架给的 `{ useTabInfo, useResource, t }`
     * @returns {import('react').ReactElement} 播放器元素
     */
    function MediaFileBody(props) {
      const { address } = readTabAddress(props)
      const parts = fileAddressParts(address)
      const [error, setError] = React.useState('')

      if (!address) {
        return h('div', { style: S.root }, h('div', { style: S.muted }, '等待地址…'))
      }
      if (kindOf(parts.path) === null) {
        return h('div', { style: S.root }, h('div', { style: S.error },
          `这个地址不是本播放器认的媒体：\n${parts.path || address}`))
      }

      const children = [
        h(SignedPlayer, {
          key: 'player',
          path: parts.path,
          sessionId: parts.sessionId,
          onError: () => setError('浏览器无法解码这个文件（宿主已经放行）。'),
        }),
        h('div', { key: 'path', style: { ...S.muted, wordBreak: 'break-all' } }, parts.path),
      ]
      if (error) children.push(h('div', { key: 'error', style: S.error }, error))
      return h('div', { style: S.root }, children)
    }

    /**
     * 地址类型的标题座位：显示文件名。
     *
     * @param {object} props - 框架给的 `{ useTabInfo }`
     * @returns {import('react').ReactElement} 标题元素
     */
    function MediaFileTitle(props) {
      const { address } = readTabAddress(props)
      const parts = fileAddressParts(address)
      return h('span', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        parts.path ? basenameOf(parts.path) : '媒体')
    }

    /**
     * 页类型的标题座位。
     *
     * @returns {import('react').ReactElement} 标题元素
     */
    function MediaTitle() {
      return h('span', { style: { fontSize: '12px' } }, '媒体播放器')
    }

    /**
     * 客户端插件体：把两个类型与三个座位挂到官方右侧栏。
     *
     * @param {import('@deepseek-ai/cordis').Context} ctx - 客户端根上下文
     * @returns {void}
     */
    function apply(ctx) {
      ctx.inject(['sidebarRightTabs'], (srCtx) => {
        const tabs = srCtx.sidebarRightTabs
        if (!tabs || typeof tabs.register !== 'function') {
          console.info('[dsh-media-sidebar] official right sidebar unavailable — skipping tab registration')
          return
        }

        // ① 页类型：guide 入口 + 手动输入路径。
        srCtx.effect(() => tabs.register({
          id: TAB_ID,
          kind: KIND,
          priority: 'extension',
          title: () => '媒体播放器',
          guide: [{
            order: 35,
            title: () => '媒体播放器',
            description: () => '在侧栏播放本地音频/视频文件（支持拖动进度）',
            icon: MediaGlyph,
          }],
        }), 'dsh-media-sidebar: player type')

        // ② 地址类型：接走聊天文件引用产生的 dsh-resource://file/... 媒体地址。
        //    内置文件预览是 priority 'fallback' 认同一批地址；我们档位更高、
        //    canOpen 更窄，所以只有媒体文件落到这里。
        srCtx.effect(() => tabs.register({
          id: FILE_TAB_ID,
          kind: 'media-file',
          patterns: [`${FILE_ADDRESS_PREFIX}**`],
          priority: 'extension',
          canOpen: (address) => kindOf(fileAddressParts(address).path) !== null,
          title: (address) => basenameOf(fileAddressParts(address).path) || '媒体',
        }), 'dsh-media-sidebar: file type')

        srCtx.effect(() => srCtx.slots.inject('sidebar.right.pane.tab', () => srCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, MediaPlayer)), 'dsh-media-sidebar: player body')

        srCtx.effect(() => srCtx.slots.inject('sidebar.right.pane.tab', () => srCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: FILE_TAB_ID,
        }, MediaFileBody)), 'dsh-media-sidebar: file body')

        srCtx.effect(() => srCtx.slots.inject('sidebar.right.pane.tab.title', () => srCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
        }, MediaTitle)), 'dsh-media-sidebar: player title')

        srCtx.effect(() => srCtx.slots.inject('sidebar.right.pane.tab.title', () => srCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: FILE_TAB_ID,
        }, MediaFileTitle)), 'dsh-media-sidebar: file title')

        console.log('[dsh-media-sidebar] registered on the official right sidebar: kinds =', KIND)
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
