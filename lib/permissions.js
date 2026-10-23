/**
 * Per-chat permission modes, chosen from Feishu.
 *
 * A Feishu chat owns one DSH session at a time, so the chat is the natural place
 * to hold the policy: the four modes below map onto the Host's two knobs — the
 * session sandbox mode (a `sandbox/mode` session event) and the approval policy
 * (`ask` / `never`) — plus the plugin's own auto-review for the `auto` mode.
 */
export const PERMISSION_MODES = {
  readonly: {
    label: '只读',
    sandbox: 'read-only',
    approval: 'ask',
    hint: '只能读，不能改文件；越界操作会来找你确认。',
  },
  workspace: {
    label: '工作区读写',
    sandbox: 'workspace-write',
    approval: 'ask',
    hint: '可在工作区目录内读写，越界操作会来找你确认。',
  },
  auto: {
    label: '自动审查（插件）',
    // Read-only by default: that is what gives the plugin something to review.
    // With `workspace-write` the sandbox already allows workspace edits, so no
    // approval is ever requested and "auto review" would be a no-op.
    sandbox: 'read-only',
    approval: 'ask',
    hint: '以只读运行；需要写工作区时由插件自动批准，要求完全权限的仍会问你。',
  },
  full: {
    label: '完全权限',
    sandbox: 'danger-full-access',
    approval: 'never',
    hint: '不做沙箱限制，也不再向你询问；只在信任当前任务时使用。',
  },
}

export const PERMISSION_KEYS = Object.keys(PERMISSION_MODES)
export const DEFAULT_PERMISSION = 'workspace'

export function isPermissionKey(value) {
  return typeof value === 'string' && Object.hasOwn(PERMISSION_MODES, value)
}

/**
 * Whether the plugin may approve this request without asking.
 *
 * `auto` exists to keep the chat quiet for ordinary workspace work, not to
 * rubber-stamp privilege escalation: anything that asks for
 * `danger-full-access`, or comes from a tool whose reason says so, still reaches
 * the operator as a card.
 */
export function shouldAutoApprove(mode, request) {
  if (mode !== 'auto') return false
  const reason = [
    String(request?.reason || ''),
    String(request?.displayReason?.zh || ''),
    String(request?.displayReason?.en || ''),
    JSON.stringify(request?.displayReason || {}),
  ].join(' ')
  if (/danger-full-access|full[- ]access|提权|完全权限/i.test(reason)) return false
  return true
}

export function createPermissions({ ctx, readState, writeState, trace }) {
  /** The mode that applies to one chat. */
  function modeOf(state, chatId) {
    const stored = state?.chatPermissions?.[chatId]
    if (isPermissionKey(stored)) return stored
    const fallback = state?.defaultPermission
    return isPermissionKey(fallback) ? fallback : DEFAULT_PERMISSION
  }

  /** Reverse map: which chat owns this session (for approval auto-review). */
  function chatOfSession(state, sessionId) {
    if (!sessionId) return undefined
    for (const [chatId, bound] of Object.entries(state?.chatSessions || {})) {
      if (bound === sessionId) return chatId
    }
    return undefined
  }

  function modeForSession(state, sessionId) {
    return modeOf(state, chatOfSession(state, sessionId))
  }

  /** Push the mode onto a live agent: sandbox event plus approval policy. */
  function applyToAgent(agent, mode) {
    const spec = PERMISSION_MODES[mode]
    if (!agent?.session || !spec) return false
    try {
      agent.session.append('sandbox/mode', { mode: spec.sandbox })
    } catch (error) {
      trace?.('permission-sandbox-failed', { mode, message: String(error?.message || error) })
      return false
    }
    try {
      ctx.get?.('approval')?.setPolicy?.(agent, spec.approval)
    } catch (error) {
      trace?.('permission-approval-failed', { mode, message: String(error?.message || error) })
    }
    trace?.('permission-applied', { mode, sandbox: spec.sandbox, approval: spec.approval })
    return true
  }

  /** Apply a mode to a session id (used when a Feishu conversation is created). */
  async function applyToSession(sessionId, mode) {
    const registry = ctx.get?.('agents')
    let agent = sessionId ? registry?.get?.(sessionId) : undefined
    if (!agent && sessionId) {
      // Some registries key by the bare id without the `session-` prefix.
      const bare = String(sessionId).replace(/^session-/, '')
      agent = registry?.get?.(bare)
    }
    if (!agent) {
      trace?.('permission-apply-missed', { session: String(sessionId || '').slice(0, 12), mode })
      return false
    }
    return applyToAgent(agent, mode)
  }

  /**
   * Re-assert the chat's mode on a live session.
   *
   * The sandbox mode is persisted as a session event, but the approval policy is
   * in-memory per agent — it resets on a Host restart. Calling this before every
   * prompt makes "已切到完全权限" true again after a restart instead of quietly
   * falling back to `ask`.
   */
  async function ensureForSession(chatId, sessionId, state) {
    if (!chatId || !sessionId) return false
    const mode = modeOf(state, chatId)
    const registry = ctx.get?.('agents')
    const agent = registry?.get?.(sessionId)
    if (!agent) {
      trace?.('permission-ensure-missed', { session: String(sessionId).slice(0, 12) })
      return false
    }
    const effective = effectiveSandbox(agent)
    const spec = PERMISSION_MODES[mode]
    if (effective === spec.sandbox) {
      // Sandbox already right; still re-assert the approval side cheaply.
      try {
        ctx.get?.('approval')?.setPolicy?.(agent, spec.approval)
      } catch (error) {
        trace?.('permission-approval-failed', { mode, message: String(error?.message || error) })
      }
      return true
    }
    return applyToAgent(agent, mode)
  }

  async function setForChat(chatId, mode) {
    if (!isPermissionKey(mode)) throw new Error(`未知的权限模式：${mode}`)
    const state = await readState()
    const saved = await writeState({ ...state, chatPermissions: { ...(state.chatPermissions || {}), [chatId]: mode } })
    const bound = saved.chatSessions?.[chatId]
    const agent = bound ? ctx.get?.('agents')?.get?.(bound) : undefined
    if (agent) applyToAgent(agent, mode)
    return { mode, applied: Boolean(agent), sessionId: bound }
  }

  async function setDefault(mode) {
    if (!isPermissionKey(mode)) throw new Error(`未知的权限模式：${mode}`)
    const state = await readState()
    await writeState({ ...state, defaultPermission: mode })
    return mode
  }

  /**
   * The mode to *show* as current: what the session is actually running under.
   *
   * The stored value is the last explicit choice, which drifts when the mode is
   * changed elsewhere (the web UI, the /permission command, a Host restart).
   * Reading the session's effective sandbox first keeps the card honest.
   */
  function effectiveMode(state, chatId, sessionId) {
    const stored = modeOf(state, chatId)
    const agent = sessionId ? ctx.get?.('agents')?.get?.(sessionId) : undefined
    const sandbox = effectiveSandbox(agent)
    const spec = PERMISSION_MODES[stored]
    if (!sandbox || !spec) return stored
    if (spec.sandbox === sandbox) return stored
    const derived = Object.keys(PERMISSION_MODES).find((key) => PERMISSION_MODES[key].sandbox === sandbox)
    return derived || stored
  }

  /** Sandbox mode the session currently runs under, if the Host exposes it. */
  function effectiveSandbox(agent) {
    try {
      return ctx.get?.('sandboxPolicy')?.resolve?.({ session: agent?.session })?.mode
    } catch {
      return undefined
    }
  }

  return {
    modeOf,
    effectiveMode,
    modeForSession,
    chatOfSession,
    applyToAgent,
    applyToSession,
    ensureForSession,
    setForChat,
    setDefault,
    effectiveSandbox,
  }
}
