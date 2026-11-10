/**
 * 加载期校验：不信任「构建成功」，真正把产物跑起来看形状对不对。
 *
 * 1. 宿主产物：import 一次，检查 apply / inject / name。
 * 2. 客户端产物：在 vm 里造一个 __ModuleLoader__ 与 react 桩，执行闭包，
 *    检查导出面；顺带确认没有在模块顶层碰 document（那样会在宿主预加载时炸）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const problems = []
const ok = (message) => console.log(`  ok   ${message}`)
const bad = (message) => { problems.push(message); console.log(`  FAIL ${message}`) }

function checkHost() {
  console.log('host:')
  return import(new URL('../lib/index.js', import.meta.url).href).then((module) => {
    if (typeof module.apply === 'function') ok('导出 apply()')
    else bad('缺少 apply()')
    if (Array.isArray(module.inject) && module.inject.includes('webServer')) ok(`inject = ${JSON.stringify(module.inject)}`)
    else bad(`inject 不含 webServer：${JSON.stringify(module.inject)}`)
    if (module.name === 'dsh-shot-send') ok(`name = ${module.name}`)
    else bad(`name 不符：${module.name}`)
  }).catch((error) => bad(`宿主产物 import 失败：${error.message}`))
}

function checkClient() {
  console.log('client:')
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

  // 顶层的 document / window 访问只允许出现在函数体内；这里用最直接的探针：
  // 提供一个只有 __ModuleLoader__ 的 window，其余全空，若模块顶层碰了 DOM 就会抛。
  let registered = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => { registered = entry },
      },
    },
    console,
  }
  sandbox.globalThis = sandbox

  const createElement = (type, props, ...children) => ({ type, props, children })
  const stubs = {
    react: {
      createElement,
      useCallback: (fn) => fn,
      useEffect: () => undefined,
      useRef: (value) => ({ current: value }),
      useState: (value) => [value, () => undefined],
    },
    'react-dom': { createPortal: (node) => node },
  }

  try {
    vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' })
  } catch (error) {
    bad(`客户端产物执行失败：${error.message}`)
    return
  }

  if (registered === null) { bad('没有调用 window.__ModuleLoader__.load'); return }
  if (registered.id !== 'dsh-shot-send') bad(`loader id 不符：${registered.id}`)
  else ok(`loader id = ${registered.id}`)

  let exported
  try {
    exported = registered.factory((name) => {
      if (!(name in stubs)) throw new Error(`未声明的外部模块：${name}`)
      return stubs[name]
    })
  } catch (error) {
    bad(`factory 执行失败：${error.message}`)
    return
  }

  if (typeof exported.apply === 'function') ok('导出 apply()')
  else bad('缺少 apply()')
  if (Array.isArray(exported.inject) && exported.inject.includes('slots')) ok(`inject = ${JSON.stringify(exported.inject)}`)
  else bad(`inject 不含 slots：${JSON.stringify(exported.inject)}`)
  if (typeof exported.ShotButton === 'function') ok('导出 ShotButton()')
  else bad('缺少 ShotButton()')

  // 真跑一次 apply：槽位名 / id / inject 任一处写错，都会在这里暴露。
  const registrations = []
  const injected = []
  const ctx = {
    slots: {
      inject(slot, factory) {
        injected.push(slot)
        factory()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }
  try {
    exported.apply(ctx)
  } catch (error) {
    bad(`apply() 抛错：${error.message}`)
    return
  }

  if (injected[0] === 'conversation.input.right') ok('注入槽位 conversation.input.right')
  else bad(`槽位名不符：${injected[0]}`)
  const entry = registrations[0]
  if (entry === undefined) { bad('没有注册任何槽位'); return }
  if (entry.options?.name === 'conversation.input.right') ok(`register.name = ${entry.options.name}`)
  else bad(`register.name 不符：${entry.options?.name}`)
  if (entry.options?.id === 'dsh-shot-send') ok(`register.id = ${entry.options.id}`)
  else bad(`register.id 不符：${entry.options?.id}`)
  if (typeof entry.options?.inject !== 'function') { bad('register 缺少 inject（拿不到 sessionId）'); return }
  const props = entry.options.inject('session-1')
  if (props?.sessionId === 'session-1' && props?.ctx === ctx) ok('inject 透出 sessionId 与 ctx')
  else bad(`inject 返回不符：${JSON.stringify(Object.keys(props ?? {}))}`)
  if (typeof entry.component === 'function') ok('槽位挂载了 ShotButton')
  else bad('槽位组件不是函数')
}

await checkHost()
checkClient()

if (problems.length > 0) {
  console.error(`\n${problems.length} 项校验未通过`)
  process.exit(1)
}
console.log('\n产物形状校验通过')
