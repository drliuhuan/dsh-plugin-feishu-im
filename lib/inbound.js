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

import { mkdir } from 'node:fs/promises'

import { PERMISSION_KEYS, PERMISSION_MODES } from './permissions.js'

/** Keep card labels short enough for a Feishu button. */
function clip(text, limit = 40) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`
}

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

/**
 * How a Feishu message enters a session.
 *
 * Running turn → `steer`: the message joins the turn in flight as guidance.
 * Idle turn   → `queue`: it is admitted as the next turn.
 * `/queue …`  → always `queue`, for "do this after the current task".
 */
export function deliveryMode(busy, wantsQueue = false) {
  return busy && !wantsQueue ? 'steer' : 'queue'
}

export function createInbound({ ctx, readState, writeState, log, trace, captures, onTextAnswer, sessions, restart, permissions, permissionCards, postCard, updateCardMessage }) {
  /** message ids already handled (Feishu redelivers on its own retry schedule). */
  const seen = new Set()
  const seenOrder = []
  /** sessionId → the chat waiting for that session's answer. */
  const pending = new Map()
  /** sessionId → the Typing reaction standing on the user's message. */
  const typing = new Map()
  /** chatId → the message id of the last session list card. */
  const listCards = new Map()

  /** The four permission modes, as buttons, with the current one marked. */
  function permissionCard(chatId, current, suggested) {
    const rows = []
    for (const key of PERMISSION_KEYS) {
      const mode = PERMISSION_MODES[key]
      rows.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: key === suggested ? `建议：${mode.label}` : (key === current ? `✓ ${mode.label}` : mode.label) },
            type: key === suggested ? 'primary' : 'default',
            value: { k: 'perm', c: chatId, m: key },
          },
        ],
      })
    }
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '会话权限' }, template: 'blue' },
      elements: [
        { tag: 'markdown', content: `**当前**：${PERMISSION_MODES[current]?.label || current}\n${PERMISSION_MODES[current]?.hint || ''}` },

        ...rows,
      ],
    }
  }

  /** Minimal card that records a completed switch: only the bound title. */
  function switchedCard(label) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '✅ 已切换会话' }, template: 'green' },
      elements: [{ tag: 'markdown', content: `**${label}**` }],
    }
  }

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
    // The card carries no list of titles: each button IS the entry, labelled
    // with the title and when it was last touched.
    const elements = [
      {
        tag: 'markdown',
        content: rows.length > 0
          ? `点下面的会话直接切换（最多 10 个）。要按关键字筛选，发 \`/sessions <关键字>\`。`
          : '没有匹配的会话。换个关键字试试：`/sessions <关键字>`。',
      },
    ]
    if (rows.length > 0) {
      const buttons = rows.slice(0, 10).map((row) => {
        const marker = row.sessionId === currentId ? '✓ ' : ''
        const label = `${marker}${clip(row.label, 16)} · ${sessions.relativeTime(row.updatedAt)}`
        return {
          tag: 'button',
          type: row.sessionId === currentId ? 'primary' : 'default',
          text: { tag: 'plain_text', content: label },
          value: { k: 'resume', sid: row.sessionId, label: row.label },
        }
      })
      // Two per row: titles are wide, and Feishu wraps longer rows awkwardly.
      for (let index = 0; index < buttons.length; index += 2) {
        elements.push({ tag: 'action', actions: buttons.slice(index, index + 2) })
      }
    }
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: query ? `📋 会话（${query}）` : '📋 会话列表' }, template: 'blue' },
      elements,
    }
    try {
      const sent = await postCard(chatId, card)
      if (sent?.messageId) listCards.set(chatId, sent.messageId)
    } catch (error) {
      await reply(chatId, `${sessions.format(rows, currentId)}\n\n（卡片发送失败：${String((error && error.message) || error)}）`)
    }
  }

  async function newSession() {
    // New Feishu conversations live in their own folder and workspace, both
    // configurable in Settings; the home default keeps them out of the project
    // tree the operator opened in the web UI.
    const state = await readState()
    const configured = sessions?.expandHome?.(state.sessionCwd) || ''
    const cwd = configured ||
      ctx.get?.('workingDirectory')?.defaultDirectory ||
      process.env.DSH_WORKSPACE ||
      process.cwd()
    try {
      // A missing folder is the normal first-run case, not an error.
      await mkdir(cwd, { recursive: true })
    } catch (error) {
      trace?.('session-cwd-failed', { cwd, message: String((error && error.message) || error) })
    }
    // Creating *through* the workspace is what puts the session in the group:
    // `create({cwd})` only sets the directory, it never attaches the session.
    const workspace = await sessions?.ensureWorkspace?.(cwd, state.workspaceTitle)
    const request = workspace && workspace.id ? { workspaceId: workspace.id } : { cwd }
    const created = await service('sessionController').create(request)
    trace?.('session-created', { workspace: workspace?.id ? 'attached' : 'cwd-only' })
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
          '/restart 重启 DSH（有任务在跑时会拒绝）',
          '/queue <内容> 排队处理（默认在任务运行时是插话引导）',
          '/permission（或 /mode）查看或切换本对话的权限模式',
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
          // The switch result belongs in the card that listed the sessions, not
          // in a new message: the list is replaced by the bound title.
          const cardId = listCards.get(chatId)
          if (cardId) {
            await updateCardMessage?.(cardId, switchedCard(row.label))
            listCards.delete(chatId)
          } else {
            await reply(chatId, `已切换到「${row.label}」。\n接下来的消息都会发给这个会话。`)
          }
        } catch (error) {
          await reply(chatId, `切换失败：${String((error && error.message) || error)}`)
        }
        return
      }

      let sessionId = state.chatSessions?.[chatId]
      if (command === '/new') {
        sessionId = await newSession()
        await writeState({ ...state, chatSessions: { ...(state.chatSessions || {}), [chatId]: sessionId } })
        await permissions?.applyToSession?.(sessionId, permissions.modeOf(await readState(), chatId))
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
        await permissions?.applyToSession?.(sessionId, permissions.modeOf(await readState(), chatId))
      }

      if (command === '/permission' || command === '/mode') {
        const argument = text.slice(command.length).trim().toLowerCase()
        const state = await readState()
        const current = permissions.modeOf(state, chatId)
        // Even with an argument nothing changes until the confirmation card is
        // accepted; the argument only pre-selects.
        const suggested = PERMISSION_KEYS.includes(argument) ? argument : undefined
        const card = permissionCard(chatId, current, suggested)
        const posted = await postCard(chatId, card)
        // Remembered so the answerer can retire this card by chat when the click
        // payload carries no message id.
        if (posted?.messageId) permissionCards?.set(chatId, posted.messageId)
        return
      }

      if (command === '/restart') {
        const result = await restart.request({ sessionId, reason: '来自飞书 /restart' })
        await reply(
          chatId,
          result.ok
            ? '🔁 正在重启 DSH；进程起来后我会再发一条「已重启完成」，刷新页面即可继续。'
            : `没有重启：${result.error}`,
        )
        return
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

      /*
       * While a turn is running the default is *steering* (`mode: 'steer'`):
       * the message joins the turn in flight as guidance instead of queueing a
       * second one behind it. `/queue <text>` asks for the old behaviour, and a
       * `/stop`-first flow stays available for a hard interrupt.
       */
      const wantsQueue = command === '/queue'
      const mode = deliveryMode(busy, wantsQueue)
      if (wantsQueue) trace?.('inbound-queue-requested', { session: String(sessionId).slice(0, 12) })

      try {
        await service('sessionController').prompt(
          {
            requestId: `feishu:${messageId}`,
            sessionId,
            mode,
            content: [{ type: 'text', text: body }],
          },
          // The controller takes a caller signal, not a source: it derives the
          // message source itself. Aborting only cancels admission.
          AbortSignal.timeout(30_000),
        )
        if (mode === 'steer') {
          await reply(
            chatId,
            '⚡ 已插话：这条会作为当前这一轮的补充指令，和正在跑的任务一起生效，不会另起一轮。'
              + '\n想等这一轮结束再处理，就在前面加 /queue；想直接打断，发 /stop。',
          )
        } else if (busy && wantsQueue) {
          await reply(chatId, '已排队：当前这一轮结束后就处理这条。')
        }
      } catch (error) {
        const message = String((error && error.message) || error)
        // Steering is only legal while the turn still accepts it (an approval
        // pause, for example, does not). Falling back keeps the message instead
        // of dropping it on the floor.
        if (mode === 'steer' && /steer-unavailable|no longer accepts steering/i.test(message)) {
          trace?.('inbound-steer-unavailable', { session: String(sessionId).slice(0, 12) })
          try {
            await service('sessionController').prompt(
              {
                requestId: `feishu:${messageId}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: body }],
              },
              AbortSignal.timeout(30_000),
            )
            await reply(chatId, '这一轮现在不接受插话（可能在等你批准某事），这条改成排队，本轮结束后处理。')
            return
          } catch (retryError) {
            trace?.('inbound-queue-failed', { message: String((retryError && retryError.message) || retryError).slice(0, 160) })
          }
        }
        pending.delete(String(sessionId))
        const standing = takeTyping(sessionId)
        if (standing) {
          const token = await getTenantToken(state.appId, state.appSecret, state.domain).catch(() => undefined)
          if (token) await removeReactionQuietly(token, state.domain, standing)
        }
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
