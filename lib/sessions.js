/**
 * Session discovery and switching for one Feishu chat.
 *
 * A chat has exactly one bound DSH session (`state.chatSessions[chatId]`). This
 * module lists what can be bound, resolves a human reference (index, id prefix,
 * title, directory) to one session, and performs the switch. The same operations
 * serve the chat commands, the picker card, and the agent tool.
 */

function basename(path) {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function relativeTime(at, now = Date.now()) {
  const minutes = Math.round((now - Number(at || 0)) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export function createSessions({ ctx, readState, writeState, trace }) {
  /** chatId → the rows the operator last saw (so "3" means what it showed). */
  const lastListing = new Map()
  const LISTING_TTL_MS = 15 * 60 * 1000

  const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

  function workspaceOf(cwd) {
    if (!cwd) return ''
    try {
      const list = get('workspaceRegistry')?.list?.() || []
      let best = null
      for (const workspace of list) {
        const path = String(workspace?.path || '')
        if (!path) continue
        if (cwd === path || cwd.startsWith(path.endsWith('/') ? path : `${path}/`)) {
          if (best === null || path.length > String(best.path).length) best = workspace
        }
      }
      if (best) return String(best.title || '')
    } catch {
      // naming only
    }
    return ''
  }

  /**
   * List the sessions a chat could switch to.
   * @param input.query - case-insensitive substring over title/dir/id.
   * @param input.limit - page size (default 10).
   */
  async function list({ query = '', limit = 10 } = {}) {
    const controller = get('sessionController')
    if (!controller?.list) throw new Error('会话列表不可用（sessionController 未激活）')
    const items = await controller.list({}, AbortSignal.timeout(15_000))
    const needle = String(query || '').trim().toLowerCase()
    const rows = []
    for (const item of items) {
      if (item.parentSessionId || item.origin === 'subagent') continue
      if (item.hidden === true) continue
      const title = String(item.projections?.values?.title || '')
      const cwd = String(item.cwd || '')
      const workspace = workspaceOf(cwd)
      const label = title || basename(cwd) || String(item.sessionId).slice(0, 12)
      const haystack = `${label} ${workspace} ${cwd} ${item.sessionId}`.toLowerCase()
      if (needle && !haystack.includes(needle)) continue
      rows.push({
        sessionId: String(item.sessionId),
        title,
        label,
        workspace,
        cwd,
        running: item.running === true,
        updatedAt: Number(item.updatedAt || 0),
      })
      if (rows.length >= limit) break
    }
    return rows
  }

  /** Render rows for a chat message; indexes are 1-based and stable per listing. */
  function format(rows, currentId) {
    if (rows.length === 0) return '没有匹配的会话。'
    return rows
      .map((row, index) => {
        const meta = [
          row.workspace || '',
          row.running ? '运行中' : '',
          relativeTime(row.updatedAt),
        ].filter(Boolean).join(' · ')
        const mark = String(row.sessionId) === String(currentId) ? ' ←当前' : ''
        return `${index + 1}. **${row.label}**${mark}\n　${meta}`
      })
      .join('\n')
  }

  /** Remember what a chat just listed, so a later "3" means that row. */
  function remember(chatId, rows) {
    lastListing.set(String(chatId), { rows, at: Date.now() })
  }

  function recent(chatId) {
    const entry = lastListing.get(String(chatId))
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > LISTING_TTL_MS) {
      lastListing.delete(String(chatId))
      return undefined
    }
    return entry.rows
  }

  /**
   * Resolve a reference to one session.
   *
   * Accepts: a 1-based index from the last listing (or a fresh listing), a full
   * id, an id prefix, or a case-insensitive fragment of the title/directory.
   */
  async function resolve(chatId, ref) {
    const text = String(ref || '').trim()
    if (!text) throw new Error('需要一个会话编号、id 或标题')
    const remembered = recent(chatId)

    if (/^\d+$/.test(text)) {
      const index = Number(text)
      const rows = remembered || (await list({ limit: 20 }))
      const row = rows[index - 1]
      if (!row) throw new Error(`没有第 ${text} 个会话；先发 /sessions 看看列表`)
      return row
    }

    const rows = remembered || (await list({ limit: 50 }))
    const byId = rows.find((row) => row.sessionId === text)
    if (byId) return byId
    const byPrefix = rows.find((row) => row.sessionId.startsWith(text))
    if (byPrefix) return byPrefix
    const needle = text.toLowerCase()
    const byText = rows.find((row) => `${row.label} ${row.title} ${row.workspace} ${row.cwd}`.toLowerCase().includes(needle))
    if (byText) return byText
    throw new Error(`没找到匹配「${text}」的会话；可以用 /sessions 关键字 过滤`)
  }

  /** Bind one chat to one session, returning the row that was bound. */
  async function switchTo(chatId, row) {
    const state = await readState()
    const next = { ...state, chatSessions: { ...(state.chatSessions || {}), [String(chatId)]: row.sessionId } }
    await writeState(next)
    trace?.('session-switched', { chat: String(chatId).slice(0, 10), session: row.sessionId.slice(0, 12) })
    return { row, state: next }
  }

  /** The chat bound to one session, if any (used by the agent tool). */
  async function chatOfSession(sessionId) {
    const state = await readState()
    for (const [chatId, bound] of Object.entries(state.chatSessions || {})) {
      if (String(bound) === String(sessionId)) return { chatId, state }
    }
    return undefined
  }

  /** Current binding for a chat. */
  async function current(chatId) {
    const state = await readState()
    return state.chatSessions?.[String(chatId)]
  }

  return { list, format, remember, resolve, switchTo, chatOfSession, current, relativeTime }
}
