/**
 * dsh-shot-send · 宿主侧入口。
 *
 * 只暴露两条路由，都挂在 webServer 上、都走 DSH 自己的 Host/Origin 与鉴权闸门：
 *   POST /shot/api/pick     在真实屏幕上框选，返回裁剪后的 { dataUrl, width, height }
 *                           用户取消时返回 { cancelled: true }（不是错误）
 *   POST /shot/api/diag     报告框选后端可用性（排障用，不弹浮层）
 *
 * 图像数据不落盘、不经临时文件、不进日志：Python 子进程 stdout 直出 base64，
 * 经由 HTTP 响应交给渲染层。
 */
import { pickRegion, diagnose } from './pick.js'

/** 插件身份（cordis.yml 行名）。 */
export const name = 'dsh-shot-send'

/** webServer 提供服务端路由，connection 提供 Host/Origin 与鉴权闸门。 */
export const inject = ['webServer', 'connection']

const ROUTE_PICK = '/shot/api/pick'
const ROUTE_DIAG = '/shot/api/diag'

/** 请求体上限：本插件只收一个布尔开关，不需要更多。 */
const MAX_BODY_BYTES = 64 * 1024

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function writeError(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * 读 JSON 请求体。空体视为 {}。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed
}

/**
 * 注册一条路由，并把它绑到本插件的 effect 生命周期上。
 * @param {object} ctx
 * @param {{kind: 'exact'|'prefix', path: string, handler: Function}} route
 * @param {string} label
 */
function register(ctx, route, label) {
  ctx.effect(() => ctx.webServer.register(route), `dsh-shot-send: ${label}`)
}

/**
 * @param {object} ctx 宿主 cordis 上下文
 */
export function apply(ctx) {
  /** Host/Origin + 鉴权闸门：不是我们的判断，是宿主给的口径。 */
  const allowed = (req) => ctx.connection.requestRejection(req) === undefined

  register(ctx, {
    kind: 'exact',
    path: ROUTE_PICK,
    handler: async (req, res) => {
      if (!allowed(req)) {
        writeError(res, 403, 'forbidden', '请求被 Host/Origin 策略拒绝')
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method', '只接受 POST')
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        writeError(res, 400, 'bad-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        const value = await pickRegion({ hideWindow: body.hideWindow !== false })
        writeJson(res, 200, { ok: true, value })
      } catch (error) {
        writeError(res, 500, 'pick-failed', error instanceof Error ? error.message : String(error))
      }
    },
  }, ROUTE_PICK)

  register(ctx, {
    kind: 'exact',
    path: ROUTE_DIAG,
    handler: async (req, res) => {
      if (!allowed(req)) {
        writeError(res, 403, 'forbidden', '请求被 Host/Origin 策略拒绝')
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method', '只接受 POST')
        return
      }
      try {
        writeJson(res, 200, { ok: true, value: await diagnose() })
      } catch (error) {
        writeError(res, 500, 'diag-failed', error instanceof Error ? error.message : String(error))
      }
    },
  }, ROUTE_DIAG)
}
