/**
 * Human names for a session: its workspace title and its session title.
 *
 * A raw log id ("workspace · 8b687faf") is useless in a notification: it names
 * neither where the work happens nor what the conversation is about. Both names
 * already exist in the Host — `workspaceRegistry` owns the display title of a
 * directory, `sessionTitle` folds the latest title from the session log — so this
 * module only joins them and degrades to a directory basename when either is
 * absent.
 */

function basename(path) {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

export function createLabels(ctx) {
  const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

  /** Longest owning workspace path for a cwd. */
  function workspaceOf(cwd) {
    if (!cwd) return ''
    try {
      const list = get('workspaceRegistry')?.list?.() || []
      let best = null
      for (const workspace of list) {
        const path = String(workspace?.path || '')
        if (!path) continue
        const inside = cwd === path || cwd.startsWith(path.endsWith('/') ? path : `${path}/`)
        if (!inside) continue
        if (best === null || path.length > String(best.path).length) best = workspace
      }
      if (best) return String(best.title || '')
    } catch {
      // A missing registry is a naming problem, never a delivery problem.
    }
    return ''
  }

  function titleOf(session) {
    try {
      const snapshot = get('sessionTitle')?.get?.(session)
      return String(snapshot?.title || '')
    } catch {
      return ''
    }
  }

  /**
   * Describe one session.
   * @param session - a live Session (or an Agent carrying one).
   * @returns `{ workspace, session, text, shortId }`; `text` is the one-line form
   *          used in notices and cards.
   */
  return function describe(session) {
    const live = session?.session ?? session
    const cwd = String(live?.header?.cwd || '')
    const workspace = workspaceOf(cwd) || basename(cwd)
    const shortId = String(live?.id || '').replace(/^session-/, '').slice(0, 8)
    const title = titleOf(live)
    // Without a title the id is the only identity left. Never repeat the
    // workspace name as the session name: that reads as "workspace › workspace".
    const sessionName = title || `未命名会话 · ${shortId}`
    const text = workspace ? `${workspace} › ${sessionName}` : sessionName
    return { workspace, session: sessionName, text, shortId }
  }
}
