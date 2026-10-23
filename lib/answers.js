import { getTenantToken, sendText, updateCard } from './feishu.js'
import { PERMISSION_MODES, shouldAutoApprove } from './permissions.js'

/**
 * Remote answering: approvals and structured questions as Feishu cards.
 *
 * Two routing modes (`answerMode`):
 *
 *   - `feishu` (default): the card is the only prompt. The listener answers the
 *     request itself, so no web prompt is ever created — which is what makes a
 *     Feishu answer final. The page cannot dismiss a prompt the Host forwarded;
 *     the only way to guarantee "answered in Feishu, no longer asked in DSH" is
 *     not to ask there in the first place.
 *   - `both`: both surfaces ask and the first answer wins. Convenient when the
 *     operator is at the desk, at the cost of a web prompt that outlives a
 *     Feishu answer (it clears when the turn ends).
 *
 * Whichever path answers, it answers through the same waterfall the in-page
 * click uses, so the audit pair (`approval/asked` + `approval/decided`) and the
 * question reply are recorded identically.
 *
 * Buttons carry `{ k, id, v }`; `handleCardAction` matches them against the
 * waiting table, checks the operator against the allowlist, and resolves the
 * pending promise. A card that is never clicked is abandoned when the request's
 * own signal aborts or after MAX_WAIT_MS.
 */

/** Fallback wait when the setting is absent; the configured value wins. */
const DEFAULT_WAIT_MINUTES = 5

/** Remember why a request stopped accepting clicks, for the late-tap toast. */
const RESOLVED_TTL_MS = 30 * 60 * 1000
const RESOLVED_MAX = 200

function button(label, type, value) {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type, value }
}

function card(body, title, template) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: body,
  }
}

function note(text) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content: text }] }
}

function markdown(content) {
  return { tag: 'div', text: { tag: 'lark_md', content } }
}

function clip(text, limit = 240) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function sessionShort(session) {
  return String(session?.id || session?.session?.id || '').replace(/^session-/, '').slice(0, 8)
}

export function createAnswerers({
  permissions,
  ctx, readState, sendCard, log, trace, isAllowed, describe, captures, onResume }) {
  /** id → waiting entry */
  const waiting = new Map()
  /** id → why it closed, so a late tap can say what happened. */
  const resolved = new Map()
  /** Unregister functions for the two waterfall listeners. */
  let disposers = []
  let mode = null

  /** Resolve every outstanding wait with "no answer" (plugin unload). */
  function abandonAll() {
    for (const [id, entry] of waiting) {
      waiting.delete(id)
      entry.resolve(undefined)
    }
  }

  function remember(id, reason) {
    resolved.set(id, { reason, at: Date.now() })
    if (resolved.size > RESOLVED_MAX) {
      const oldest = resolved.keys().next()
      if (!oldest.done) resolved.delete(oldest.value)
    }
    const cutoff = Date.now() - RESOLVED_TTL_MS
    for (const [key, value] of resolved) {
      if (value.at < cutoff) resolved.delete(key)
    }
  }

  function settle(id, result, reason) {
    const entry = waiting.get(id)
    if (!entry) return false
    waiting.delete(id)
    if (reason) remember(id, reason)
    entry.resolve(result)
    return true
  }

  /** Wait for a click; `undefined` means "no answer" (timeout or cancel). */
  function wait(id, payload) {
    return new Promise((resolve) => {
      const timer = payload.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (waiting.delete(id)) {
              remember(id, 'timeout')
              trace?.('answer-timeout', { id: id.slice(0, 8) })
            }
            resolve(undefined)
          }, payload.timeoutMs)
      timer?.unref?.()
      waiting.set(id, {
        at: Date.now(),
        messageId: payload.messageId,
        chatId: payload.chatId,
        card: payload.card,
        meta: payload.meta,
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
      })
    })
  }

  /** Configured wait in ms, or `undefined` for "wait forever". */
  function waitMsOf(state) {
    const minutes = Number.isFinite(state.answerTimeoutMinutes)
      ? state.answerTimeoutMinutes
      : DEFAULT_WAIT_MINUTES
    return minutes > 0 ? minutes * 60 * 1000 : undefined
  }

  /**
   * Rebuild a question/approval card in its final state: no option buttons, the
   * title states what happened, and every question is rendered as
   * `问题：答案`.
   */
  function resolvedCard({ title, template, meta, lines, footer }) {
    const elements = lines.filter(Boolean).map((line) => markdown(line))
    if (meta?.label) elements.push(note(`会话 ${meta.label}`))
    if (footer) elements.push(markdown(`<font color='grey'>${footer}</font>`))
    if (elements.length === 0) elements.push(markdown('（无内容）'))
    return card(elements, title, template)
  }

  /** `问题：答案` lines for one answer batch. */
  function answerLines(meta, answers) {
    const byId = new Map()
    for (const item of answers || []) byId.set(item.id, item)
    return (meta?.questions || []).map((question) => {
      const item = byId.get(question.id)
      const text = item?.custom
        ? `${item.custom}（输入）`
        : (item?.selected || []).filter(Boolean).join('、')
      return `**${clip(question.question || question.header || question.id, 200)}**：${text || '（未作答）'}`
    })
  }

  /**
   * Replace the question card of one waiting entry with its answered form.
   * @param options.routed - whether answering changed the chat's message routing
   *   (free-form capture); the card then states where messages go now.
   */
  async function markAnswered(entry, answers, options = {}) {
    if (!entry?.messageId) return
    const state = await readState()
    if (!state.appId || !state.appSecret) return
    const card = resolvedCard({
        title: '✅ 已作答',
        template: 'green',
        meta: entry.meta,
        lines: answerLines(entry.meta, answers),
      footer: options.routed ? '消息路由：已切回原来的会话，接下来的消息会照常发给 DSH。' : undefined,
    })
    const result = await updateCard(state, entry.messageId, card)
    if (result?.error) trace?.('answer-card-answered-failed', { error: result.error })
    return card
  }

  /** Where a card should go: the home chat, else the owner's DM. */
  async function target() {
    const state = await readState()
    if (!state.appId || !state.appSecret) return null
    const chatId = state.homeChatId
    const openId = state.ownerOpenId || state.allowedOpenIds[0]
    if (chatId) return { receiveId: chatId, receiveIdType: 'chat_id', state }
    if (openId) return { receiveId: openId, receiveIdType: 'open_id', state }
    return null
  }

  /**
   * Post one card, remembering the chat it went to (card action payloads carry
   * no chat id). A refused card falls back to a text line so the request is
   * never lost.
   */
  async function post(cardJson, fallbackText) {
    const to = await target()
    if (!to) {
      trace?.('answer-skip', { reason: 'no-target' })
      return undefined
    }
    try {
      const sent = await sendCard(to.state, to, cardJson)
      return { messageId: sent.messageId, chatId: to.receiveId }
    } catch (error) {
      trace?.('answer-card-failed', { message: String((error && error.message) || error) })
      try {
        const token = await getTenantToken(to.state.appId, to.state.appSecret, to.state.domain)
        await sendText(token, to.state.domain, {
          receiveId: to.receiveId,
          receiveIdType: to.receiveIdType,
          text: fallbackText,
        })
      } catch {
        // Nothing else to try.
      }
      return undefined
    }
  }

  /**
   * Response for a card action that also replaces the card.
   *
   * Feishu re-renders the card as part of handling the click; a separate PATCH
   * that lands first can be overwritten by that re-render ("it flashed and
   * reverted"). Returning the new card in the callback body wins the race, and
   * the PATCH we pass along keeps the stored copy correct for every client.
   */
  function respondWith(toast, card) {
    return card ? { toast, card: { type: 'raw', data: card } } : { toast }
  }

  /** Send one plain-text line into a chat. */
  async function notifyChat(chatId, text) {
    try {
      const state = await readState()
      if (!state.appId || !state.appSecret || !chatId) return
      const token = await getTenantToken(state.appId, state.appSecret, state.domain)
      await sendText(token, state.domain, { receiveId: chatId, receiveIdType: 'chat_id', text })
    } catch (error) {
      trace?.('chat-notice-failed', { message: String((error && error.message) || error) })
    }
  }

  /**
   * Feed one chat message into an armed free-form capture.
   * @returns whether the message was consumed as an answer.
   */
  async function submitText(chatId, text) {
    const entry = captures?.take(chatId)
    if (entry === undefined) return false
    const accepted = settle(entry.cardId, { questionId: entry.questionId, label: text, custom: true }, 'answered')
    trace?.('answer-text', { card: entry.cardId.slice(0, 8), accepted, chars: text.length })
    if (!accepted) {
      await notifyChat(chatId, '这个问题已经结束了，这句话没有作为答案。')
      return true
    }
    // The question card is rewritten by onQuestions once the batch settles, with
    // the routing footer that a typed answer implies.
    return true
  }

  /** `approval/request` listener body, in either registration mode. */
  /**
   * Handle one `card.action.trigger` payload.
   * @returns the callback response, or undefined when the action is not ours.
   */
  async function handleCardAction(data) {
    try {
      const value = data?.action?.value
      if (!value || typeof value !== 'object') return undefined
      const kind = String(value.k || '')
      if (kind !== 'approval' && kind !== 'question' && kind !== 'freeform' && kind !== 'resume' && kind !== 'perm') {
        return undefined
      }

      const openId = String(data?.operator?.open_id || '')
      if (openId && !(await isAllowed(openId))) {
        trace?.('answer-denied', { openId: openId.slice(0, 8) })
        return { toast: { type: 'error', content: '你不在允许列表里，已忽略。' } }
      }

      if (kind === 'perm') {
        const mode = String(value.m || '')
        const state = await readState()
        const chatId = String(data?.chatId || '') || String(data?.context?.open_chat_id || '') || state.homeChatId || ''
        if (!chatId) return { toast: { type: 'error', content: '切换失败：找不到这个对话。' } }
        try {
          const result = await permissions.setForChat(chatId, mode)
          trace?.('permission-card-clicked', { mode, applied: result.applied })
          return {
            toast: {
              type: 'success',
              content: result.applied
                ? `已切到「${PERMISSION_MODES[mode]?.label || mode}」，当前会话立即生效。`
                : `已切到「${PERMISSION_MODES[mode]?.label || mode}」，下一条消息生效。`,
            },
          }
        } catch (error) {
          return { toast: { type: 'error', content: String((error && error.message) || error) } }
        }
      }

      if (kind === 'resume') {
        const sid = String(value.sid || '')
        const label = String(value.label || sid)
        const state = await readState()
        const chatId = String(data?.context?.open_chat_id || '') || state.homeChatId || ''
        if (!sid || !chatId) {
          return { toast: { type: 'error', content: '切换失败：缺少会话或对话信息。' } }
        }
        await onResume?.(chatId, { sessionId: sid, label, title: label, cwd: '', workspace: '', running: false, updatedAt: 0 })
        const messageId = String(data?.open_message_id || '')
        const switched = resolvedCard({
          title: '✅ 已切换会话',
          template: 'green',
          lines: [`**${label}**`],
        })
        if (messageId && state.appId && state.appSecret) {
          // The card keeps only the bound title: the switch itself is the news.
          await updateCard(state, messageId, switched)
        }
        trace?.('session-switch-clicked', { session: sid.slice(0, 12) })
        return respondWith({ type: 'success', content: `已切换到 ${label}` }, switched)
      }

      const id = String(value.id || '')
      if (!id || !waiting.has(id)) {
        // The request already settled — answered, cancelled, or timed out.
        const why = resolved.get(id)?.reason
        return {
          toast: {
            type: 'warning',
            content: why === 'timeout'
              ? '已超时并转回 DSH 网页处理，这张卡片已失效。'
              : '这条请求已经结束了（可能已在网页回答，或本轮已取消）。',
          },
        }
      }

      if (kind === 'freeform') {
        const questionId = String(value.q || '')
        const state = await readState()
        // The action payload names the message and the operator, never the chat,
        // so the chat comes from where the card was sent.
        const chatId = String(waiting.get(id)?.chatId || state.homeChatId || '')
        const window = waitMsOf(state)
        const expiresAt = Date.now() + (window === undefined ? DEFAULT_WAIT_MINUTES * 60 * 1000 : window)
        let waitingCard
        if (chatId && captures) {
          captures.arm(chatId, { cardId: id, questionId, expiresAt })
          const pending = waiting.get(id)
          if (pending?.messageId && state.appId) {
            // The question card itself becomes the prompt: no extra message.
            waitingCard = resolvedCard({
              title: '⌨️ 等待你输入答案',
              template: 'blue',
              meta: pending.meta,
              lines: (pending.meta?.questions || []).map((question) => {
                // The options stay on screen as text: the operator may want to
                // answer by typing one of them instead of a free sentence.
                const options = (question.options || []).map((option) => clip(option.label, 40))
                return [
                  `**${clip(question.question || question.header || question.id, 200)}**`,
                  options.length > 0 ? `选项：${options.join(' · ')}` : '',
                  '(等待输入)',
                ].filter(Boolean).join('\n\n')
              }),
              footer: `消息路由：已切到“输入答案”，下一条消息会作为这道题的回答（${window === undefined ? '长期有效' : `${Math.max(1, Math.round(window / 60000))} 分钟内有效`}）；`
                + '可以直接回复上面的选项文字，也可以写自己的答案；发完或超时后自动切回。',
            })
            await updateCard(state, pending.messageId, waitingCard)
          }
        }
        return respondWith(
          {
            type: 'info',
            content: window === undefined
              ? '请在下一条消息里输入你的答案（长期有效）。'
              : `请在下一条消息里输入你的答案（${Math.max(1, Math.round(window / 60000))} 分钟内有效）。`,
          },
          waitingCard,
        )
      }

      const entry = waiting.get(id)
      if (!entry) return undefined
      const payload = kind === 'approval'
        ? { outcome: String(value.v) }
        : { questionId: String(value.q || ''), label: String(value.v || ''), ...(value.custom ? { custom: true } : {}) }
      settle(id, payload, 'answered')
      trace?.('answer-clicked', { kind, id: id.slice(0, 8) })

      let answeredCard
      if (kind === 'approval') {
        // The card must stop looking like it is still waiting for a decision.
        const state = await readState()
        if (state.appId && state.appSecret) {
          const allowed = payload.outcome === 'allowed-once'
          answeredCard = resolvedCard({
            title: allowed ? '✅ 已允许' : '❌ 已拒绝',
            template: allowed ? 'green' : 'red',
            meta: entry.meta,
            lines: [
              `**工具**：${clip(entry.meta?.tool || '', 80)}`,
              `**原因**：${clip(entry.meta?.reason || '', 240)}`,
              allowed ? '已允许一次，会话继续执行。' : '已拒绝，本轮不再执行该操作。',
            ],
          })
          await updateCard(state, entry.messageId, answeredCard)
        }
      } else if ((entry.meta?.questions?.length ?? 0) === 1) {
        // Single-question card: rebuild now. A batch is rebuilt once every
        // question has an answer, so the remaining buttons stay usable.
        answeredCard = await markAnswered(entry, [{
          id: payload.questionId,
          selected: payload.custom ? [] : [payload.label],
          ...(payload.custom ? { custom: payload.label } : {}),
        }])
      }

      return respondWith(
        {
          type: 'success',
          content: kind === 'approval'
            ? (payload.outcome === 'allowed-once' ? '已允许本次操作' : '已拒绝')
            : '已记录你的选择',
        },
        answeredCard,
      )
    } catch (error) {
      log(`[feishu-im] card action failed: ${(error && error.message) || error}`)
      return undefined
    }
  }

  async function onApproval(request, next) {
    const state = await readState()
    if (!state.notify?.approval) return next()
    const tool = request.toolName || 'tool'

    /*
     * `auto` mode: the plugin reviews the request instead of pinging the
     * operator, but only for work that stays inside the workspace. A request for
     * `danger-full-access` still becomes a card — auto review is not a blank
     * cheque.
     */
    const mode = permissions?.modeForSession?.(state, request.agent?.id) || state.defaultPermission
    if (shouldAutoApprove(mode, request)) {
      trace?.('approval-auto-approved', { tool: String(tool).slice(0, 40) })
      const chatId = permissions?.chatOfSession?.(state, request.agent?.id)
      if (chatId && state.appId && state.appSecret) {
        try {
          const token = await getTenantToken(state.appId, state.appSecret, state.domain)
          await sendText(token, state.domain, {
            receiveId: chatId,
            receiveIdType: 'chat_id',
            text: `🤖 自动审查已批准：${clip(tool, 40)}\n${clip(request.displayReason?.zh || request.reason || '', 120)}`,
          })
        } catch (error) {
          trace?.('approval-auto-notice-failed', { message: String(error?.message || error) })
        }
      }
      return 'allowed-once'
    }

    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const reason = clip(request.displayReason?.zh || request.displayReason?.en || request.reason || '需要你确认后才能继续')
    const cardJson = card(
      [
        markdown(`**工具**：${clip(tool, 80)}\n**原因**：${reason}`),
        {
          tag: 'action',
          actions: [
            button('允许一次', 'primary', { k: 'approval', id, v: 'allowed-once' }),
            button('拒绝', 'danger', { k: 'approval', id, v: 'rejected' }),
          ],
        },
        note(`会话 ${describe?.(request.agent)?.text || sessionShort(request.agent)} · DSH`),
      ],
      '需要授权',
      'orange',
    )
    const posted = await post(cardJson, `需要授权：${tool}\n${reason}\n\n（卡片未发出，请在 DSH 网页里处理）`)
    const messageId = posted?.messageId
    const waitingPromise = wait(id, {
      messageId,
      chatId: posted?.chatId,
      timeoutMs: waitMsOf(state),
      meta: { kind: 'approval', tool, reason, label: describe?.(request.agent)?.text },
    })
    request.signal?.addEventListener('abort', () => settle(id, undefined, 'aborted'), { once: true })

    if (state.answerMode !== 'both') {
      // Exclusive: answering here is final, and no web prompt is created.
      if (!messageId) return next()
      const answer = await waitingPromise
      if (!answer) {
        // Nobody answered in time: retire the card, then let the DSH page ask.
        await updateCard(
          state,
          messageId,
          resolvedCard({
            title: '⏱ 已超时',
            template: 'grey',
            meta: { kind: 'approval', label: describe?.(request.agent)?.text },
            lines: [`**工具**：${clip(tool, 80)}`, `**原因**：${reason}`],
            footer: '已转回 DSH 网页端继续询问。',
          }),
        )

        trace?.('answer-fallback-web', { kind: 'approval' })
        return next()
      }
      return answer.outcome
    }

    // Race the local answerer: first answer wins. The loser's prompt clears when
    // the turn that owns the request settles.
    const local = Promise.resolve()
      .then(() => next())
      .then((outcome) => ({ kind: 'local', outcome }), () => ({ kind: 'local', outcome: 'unavailable' }))
    const remote = waitingPromise.then((answer) => ({ kind: 'remote', answer }))
    const winner = await Promise.race([local, remote])
    if (winner.kind === 'local') {
      settle(id, undefined)
      return winner.outcome
    }
    if (!winner.answer) return 'unavailable'
    return winner.answer.outcome
  }

  /** `user-questions/request` listener body. */
  async function onQuestions(request, next) {
    const state = await readState()
    if (!state.notify?.question) return next()
    const questions = Array.isArray(request.questions) ? request.questions : []
    if (questions.length === 0) return next()
    // Only single-choice questions can be answered with buttons; anything else
    // stays in the web UI, where the full widget exists.
    const answerable = questions.every(
      (question) => !question.multiSelect && Array.isArray(question.options) && question.options.length > 0,
    )
    if (!answerable) {
      trace?.('question-delegated', { questions: questions.length })
      return next()
    }

    const id = `qs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const answers = new Map()
    const elements = []
    for (const question of questions) {
      elements.push(markdown(`**${clip(question.header || question.question, 120)}**\n${clip(question.question, 400)}`))
      elements.push({
        tag: 'action',
        actions: question.options.map((option) =>
          button(clip(option.label, 40), 'default', { k: 'question', id, q: question.id, v: option.label })),
      })
      // Free-form answers need a chat message, which only makes sense when the
      // card asks exactly one question (one message, one answer).
      if (questions.length === 1) {
        elements.push({
          tag: 'action',
          actions: [button('✏️ 输入你的答案', 'default', { k: 'freeform', id, q: question.id })],
        })
      }
    }
    elements.push(note(`会话 ${describe?.(request.agent)?.text || sessionShort(request.agent)} · DSH`))
    const cardJson = card(elements, '需要你回答', 'blue')
    const posted = await post(cardJson, `需要你回答：\n${questions.map((question) => `· ${clip(question.question, 120)}`).join('\n')}`)
    const messageId = posted?.messageId
    request.signal?.addEventListener('abort', () => settle(id, undefined, 'aborted'), { once: true })

    // One deadline for the whole batch: a three-question card must not hold the
    // turn for three full timeouts.
    const deadline = (() => {
      const window = waitMsOf(state)
      return window === undefined ? undefined : Date.now() + window
    })()

    const collect = async () => {
      let routed = false
      while (answers.size < questions.length) {
        const timeoutMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
        if (timeoutMs === 0) return undefined
        const click = await wait(id, {
          messageId,
          timeoutMs,
          chatId: posted?.chatId,
          card: cardJson,
          meta: { kind: 'question', questions, label: describe?.(request.agent)?.text },
        })
        if (!click) return undefined
        if (click.custom) routed = true
        answers.set(click.questionId, click)
      }
      return {
        // A typed answer is a `custom` value, not a selected option.
        answers: questions.map((question) => {
          const picked = answers.get(question.id)
          return picked?.custom
            ? { id: question.id, selected: [], custom: picked.label }
            : { id: question.id, selected: [picked?.label ?? ''] }
        }),
        routed,
      }
    }

    if (state.answerMode !== 'both') {
      if (!messageId) return next()
      const answer = await collect()
      if (!answer) {
        const dropped = captures?.dropByCard(id)
        await updateCard(
          state,
          messageId,
          resolvedCard({
            title: '⏱ 已超时',
            template: 'grey',
            meta: { kind: 'question', questions, label: describe?.(request.agent)?.text },
            lines: questions.map(
              (question) => `**${clip(question.question || question.header || question.id, 200)}**：(未作答)`,
            ),
            footer: dropped
              ? '消息路由：已切回原来的会话，接下来的消息会照常发给 DSH；这道题已转回 DSH 网页端继续询问。'
              : '已转回 DSH 网页端继续询问。',
          }),
        )
        trace?.('answer-fallback-web', { kind: 'question', routed: Boolean(dropped) })
        return next()
      }
      await markAnswered(
        { messageId, meta: { kind: 'question', questions, label: describe?.(request.agent)?.text } },
        answer.answers,
        { routed: answer.routed },
      )
      return { answers: answer.answers }
    }

    const local = Promise.resolve()
      .then(() => next())
      .then((outcome) => ({ kind: 'local', outcome }), () => ({ kind: 'local', outcome: { answers: [] } }))
    const remote = collect().then((answer) => ({ kind: 'remote', answer }))
    const winner = await Promise.race([local, remote])
    if (winner.kind === 'local') {
      settle(id, undefined)
      return winner.outcome
    }
    return winner.answer ? { answers: winner.answer.answers } : { answers: [] }
  }

  /** Register both listeners ahead of the browser forwarder. */
  function install() {
    if (mode === 'parallel') return
    uninstall()
    mode = 'parallel'
    disposers = [
      ctx.on('approval/request', (request, next) => onApproval(request, next), { prepend: true }),
      ctx.on('user-questions/request', (request, next) => onQuestions(request, next), { prepend: true }),
    ]
    trace?.('answerers-installed', { mode: 'parallel' })
  }

  function uninstall() {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already gone */ }
    }
    disposers = []
    mode = null
    abandonAll()
  }

  return { install, uninstall, handleCardAction, submitText }
}
