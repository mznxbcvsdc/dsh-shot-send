/**
 * dsh-shot-send · 浏览器侧入口。
 *
 * 只做三件事：在输入框右侧放一个相机按钮（也可用快捷键）→ 让宿主弹出
 * 覆盖整个桌面的框选浮层 → 把裁剪结果交给输入框。
 *
 * 为什么框选在宿主做：DSH 桌面端禁止渲染层使用 getDisplayMedia（主进程把
 * setDisplayMediaRequestHandler 实现成 callback({})），而网页内的遮罩只能覆盖
 * 应用窗口、把桌面缩进窗口里选。只有能创建置顶全屏窗口的进程，才能做到
 * 「整个屏幕变暗、在真实像素上框选」。
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { dataUrlToFile, pickRegion } from './api.js'
import { deliverShot } from './send.js'

/** 快捷键（页面级：DSH 窗口有焦点时生效；无壳则无法注册系统级热键）。 */
export const HOTKEY = { key: 's', ctrl: true, alt: true, shift: false }

const STRINGS = {
  zh: {
    button: '截图提问',
    tooltip: '框选屏幕并放进输入框，可继续写字或加附件（Ctrl+Alt+S）',
    picking: '在屏幕上框选…',
    drafted: '已放入输入框，按回车发送',
    cancelled: '已取消',
  },
  en: {
    button: 'Capture and ask',
    tooltip: 'Box-select the screen into the composer; keep typing or press Enter (Ctrl+Alt+S)',
    picking: 'Selecting on screen…',
    drafted: 'Added to the composer — press Enter to send',
    cancelled: 'Cancelled',
  },
}

function strings() {
  const lang = typeof document === 'undefined' ? 'zh' : (document.documentElement.lang || 'zh').toLowerCase()
  return lang.startsWith('zh') ? STRINGS.zh : STRINGS.en
}

const BUTTON_CSS = `
.dss-btn-wrap{position:relative;display:grid;place-items:center}
.dss-btn{background:0 0;border:none;border-radius:999px;width:28px;height:28px;padding:0;display:grid;place-items:center;cursor:pointer;color:var(--dsw-alias-label-secondary,#8a94a6);transition:background-color .15s,color .15s}
.dss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.dss-btn:disabled{opacity:.5;cursor:default}
.dss-btn[data-busy="1"]{animation:dss-pulse 1.2s ease-in-out infinite}
@keyframes dss-pulse{0%,100%{opacity:.45}50%{opacity:1}}
.dss-toast{position:fixed;bottom:96px;left:50%;transform:translateX(-50%);max-width:70vw;padding:6px 14px;border-radius:8px;font:13px/20px "Microsoft YaHei UI","PingFang SC",sans-serif;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(20,24,32,.95));color:var(--dsw-alias-label-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:2147483647;pointer-events:none}
.dss-toast[data-error="1"]{background:rgba(140,32,32,.96);color:#ffe6e6}
`

const BUTTON_STYLE_ID = 'dsh-shot-send/button.css'

function ensureButtonStyle() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-dss-css="${BUTTON_STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.dssCss = BUTTON_STYLE_ID
  tag.textContent = BUTTON_CSS
  document.head.appendChild(tag)
}

/** 快捷键的独占权：多个输入框同时挂载时只让最先挂载的响应。 */
let hotkeyOwner = null

function matchesHotkey(event) {
  return event.key.toLowerCase() === HOTKEY.key
    && event.ctrlKey === HOTKEY.ctrl
    && event.altKey === HOTKEY.alt
    && event.shiftKey === HOTKEY.shift
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 输入框右侧的相机按钮。
 * @param {object} props
 * @param {string} props.sessionId 由 slot 的 inject 注入
 * @param {object} props.ctx 客户端 cordis 上下文
 */
export function ShotButton({ sessionId, ctx }) {
  const text = strings()
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(0)
  const ownerRef = useRef(Symbol('dsh-shot-send'))
  const runningRef = useRef(false)

  const showToast = useCallback((message, isError) => {
    setToast({ message, isError: isError === true })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  useEffect(() => {
    ensureButtonStyle()
    return () => window.clearTimeout(toastTimer.current)
  }, [])

  const start = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    try {
      const picked = await pickRegion()
      if (picked.cancelled === true) {
        showToast(text.cancelled, false)
        return
      }
      const file = await dataUrlToFile(picked.dataUrl, 'screenshot.png')
      await deliverShot({ ctx, sessionId, file })
      showToast(text.drafted, false)
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), true)
    } finally {
      runningRef.current = false
      setBusy(false)
    }
  }, [ctx, sessionId, showToast, text.cancelled, text.drafted])

  // 快捷键：只在窗口有焦点时可用（无壳拿不到系统级热键）。
  useEffect(() => {
    if (hotkeyOwner !== null) return undefined
    hotkeyOwner = ownerRef.current
    const onKeyDown = (event) => {
      if (hotkeyOwner !== ownerRef.current) return
      if (isTypingTarget(event.target)) return
      if (!matchesHotkey(event)) return
      event.preventDefault()
      void start()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (hotkeyOwner === ownerRef.current) hotkeyOwner = null
    }
  }, [start])

  return createElement('div', { className: 'dss-btn-wrap' }, [
    createElement('button', {
      key: 'btn',
      type: 'button',
      className: 'dss-btn',
      disabled: busy,
      'data-busy': busy ? '1' : '0',
      title: busy ? text.picking : text.tooltip,
      'aria-label': text.button,
      onClick: () => { void start() },
    }, createElement('svg', { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', 'aria-hidden': true },
      createElement('path', {
        d: 'M5.1 3.2a.5.5 0 0 1 .4-.2h5a.5.5 0 0 1 .4.2l.9 1.2h2.2a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1h2.2l.9-1.2Zm-.06.8-.75 1H2v7h12v-7h-2.29l-.75-1H5.04ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-1.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z',
        fill: 'currentColor',
      }))),
    toast === null ? null : createElement('div', {
      key: 'toast', className: 'dss-toast', 'data-error': toast.isError ? '1' : '0', title: toast.message,
    }, toast.message),
  ])
}

/** 客户端服务依赖：只要槽位；conversation 服务在用到时再取，缺失可诊断且不会卡住加载。 */
export const inject = ['slots']

/**
 * 注册入口。
 * @param {object} ctx 客户端 cordis 上下文
 */
export function apply(ctx) {
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dsh-shot-send',
    // 比润色按钮（-10）再靠右一点，贴着发送键一侧。
    order: -9,
    inject: (sessionId) => ({ sessionId, ctx }),
  }, ShotButton))
}
