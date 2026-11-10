import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverShot, focusComposer } from '../src/client/send.js'

const FILE = { name: 'screenshot.png', type: 'image/png' }

/** 造一个最小可用的 conversation / shell，形状对齐 DSH 的真实对象。 */
function fakeHost(options = {}) {
  const calls = []
  const attachments = new Map()
  const state = {
    phase: options.phase ?? 'plain',
    draft: options.draft ?? '',
    attachmentIds: options.attachmentIds ?? [],
  }

  const conversation = {
    createDrafts(sessionId, files, uploadImages) {
      calls.push(['createDrafts', sessionId, files.length, uploadImages])
      return files.map((file, index) => {
        const id = `a${index + 1}`
        attachments.set(id, { id, kind: 'image', file })
        return { id, kind: 'image', file }
      })
    },
    releaseDraftAttachment(id) { calls.push(['release', id]); attachments.delete(id) },
    input: {
      shell(sessionId) {
        if (options.shellMissing === true) return undefined
        return {
          state: { getSnapshot: () => state },
          editor: { focus: () => calls.push(['focus']) },
          actions: {
            addAttachments(ids) {
              calls.push(['addAttachments', ...ids])
              if (options.refuseAttach === true) return false
              state.attachmentIds = [...state.attachmentIds, ...ids]
              return true
            },
          },
        }
      },
    },
  }

  const ctx = { get: (name) => (name === 'conversation' ? conversation : undefined) }
  return { ctx, calls, state }
}

test('交付：登记草稿附件 → 挂到输入框，不提交', async () => {
  const host = fakeHost()
  const result = await deliverShot({ ctx: host.ctx, sessionId: 's1', file: FILE })

  assert.deepEqual(result, { mode: 'drafted' })
  assert.deepEqual(host.calls.map((call) => call[0]), ['createDrafts', 'addAttachments'])
  assert.equal(host.calls[0][3], true, '必须走上传路径（uploadImages=true）')
})

test('交付后把光标还给输入框', async () => {
  const host = fakeHost()
  await deliverShot({ ctx: host.ctx, sessionId: 's1', file: FILE })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(host.calls.some((call) => call[0] === 'focus'), true)
})

test('输入框已有内容也照样附加——不读也不改用户的文字', async () => {
  const host = fakeHost({ draft: '我正在写一半' })
  const result = await deliverShot({ ctx: host.ctx, sessionId: 's1', file: FILE })

  assert.equal(result.mode, 'drafted')
  assert.equal(host.state.draft, '我正在写一半', '不得覆盖草稿文字')
  assert.equal(host.state.attachmentIds.length, 1)
})

test('输入框拒绝挂载：释放附件并报错', async () => {
  const host = fakeHost({ refuseAttach: true })
  await assert.rejects(() => deliverShot({ ctx: host.ctx, sessionId: 's1', file: FILE }), /拒绝了挂载/)
  assert.deepEqual(host.calls.map((call) => call[0]), ['createDrafts', 'addAttachments', 'release'])
})

test('输入框正在发送中：拒绝介入', async () => {
  const host = fakeHost({ phase: 'sending' })
  await assert.rejects(() => deliverShot({ ctx: host.ctx, sessionId: 's1', file: FILE }), /正在发送中/)
  assert.equal(host.calls.length, 0)
})

test('会话未挂载输入框：给出可诊断信息', async () => {
  const host = fakeHost({ shellMissing: true })
  await assert.rejects(() => deliverShot({ ctx: host.ctx, sessionId: 's9', file: FILE }), /未挂载/)
})

test('conversation 服务缺失：不静默失败', async () => {
  await assert.rejects(
    () => deliverShot({ ctx: { get: () => undefined }, sessionId: 's1', file: FILE }),
    /conversation 服务不可用/,
  )
})

test('focusComposer：editor 缺失或抛错时都不影响主流程', () => {
  assert.doesNotThrow(() => focusComposer({}))
  assert.doesNotThrow(() => focusComposer({ editor: { focus() { throw new Error('boom') } } }))
})
