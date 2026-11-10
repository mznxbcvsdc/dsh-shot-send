/**
 * 把一张图交接到当前会话的输入框。
 *
 * 只做一件事：注册草稿附件 → 挂到输入框 → 把光标交回去。
 * 不发、不替你按回车——图进了输入框之后，写什么、发不发都是你的事。
 *
 * 依赖的公开面（均来自 @deepseek-ai/dsh-client-ui-conversation）：
 *   ctx.get('conversation').createDrafts(sessionId, files, uploadImages)
 *   ctx.get('conversation').input.shell(sessionId).{state, actions, editor}
 *   ctx.get('conversation').releaseDraftAttachment(id)
 */

/** 取 conversation 服务；缺失时给出可诊断的错误。 */
export function conversationOf(ctx) {
  const conversation = ctx.get('conversation')
  if (conversation === undefined || conversation === null) {
    throw new Error('conversation 服务不可用（宿主未加载 ui-conversation？）')
  }
  return conversation
}

/** 取某个会话的输入外壳与动作面。 */
export function composerOf(ctx, sessionId) {
  const conversation = conversationOf(ctx)
  if (typeof conversation.createDrafts !== 'function') {
    throw new Error('宿主版本不支持 createDrafts（需要 DSH >= 0.2.2-rc.1）')
  }
  if (conversation.input === undefined || typeof conversation.input.shell !== 'function') {
    throw new Error('会话输入服务不可用（conversation.input）')
  }
  const shell = conversation.input.shell(sessionId)
  if (shell === undefined || shell === null || shell.actions === undefined) {
    throw new Error(`会话 ${sessionId} 的输入框未挂载`)
  }
  return { conversation, shell }
}

/** 释放草稿附件（失败路径的兜底，不抛错）。 */
function release(conversation, ids) {
  for (const id of ids) {
    try {
      conversation.releaseDraftAttachment?.(id)
    } catch {
      // 释放失败不影响可观测结果，交给宿主下一次清扫。
    }
  }
}

/**
 * 把光标还给输入框，用户可以直接打字提问。
 * @param {object} shell
 */
export function focusComposer(shell) {
  // 让出一帧：遮罩卸载与焦点转移在同一批里做会被后者的清理覆盖。
  setTimeout(() => {
    try {
      shell.editor?.focus?.()
    } catch {
      // editor 是宿主的 Lexical 实例，接口变化时不该让交付失败。
    }
  }, 0)
}

/**
 * 交付一张截图到输入框。
 *
 * @param {object} params
 * @param {object} params.ctx 客户端 cordis 上下文
 * @param {string} params.sessionId 目标会话
 * @param {File} params.file 截图文件（image/png）
 * @returns {Promise<{mode: 'drafted'}>}
 */
export async function deliverShot({ ctx, sessionId, file }) {
  const { conversation, shell } = composerOf(ctx, sessionId)
  const state = shell.state.getSnapshot()

  if (state.phase !== 'plain') {
    throw new Error('输入框正在发送中，稍后再试')
  }

  const drafts = conversation.createDrafts(sessionId, [file], true)
  const ids = drafts.map((draft) => draft.id)
  if (ids.length !== 1) {
    release(conversation, ids)
    throw new Error('宿主未能登记这张图片（格式或尺寸不被接受）')
  }

  const attached = shell.actions.addAttachments(ids)
  if (!attached) {
    release(conversation, ids)
    throw new Error('输入框拒绝了挂载（可能已进入发送流程）')
  }

  focusComposer(shell)
  return { mode: 'drafted' }
}
