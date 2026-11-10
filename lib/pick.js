/**
 * 宿主侧框选：spawn 一个 Python 进程，它自己完成「抓屏 → 原生全屏浮层 → 框选/标注 → 裁剪」，
 * 只把裁剪后的 PNG 以 base64 从 stdout 交回来。全程不落任何临时文件。
 *
 * 为什么框选必须发生在独立进程里：DSH 桌面端禁止渲染层用 getDisplayMedia，
 * 而网页内的遮罩只能覆盖应用窗口、把桌面缩进窗口里选——那不是截图工具该有的手感。
 * 只有能创建置顶全屏窗口的进程，才能做到「整个屏幕变暗、在真实像素上框选」。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 框选由人操作，超时只是防挂死的兜底——给足 5 分钟。
 * 注意它不同于抓屏延迟：进程起来的 0.3 s 内就会显示浮层。
 */
export const PICK_TIMEOUT_MS = 300000

/** Python 可用性探测的缓存。 */
let pythonProbe = null

/** 同一时刻只允许一次框选。 */
let inflight = null

/**
 * 允许通过环境变量传入的自检模式。
 * 白名单的意义：环境变量是外部可控输入，不能让它把任意参数塞进子进程。
 */
const SELFTEST_MODES = new Set(['selftest', 'selftest-cancel', 'selftest-ui'])

/** 框选脚本的位置：从当前文件向上找 runtime/ 目录。 */
export function findScriptPath() {
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'runtime', 'shot-win32.py')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 从进程可执行文件向上找 DSH 自带的 Python。
 * 桌面端把它放在 resources/runtime/primary-runtime/dependencies/python/。
 * @returns {string|null}
 */
export function bundledPython() {
  const suffix = join('runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe')
  let dir = dirname(process.execPath)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'resources', suffix)
    if (existsSync(candidate)) return candidate
    const direct = join(dir, suffix)
    if (existsSync(direct)) return direct
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 候选 Python，按优先级排列。
 * @returns {string[]}
 */
export function pythonCandidates() {
  const list = []
  if (typeof process.env.DSH_SHOT_PYTHON === 'string' && process.env.DSH_SHOT_PYTHON.trim() !== '') {
    list.push(process.env.DSH_SHOT_PYTHON.trim())
  }
  if (process.platform === 'win32') {
    list.push('python.exe', 'python', 'py')
  } else {
    list.push('python3', 'python')
  }
  const bundled = bundledPython()
  if (bundled !== null) list.push(bundled)
  return list
}

/** 试用一个 Python 可执行文件。 */
function tryPython(command) {
  return new Promise((resolvePromise) => {
    execFile(command, ['-c', 'import sys;sys.stdout.write("ok")'], { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        resolvePromise(error === null && stdout.trim() === 'ok' ? command : null)
      })
  })
}

/**
 * 解析可用的 Python（结果缓存）。
 * @returns {Promise<string|null>}
 */
export async function resolvePython() {
  if (pythonProbe !== null) return pythonProbe
  for (const candidate of pythonCandidates()) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await tryPython(candidate)
    if (ok !== null) {
      pythonProbe = ok
      return ok
    }
  }
  pythonProbe = ''
  return null
}

/**
 * 从 PNG 字节读宽高（IHDR 固定在第 16~24 字节）。
 * @param {Buffer} png
 * @returns {{width: number, height: number}|null}
 */
export function pngSize(png) {
  if (png.length < 24) return null
  if (png.readUInt32BE(0) !== 0x89504E47) return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * 让用户在真实屏幕上框选一块区域。
 *
 * 三种结局：
 *   选中  → { dataUrl, width, height, backend }
 *   取消  → { cancelled: true }
 *   失败  → 抛错（脚本缺失 / 无 Python / 无显示 / 超时）
 *
 * @param {{hideWindow?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<{dataUrl?: string, width?: number, height?: number, backend?: string, cancelled?: boolean}>}
 */
export async function pickRegion(options = {}) {
  if (process.platform !== 'win32') {
    throw new Error(`当前平台（${process.platform}）尚未实现框选后端；本插件目前只支持 Windows`)
  }
  if (inflight !== null) throw new Error('已有一次框选在进行中')

  const run = async () => {
    const script = findScriptPath()
    if (script === null) throw new Error('找不到框选脚本 runtime/shot-win32.py')
    const python = await resolvePython()
    if (python === null || python === '') {
      throw new Error('找不到可用的 Python 解释器；可用环境变量 DSH_SHOT_PYTHON 指定路径')
    }

    const timeoutMs = options.timeoutMs ?? PICK_TIMEOUT_MS
    const env = { ...process.env }
    if (options.hideWindow === false) env.DSH_SHOT_HIDE = '0'
    else delete env.DSH_SHOT_HIDE

    // 测试钩子：只接受白名单里的自检模式，且不接受任何会写文件的参数。
    // 生产路径不设该变量，argv 恒为 [script]。
    const args = [script]
    const selftest = process.env.DSH_SHOT_SELFTEST
    if (typeof selftest === 'string' && SELFTEST_MODES.has(selftest)) {
      args.push(`--${selftest}`)
    }

    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
      const chunks = []
      let stderr = ''
      let settled = false

      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== null) rejectPromise(error)
        else resolvePromise(value)
      }

      const timer = setTimeout(() => {
        child.kill()
        finish(new Error(`框选超时（>${Math.round(timeoutMs / 1000)} s）`))
      }, timeoutMs)

      child.stdout.on('data', (chunk) => { chunks.push(chunk) })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => finish(new Error(`无法启动 Python：${error.message}`)))
      child.on('close', (code) => {
        if (code === 2) { finish(null, { cancelled: true }); return }
        if (code !== 0) {
          const detail = stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${code}`
          finish(new Error(`框选失败：${detail}`))
          return
        }
        finish(null, { base64: Buffer.concat(chunks).toString('utf8').trim() })
      })
    })

    if (result.cancelled === true) return { cancelled: true }

    const base64 = result.base64 ?? ''
    if (base64 === '') throw new Error('框选没有返回图像')
    // 只解前 64 个 base64 字符就够读 IHDR。
    const dims = pngSize(Buffer.from(base64.slice(0, 64), 'base64'))
    if (dims === null) throw new Error('框选返回的不是有效 PNG')
    return {
      dataUrl: `data:image/png;base64,${base64}`,
      width: dims.width,
      height: dims.height,
      backend: 'win32-gdi-tk',
    }
  }

  const task = run()
  inflight = task
  try {
    return await task
  } finally {
    if (inflight === task) inflight = null
  }
}

/**
 * 诊断信息（供 /shot/api/diag 与排障使用）。
 * @returns {Promise<object>}
 */
export async function diagnose() {
  const script = findScriptPath()
  const python = await resolvePython()
  return {
    platform: process.platform,
    supported: process.platform === 'win32',
    script,
    python: python === '' ? null : python,
    candidates: pythonCandidates().map((value) => (value === python ? `${value} (active)` : value)),
  }
}
