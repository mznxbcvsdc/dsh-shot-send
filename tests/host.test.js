import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'

/**
 * 用假的 webServer / connection 装配真实产物，直接驱动 handler，
 * 覆盖闸门、方法、请求体与诊断四条路径（不触发真实抓屏）。
 */
function mount(options = {}) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      requestRejection(req) {
        if (options.reject === true) return 403
        return req.headers['x-test-forbidden'] === '1' ? 403 : undefined
      },
    },
    effect(factory) {
      disposers.push(factory())
    },
  }
  apply(ctx)
  return { routes, disposers }
}

function fakeReq({ method = 'POST', body = '', headers = {} } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body)]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  const record = { status: 0, headers: null, body: '' }
  return {
    record,
    writeHead(status, headers) { record.status = status; record.headers = headers },
    end(text) { record.body = text ?? '' },
  }
}

test('注册了两条精确路由，并已挂到 effect 生命周期', () => {
  const { routes, disposers } = mount()
  assert.deepEqual([...routes.keys()].sort(), ['/shot/api/diag', '/shot/api/pick'])
  assert.equal(routes.get('/shot/api/pick').kind, 'exact')
  assert.equal(disposers.length, 2)
})

test('闸门拒绝时返回 403，且不进入处理器', async () => {
  const { routes } = mount({ reject: true })
  const res = fakeRes()
  await routes.get('/shot/api/pick').handler(fakeReq(), res)
  assert.equal(res.record.status, 403)
  assert.equal(JSON.parse(res.record.body).error.code, 'forbidden')
})

test('闸门可针对单个请求放行或拒绝', async () => {
  const { routes } = mount()
  const res = fakeRes()
  await routes.get('/shot/api/diag').handler(fakeReq({ headers: { 'x-test-forbidden': '1' } }), res)
  assert.equal(res.record.status, 403)
})

test('非 POST 请求返回 405', async () => {
  const { routes } = mount()
  const res = fakeRes()
  await routes.get('/shot/api/pick').handler(fakeReq({ method: 'GET' }), res)
  assert.equal(res.record.status, 405)
})

test('非法 JSON 返回 400 而不是 500', async () => {
  const { routes } = mount()
  const res = fakeRes()
  await routes.get('/shot/api/pick').handler(fakeReq({ body: '{ not json' }), res)
  assert.equal(res.record.status, 400)
  assert.equal(JSON.parse(res.record.body).error.code, 'bad-request')
})

test('请求体超限返回 400', async () => {
  const { routes } = mount()
  const res = fakeRes()
  const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) })
  await routes.get('/shot/api/pick').handler(fakeReq({ body: big }), res)
  assert.equal(res.record.status, 400)
})

test('诊断接口报告平台与 Python 解析结果', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证')
    return
  }
  const { routes } = mount()
  const res = fakeRes()
  await routes.get('/shot/api/diag').handler(fakeReq({ body: '{}' }), res)
  assert.equal(res.record.status, 200)
  const body = JSON.parse(res.record.body)
  assert.equal(body.ok, true)
  assert.equal(body.value.supported, true)
  assert.ok(body.value.script.endsWith('shot-win32.py'))
  assert.ok(typeof body.value.python === 'string' && body.value.python.length > 0)
})
