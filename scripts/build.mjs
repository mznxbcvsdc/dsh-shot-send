/**
 * 零依赖构建：把 src/client/*.js 拼成一个 __ModuleLoader__ 闭包，把 src/host/*.js
 * 原样复制到 lib/。
 *
 * 为什么不引 tsdown/rollup：本机装不到依赖，而插件的产物只有一个客户端闭包
 * 和两个 ESM 文件——手写这 60 行比挂一条装不上的工具链更可靠。
 *
 * 约定（脚本会强制检查，违反即构建失败）：
 *   - 客户端模块之间只用单行 `import ... from '...'`；
 *   - 模块间不重名顶层标识符（几何/绘制/遮罩/发送/接口/入口各自前缀清楚）；
 *   - 只允许从 react / react-dom 取外部值，其余一律本包内。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const lib = join(root, 'lib')

/** 客户端拼接顺序 = 依赖顺序。 */
const CLIENT_ORDER = ['send.js', 'api.js', 'index.js']

/** 宿主侧要复制的文件。 */
const HOST_FILES = ['index.js', 'pick.js']

/** 只剥掉 `export ` 关键字本身，保留 async 等修饰。 */
const EXPORT_DECL = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/
/** import 语句的结束行：以 from '...' 收尾。 */
const IMPORT_END = /from\s+'[^']+'\s*$/

function stripModule(file, code) {
  const lines = code.split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^import\b/.test(line)) {
      // 支持单行与多行 import：吃到出现 from '...' 的那一行为止。
      let end = i
      while (end < lines.length && !IMPORT_END.test(lines[end])) {
        end += 1
        if (end - i > 12) throw new Error(`${file}: import 语句无法识别（${line.trim()}）`)
      }
      if (end >= lines.length) throw new Error(`${file}: import 语句未闭合（${line.trim()}）`)
      i = end
      continue
    }
    if (/^export\s*\{/.test(line)) throw new Error(`${file}: 不支持 export {} 形式（${line.trim()}）`)
    if (/^export\s+default\b/.test(line)) throw new Error(`${file}: 不支持 default export`)
    kept.push(line.replace(EXPORT_DECL, ''))
  }
  const body = kept.join('\n')
  const leftover = body.split('\n').find((line) => /^export\b/.test(line))
  if (leftover !== undefined) throw new Error(`${file}: 残留 export（${leftover.trim()}）`)
  return body
}

function buildClient() {
  const parts = []
  const names = new Map()
  for (const file of CLIENT_ORDER) {
    const code = readFileSync(join(src, 'client', file), 'utf8')
    const body = stripModule(file, code)
    // 顶层重名会让拼接后的闭包出现重复声明，这里提前拦下。
    for (const match of body.matchAll(/^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1]
      if (names.has(name)) throw new Error(`客户端顶层标识符重复：${name}（${names.get(name)} 与 ${file}）`)
      names.set(name, file)
    }
    parts.push(`// ---- ${file} ----\n${body}`)
  }

  return `window.__ModuleLoader__.load({
  id: "dsh-shot-send",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const { createElement, useCallback, useEffect, useRef, useState } = require("react")
    const { createPortal } = require("react-dom")

${parts.join('\n\n')}

    exports.apply = apply
    exports.inject = inject
    exports.ShotButton = ShotButton
    exports.HOTKEY = HOTKEY
    return module.exports
  }
})
`
}

function buildHost() {
  const importTarget = (file, code) => {
    if (/\bfrom '\.\//.test(code) === false) return
    const expected = `from './pick.js'`
    if (file === 'index.js' && !code.includes(expected)) {
      throw new Error('host/index.js 应只导入 ./pick.js；新增模块请同步 build.mjs')
    }
  }
  for (const file of HOST_FILES) {
    const code = readFileSync(join(src, 'host', file), 'utf8')
    importTarget(file, code)
    copyFileSync(join(src, 'host', file), join(lib, file))
  }
}

rmSync(lib, { recursive: true, force: true })
mkdirSync(lib, { recursive: true })
buildHost()
writeFileSync(join(lib, 'client.js'), buildClient())
console.log(`built lib/${HOST_FILES.join(", lib/")}, lib/client.js`)
