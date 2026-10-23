/**
 * Feishu → DSH.
 *
 * One Feishu conversation maps to one DSH session. A message that passes the
 * allowlist is admitted through `sessionController.prompt`, which resumes a cold
 * session and reuses the Feishu message id as the prompt request id — Feishu
 * retries events, and that id is what makes a retry a no-op instead of a second
 * turn.
 *
 * The turn's answer is not pushed by the generic notifier: `takeReply` hands the
 * pending chat to the notifier, which answers in the chat that asked.
 */

import { addReaction, getTenantToken, removeReaction, sendText } from './feishu.js'

const MAX_SEEN = 500

function textOf(message) {
  const type = message?.message_type
  if (type !== 'text') return null
  try {
    const parsed = JSON.parse(message.content || '{}')
    let text = typeof parsed.text === 'string' ? parsed.text : ''
    for (const mention of message.mentions || []) {
      if (mention && mention.key) text = text.split(mention.key).join('')
    }
    return text.replace(/\s+/g, ' ').trim()
  } catch {
    return null
  }
}

function isBotSender(data) {
  const sender = data?.sender || {}
  return sender.sender_type === 'app' || sender.sender_type === 'bot'
}

export function createInbound({ ctx, readState, writeState, log, trace, captures, onTextAnswer, sessions, postCard }) {
  /** message ids already handled (Feishu redelivers on its own retry schedule). */
  const seen = new Set()
  const seenOrder = []
  /** sessionId → the chat waiting for that session's answer. */
  const pending = new Map()
  /** sessionId → the Typing reaction standing on the user's message. */
  const typing = new Map()

  function markSeen(id) {
    if (seen.has(id)) return false
    seen.add(id)
    seenOrder.push(id)
    if (seenOrder.length > MAX_SEEN) {
      const dropped = seenOrder.shift()
      if (dropped !== undefined) seen.delete(dropped)
    }
    return true
  }

  /** Hand the waiting chat to the notifier; absent when this turn was not ours. */
  function takeReply(sessionId) {
    const key = String(sessionId)
    const entry = pending.get(key)
    if (entry === undefined) return undefined
    pending.delete(key)
    return entry
  }

  /**
   * Resolve a Host service without declaring it as a hard dependency: the plugin
   * must still load in compositions that omit the session APIs, and `ctx.get`
   * is the documented optional-access form.
   */
  function service(name) {
    const value = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (value === undefined) throw new Error(`Host 服务 ${name} 不可用`)
    return value
  }

  /** Hand the standing Typing reaction to whoever answers the turn. */
  function takeTyping(sessionId) {
    const key = String(sessionId)
    const entry = typing.get(key)
    if (entry === undefined) return undefined
    typing.delete(key)
    return entry
  }

  /**
   * Mark the user's message as being worked on.
   *
   * Feishu renders no bot typing state; a `Typing` reaction on the incoming
   * message is the visible equivalent, and the notifier removes it when the turn
   * ends. A missing reaction scope degrades to no indicator.
   */
  async function markTyping(state, sessionId, messageId) {
    try {
      const token = await getTenantToken(state.appId, state.appSecret, state.domain)
      const result = await addReaction(token, state.domain, messageId, 'Typing')
      if (result?.reactionId) typing.set(String(sessionId), { messageId, reactionId: result.reactionId })
      else trace?.('typing-unavailable', { error: String(result?.error || 'unknown') })
    } catch (error) {
      trace?.('typing-unavailable', { error: String((error && error.message) || error) })
    }
  }

  async function removeReactionQuietly(token, domain, standing) {
    await removeReaction(token, domain, standing.messageId, standing.reactionId).catch(() => {})
  }

  async function reply(chatId, text) {
    const state = await readState()
    if (!state.appId || !state.appSecret) return
    const token = await getTenantToken(state.appId, state.appSecret, state.domain)
    await sendText(token, state.domain, { receiveId: chatId, receiveIdType: 'chat_id', text })
  }

  /** List sessions as a card with one switch button per row. */
  async function showSessions(chatId, query) {
    if (!sessions) {
      await reply(chatId, '会话列表不可用。')
      return
    }
    let rows
    try {
      rows = await sessions.list({ query, limit: 10 })
    } catch (error) {
      await reply(chatId, `读取会话失败：${String((error && error.message) || error)}`)
      return
    }
    sessions.remember(chatId, rows)
    const currentId = await sessions.current(chatId)
    const body = sessions.format(rows, currentId)
    const elements = [{ tag: 'markdown', content: body }]
    if (rows.length > 0) {
      const buttons = rows.slice(0, 8).map((row, index) => ({
        tag: 'button',
        type: 'default',
        text: { tag: 'plain_text', content: String(index + 1) },
        value: { k: 'resume', sid: row.sessionId, label: row.label },
      }))
      for (let index = 0; index < buttons.length; index += 4) {
        elements.push({ tag: 'action', actions: buttons.slice(index, index + 4) })
      }
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '点编号直接切换；也可以发 /resume <编号|id|标题>' }] })
    }
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: query ? `📋 会话（${query}）` : '📋 会话列表' }, template: 'blue' },
      elements,
    }
    try {
      await postCard(chatId, card)
    } catch (error) {
      await reply(chatId, `${body}\n\n（卡片发送失败：${String((error && error.message) || error)}）`)
    }
  }

  async function newSession() {
    const cwd =
      ctx.get?.('workingDirectory')?.defaultDirectory ||
      process.env.DSH_WORKSPACE ||
      process.cwd()
    const created = await service('sessionController').create({ cwd })
    return created.sessionId
  }

  async function handle(data) {
    let chatId = ''
    try {
      if (!data || !data.message) return
      if (isBotSender(data)) return

      const message = data.message
      const messageId = String(message.message_id || '')
      if (!messageId || !markSeen(messageId)) return
      if (message.chat_type === 'group' && !(message.mentions || []).length) return

      const text = textOf(message)
      chatId = String(message.chat_id || '')
      const openId = String(data.sender?.sender_id?.open_id || '')
      if (!chatId) return

      const state = await readState()
      if (!state.appId || !state.appSecret) {
        trace?.('inbound-skip', { reason: 'not-configured' })
        return
      }

      if (!text) {
        await reply(chatId, '目前只处理文本消息。')
        return
      }

      const allowlist = state.allowedOpenIds
      if (!allowlist.includes(openId)) {
        if (allowlist.length > 0) {
          trace?.('inbound-denied', { openId: openId.slice(0, 8) })
          return
        }
        // First contact with no allowlist configured: claim this user, because
        // only the app's own owner can reach a bot that was just created.
        const claimed = await writeState({ ...state, allowedOpenIds: [openId], ownerOpenId: state.ownerOpenId || openId })
        trace?.('inbound-claimed', { openId: openId.slice(0, 8) })
        await reply(chatId, '已把你设为这个机器人的唯一使用者。之后的对话都会转给 DSH。')
        state.allowedOpenIds = claimed.allowedOpenIds
      }

      // An armed "type your answer" capture owns the next message in this chat,
      // even when commands are disabled: it answers a prompt, it does not steer
      // the session.
      if (captures?.peek(chatId)) {
        const consumed = await onTextAnswer?.(chatId, text)
        if (consumed) {
          trace?.('inbound-answer-captured', { chars: text.length })
          return
        }
      } else if (captures?.takeExpired(chatId)) {
        // The capture timed out between two messages: say so once, then route
        // this message the ordinary way.
        trace?.('inbound-capture-expired', {})
        await reply(chatId, 'ℹ️ 之前的“输入答案”已超时，会话已切回原来的 DSH 会话；这句话会照常发给它。')
      }

      if (!state.allowCommands) {
        await reply(chatId, '在 DSH 设置里关闭了「允许在飞书里指挥」——现在只接收通知。')
        return
      }

      const command = text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase() : ''

      if (command === '/help') {
        await reply(chatId, [
          '直接把要做的事发给我就行；另外支持：',
          '/sessions [关键字]（或 /history）列出会话并点编号切换',
          '/resume <编号|id|标题> 切换当前会话',
          '/current 看当前绑定',
          '/new 开一个新会话',
          '/stop 让当前会话停下',
          '/id 看当前会话 id',
          '/help 这条说明',
        ].join('\n'))
        return
      }

      if (command === '/sessions' || command === '/history') {
        await showSessions(chatId, text.slice(command.length).trim())
        return
      }

      if (command === '/current') {
        const state0 = await readState()
        const currentId = state0.chatSessions?.[chatId]
        if (!currentId) {
          await reply(chatId, '这个对话还没绑定会话；发一句话就会自动开一个，或用 /sessions 选一个。')
          return
        }
        let label = String(currentId)
        try {
          const row = await sessions?.resolve(chatId, currentId)
          if (row) label = row.label
        } catch {
          // keep the id
        }
        await reply(chatId, `当前会话：${label}\n${currentId}`)
        return
      }

      if (command === '/resume') {
        const ref = text.slice(command.length).trim()
        if (!ref) {
          await reply(chatId, '用法：/resume <编号|id|标题>；先发 /sessions 看列表。')
          return
        }
        try {
          const row = await sessions.resolve(chatId, ref)
          await sessions.switchTo(chatId, row)
          await reply(chatId, `已切换到「${row.label}」。\n接下来的消息都会发给这个会话。`)
        } catch (error) {
          await reply(chatId, `切换失败：${String((error && error.message) || error)}`)
        }
        return
      }

      let sessionId = state.chatSessions?.[chatId]
      if (command === '/new') {
        sessionId = await newSession()
        await writeState({ ...state, chatSessions: { ...(state.chatSessions || {}), [chatId]: sessionId } })
        await reply(chatId, `新会话已开好：${sessionId}\n接下来发什么都进这个会话。`)
        return
      }

      if (!sessionId) {
        sessionId = await newSession()
        await writeState({
          ...state,
          chatSessions: { ...(state.chatSessions || {}), [chatId]: sessionId },
          homeChatId: state.homeChatId || chatId,
        })
      }

      if (command === '/stop') {
        const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(sessionId) : undefined
        if (!agent) {
          await reply(chatId, '这个会话当前没有在跑。')
          return
        }
        try {
          agent.cancel({ kind: 'user' })
          await reply(chatId, '已让它停下。')
        } catch (error) {
          await reply(chatId, `停不下来：${String((error && error.message) || error)}`)
        }
        return
      }

      if (command === '/id') {
        await reply(chatId, `会话：${sessionId}\n继续发消息即可。`)
        return
      }

      const body = command === '' ? text : text.slice(command.length).trim()
      if (!body) {
        await reply(chatId, '命令后面还需要内容，或者直接说要做的事。')
        return
      }

      const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(sessionId) : undefined
      const busy = agent?.status === 'running'
      trace?.('inbound-prompt', { session: String(sessionId).slice(0, 12), chars: body.length, busy })
      pending.set(String(sessionId), { chatId, at: Date.now(), messageId })
      await markTyping(state, sessionId, messageId)

      try {
        await service('sessionController').prompt(
          {
            requestId: `feishu:${messageId}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: body }],
          },
          // The controller takes a caller signal, not a source: it derives the
          // message source itself. Aborting only cancels admission.
          AbortSignal.timeout(30_000),
        )
        if (busy) {
          await reply(chatId, '当前还有任务在跑，这条已经排队，等它结束就处理。需要打断可以发 /stop。')
        }
      } catch (error) {
        pending.delete(String(sessionId))
        const standing = takeTyping(sessionId)
        if (standing) {
          const token = await getTenantToken(state.appId, state.appSecret, state.domain).catch(() => undefined)
          if (token) await removeReactionQuietly(token, state.domain, standing)
        }
        const message = String((error && error.message) || error)
        trace?.('inbound-failed', { message: message.slice(0, 200) })
        await reply(chatId, `没能把消息交给 DSH：${message}`)
      }
    } catch (error) {
      const message = String((error && error.message) || error)
      log(`[feishu-im] inbound failed: ${message}`)
      trace?.('inbound-error', { message: message.slice(0, 200) })
      if (chatId) {
        // Silence is the worst failure mode for a chat bridge: say what broke.
        await reply(chatId, `DSH 侧处理这条消息时出错了：${message}`).catch(() => {})
      }
    }
  }

  return { handle, takeReply, takeTyping }
}
