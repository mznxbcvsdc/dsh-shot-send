import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { findScriptPath, pickRegion, resolvePython } from '../lib/pick.js'

/** 跑一次脚本并收集退出码与输出。 */
function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('框选脚本能被定位到 runtime/', () => {
  const script = findScriptPath()
  assert.ok(script !== null, '找不到 runtime/shot-win32.py')
  assert.ok(script.endsWith('shot-win32.py'), script)
})

test('纯函数自检：几何/裁剪/压暗表/PNG 编码', async (t) => {
  const python = await resolvePython()
  if (python === null || python === '') {
    t.skip('本机没有可用的 Python')
    return
  }
  const result = await runScript([python, findScriptPath(), '--selftest'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /selftest ok/)
})

test('取消契约：脚本以 exit 2 表示用户放弃', async (t) => {
  const python = await resolvePython()
  if (python === null || python === '') {
    t.skip('本机没有可用的 Python')
    return
  }
  const result = await runScript([python, findScriptPath(), '--selftest-cancel'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout.trim(), '', '取消时不应输出任何图像数据')
})

test('pickRegion 把 exit 2 翻成 { cancelled: true } 而不是抛错', async (t) => {
  const python = await resolvePython()
  if (python === null || python === '') {
    t.skip('本机没有可用的 Python')
    return
  }
  const previous = process.env.DSH_SHOT_SELFTEST
  process.env.DSH_SHOT_SELFTEST = 'selftest-cancel'
  try {
    const result = await pickRegion()
    assert.deepEqual(result, { cancelled: true })
  } finally {
    if (previous === undefined) delete process.env.DSH_SHOT_SELFTEST
    else process.env.DSH_SHOT_SELFTEST = previous
  }
})

test('并发保护：一次只允许一个框选', async (t) => {
  const python = await resolvePython()
  if (python === null || python === '') {
    t.skip('本机没有可用的 Python')
    return
  }
  process.env.DSH_SHOT_SELFTEST = 'selftest-cancel'
  try {
    const [first, second] = await Promise.allSettled([pickRegion(), pickRegion()])
    const rejected = [first, second].filter((entry) => entry.status === 'rejected')
    assert.equal(rejected.length, 1, '第二次调用应被拒绝')
    assert.match(String(rejected[0].reason?.message ?? ''), /已有一次框选/)
  } finally {
    delete process.env.DSH_SHOT_SELFTEST
  }
})

test('真实浮层端到端（默认跳过，设 DSH_SHOT_UI_TEST=1 启用）', async (t) => {
  if (process.env.DSH_SHOT_UI_TEST !== '1') {
    t.skip('会短暂接管屏幕，默认不跑')
    return
  }
  const python = await resolvePython()
  if (python === null || python === '') {
    t.skip('本机没有可用的 Python')
    return
  }
  process.env.DSH_SHOT_SELFTEST = 'selftest-ui'
  process.env.DSH_SHOT_HIDE = '0'
  try {
    const result = await pickRegion()
    assert.equal(result.cancelled, undefined)
    assert.equal(result.width, 600)
    assert.equal(result.height, 400)
    assert.match(result.dataUrl, /^data:image\/png;base64,iVBOR/)
  } finally {
    delete process.env.DSH_SHOT_SELFTEST
    delete process.env.DSH_SHOT_HIDE
  }
})
