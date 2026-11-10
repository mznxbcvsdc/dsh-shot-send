/**
 * 宿主抓屏接口。
 *
 * 走的是 webServer 的普通 HTTP 路由（同源），不是 Fetch 路由表：
 * 返回体是 2~4 MB 的 base64 PNG，用 node 的 res 直接写最省事。
 */

const ROUTE = '/shot/api/pick'

/**
 * 请求一次屏幕框选。宿主会弹出覆盖整个桌面的浮层，用户在真实像素上框选，
 * 返回的是**已裁剪**的图。
 *
 * 超时给足 5 分钟：等待的是人的操作，不是机器的响应。
 * @param {{hideWindow?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<{cancelled?: boolean, dataUrl?: string, width?: number, height?: number}>}
 */
export async function pickRegion(options = {}) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 300000)
  try {
    const response = await fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hideWindow: options.hideWindow }),
      signal: controller.signal,
    })
    let body
    try {
      body = await response.json()
    } catch {
      throw new Error(`抓屏接口返回了非 JSON（HTTP ${response.status}）`)
    }
    if (body?.ok !== true || body.value === undefined) {
      throw new Error(body?.error?.message ?? `框选失败（HTTP ${response.status}）`)
    }
    return body.value
  } finally {
    window.clearTimeout(timeout)
  }
}

/**
 * 诊断：宿主能否抓屏、用的是哪个后端。
 * @returns {Promise<object>}
 */
export async function probeBackend() {
  const response = await fetch('/shot/api/diag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return await response.json()
}

/** dataUrl → File（浏览器自带解码，不手写 base64 解析）。 */
export async function dataUrlToFile(dataUrl, name = 'screenshot.png') {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], name, { type: 'image/png' })
}
