/**
 * Outbound notifications.
 *
 * The Host emits `session/event` after every committed durable event, so this
 * listener must stay cheap: it folds only the three event types a turn summary
 * needs and does everything else on `turn/end`.
 *
 * Rules:
 *   - subagent children are skipped (their parent reports the outcome);
 *   - a turn the plugin started from Feishu is answered by the inbound path,
 *     not by the generic notice, so it is suppressed once;
 *   - cancelled turns are silent; completed / failed / max-tokens announce.
 */
import { addReaction, getTenantToken, removeReaction, sendCard, sendText } from './feishu.js'
import { buildContentCards } from './markdown.js'

const MAX_BODY_CHARS = 1200

function sessionLabel(session) {
  const cwd = session?.header?.cwd || ''
  const base = cwd.split('/').filter(Boolean).pop() || 'session'
  const id = String(session?.id || '').replace(/^session-/, '')
  return `${base} · ${id.slice(0, 8)}`
}

function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function truncate(text, limit = MAX_BODY_CHARS) {
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字）`
}

function reasonLine(reason) {
  if (!reason || typeof reason !== 'object') return ''
  if (reason.kind === 'error') return `结束原因：出错（${reason.error?.message || reason.error?.code || '未知错误'}）`
  if (reason.kind === 'max-tokens') return '结束原因：达到 max-tokens 上限'
  return ''
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
}

/**
 * Compose the text of one turn notice. Pure, so it is unit-testable without a
 * connection.
 * @param input.session - the session that ended a turn.
 * @param input.reason - the durable `turn/end` reason.
 * @param input.text - the last assistant text of the turn.
 * @param input.durationMs - wall clock time from turn start to end.
 * @returns the message body sent to Feishu.
 */
export function turnNotice({ session, reason, text, durationMs, label }) {
  const kind = reason?.kind
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? formatDuration(durationMs) : ''
  const meta = [duration ? `**用时**：${duration}` : '', reasonLine(reason)].filter((line) => line !== '')
  return {
    title: kind === 'completed' ? '✅ DSH 任务完成' : '⚠️ DSH 任务结束',
    template: kind === 'completed' ? 'green' : 'red',
    subtitle: label || sessionLabel(session),
    // The whole answer goes out; the card builder paginates it, never cuts it.
    markdown: `${meta.length > 0 ? `${meta.join('\n')}\n\n---\n\n` : ''}${text || '（这一轮没有文本输出）'}`,
    note: '',
  }
}

/**
 * Compose the answer posted back into the Feishu chat that asked. Unlike the
 * generic notice this carries no "task finished" header: the chat is mid
 * conversation, so the body is the answer plus one metadata line.
 */
export function replyNotice({ text, durationMs, reason, label }) {
  // The session label rides the card subtitle, so the footer only carries facts.
  const meta = []
  if (Number.isFinite(durationMs) && durationMs > 0) meta.push(formatDuration(durationMs))
  if (reason?.kind === 'error') meta.push(`出错：${reason.error?.message || '未知错误'}`)
  if (reason?.kind === 'max-tokens') meta.push('达到 max-tokens 上限')
  return {
    title: '💬 DSH 回复',
    template: reason?.kind === 'error' ? 'red' : 'blue',
    subtitle: label,
    markdown: text || '（这一轮没有文本输出）',
    note: meta.join(' · '),
  }
}

/**
 * Create the notifier bound to this plugin activation.
 * @param options.readState - resolves the current connection state.
 * @param options.log - diagnostic sink.
 */
export function createNotifier({ readState, log, trace, takeReply, takeTyping, describe }) {
  /** sessionId → the last assistant text of the open turn. */
  const lastText = new Map()
  /** sessionId → turn start timestamp (ms). */
  const turnStart = new Map()
  /** sessionId → how many upcoming turn ends to keep quiet. */
  const suppressed = new Map()

  /** Mark the next turn end of a session as answered elsewhere. */
  function suppressNext(sessionId) {
    const key = String(sessionId)
    suppressed.set(key, (suppressed.get(key) || 0) + 1)
  }

  async function deliver(notice, override) {
    const state = await readState()
    if (!state.appId || !state.appSecret) return trace?.('deliver-skip', { reason: 'not-configured' })
    if (!override && !state.notify?.turnEnd) return trace?.('deliver-skip', { reason: 'notify-off' })
    const target = override?.chatId
      ? { id: override.chatId, type: 'chat_id' }
      : state.homeChatId
        ? { id: state.homeChatId, type: 'chat_id' }
        : state.ownerOpenId || state.allowedOpenIds[0]
          ? { id: state.ownerOpenId || state.allowedOpenIds[0], type: 'open_id' }
          : null
    if (!target) return trace?.('deliver-skip', { reason: 'no-target' })

    const cards = buildContentCards({
      title: notice.title,
      template: notice.template,
      subtitle: notice.subtitle,
      markdown: notice.markdown,
      note: notice.note,
    })
    const token = await getTenantToken(state.appId, state.appSecret, state.domain)
    trace?.('deliver-send', { to: target.type, id: target.id.slice(0, 8), parts: cards.length, chars: notice.markdown.length })
    try {
      for (const card of cards) {
        const sent = await sendCard(state, { receiveId: target.id, receiveIdType: target.type }, card)
        trace?.('deliver-ok', { messageId: sent?.messageId || '' })
      }
      return
    } catch (error) {
      // A refused card (app version, missing scope) must not swallow the answer.
      trace?.('deliver-card-failed', { message: String((error && error.message) || error) })
      const text = [notice.title, '', truncate(notice.markdown, 1500), notice.note].filter(Boolean).join('\n')
      const sent = await sendText(token, state.domain, { receiveId: target.id, receiveIdType: target.type, text })
      trace?.('deliver-fallback-ok', { messageId: sent.messageId })
    }
  }

  /**
   * Drop the progress reaction and, when the turn failed, leave a failure mark
   * where the typing badge was.
   */
  async function clearTyping(standing, failed) {
    const state = await readState()
    if (!state.appId || !state.appSecret) return
    const token = await getTenantToken(state.appId, state.appSecret, state.domain)
    const removed = await removeReaction(token, state.domain, standing.messageId, standing.reactionId)
    if (!removed?.ok) {
      trace?.('typing-clear-failed', { error: String(removed?.error || 'unknown') })
      return
    }
    if (failed) await addReaction(token, state.domain, standing.messageId, 'CrossMark')
  }

  /** Feed one committed session event. Never throws into the session loop. */
  function onSessionEvent(session, event) {
    try {
      if (!event || !session) return
      const sessionId = String(session.id)
      if (event.type === 'turn/start' || event.type === 'turn/end') trace?.('event', { type: event.type, session: sessionId.slice(0, 12), reason: event.data?.reason?.kind })
      if (session.header?.origin === 'subagent') return

      if (event.type === 'turn/start') {
        turnStart.set(sessionId, Date.now())
        lastText.delete(sessionId)
        return
      }

      if (event.type === 'assistant/message') {
        const text = assistantText(event.data?.message)
        if (text) lastText.set(sessionId, text)
        return
      }

      if (event.type !== 'turn/end') return

      const pending = suppressed.get(sessionId) || 0
      if (pending > 0) {
        if (pending === 1) suppressed.delete(sessionId)
        else suppressed.set(sessionId, pending - 1)
        return
      }

      const reason = event.data?.reason
      const kind = reason?.kind
      if (kind !== 'completed' && kind !== 'error' && kind !== 'max-tokens') return

      const started = turnStart.get(sessionId)
      const label = describe?.(session)?.text
      const standingReaction = takeTyping?.(sessionId)
      if (standingReaction) {
        void clearTyping(standingReaction, kind === 'error').catch(() => {})
      }
      const pendingReply = takeReply?.(sessionId)
      if (pendingReply) {
        const answer = replyNotice({
          text: lastText.get(sessionId) || '',
          durationMs: started ? Date.now() - started : 0,
          reason,
          label,
        })
        trace?.('reply-send', { chat: String(pendingReply.chatId).slice(0, 10), chars: answer.markdown.length })
        void deliver(answer, { chatId: pendingReply.chatId }).catch((error) => {
          trace?.('reply-failed', { message: String((error && error.message) || error) })
        })
        return
      }

      const notice = turnNotice({
        session,
        reason,
        text: lastText.get(sessionId) || '',
        durationMs: started ? Date.now() - started : 0,
        label,
      })

      void deliver(notice).catch((error) => {
        trace?.('deliver-failed', { message: String((error && error.message) || error) })
        log(`[feishu-im] notification failed: ${(error && error.message) || error}`)
      })
    } catch (error) {
      log(`[feishu-im] notifier error: ${(error && error.message) || error}`)
    }
  }

  return { onSessionEvent, suppressNext }
}
