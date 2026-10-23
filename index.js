/**
 * Host half of the Feishu IM plugin.
 *
 * Responsibilities in this phase:
 *   * own the durable connection state (a `0600` document, see lib/state.js);
 *   * drive the scan-to-create device-code flow, including the QR image;
 *   * verify and store manually entered credentials;
 *   * expose the settings page's HTTP surface as authenticated exact Fetch
 *     routes below `/api` (owner-peers only, no public listener);
 *   * send the one "connected" test message that proves the outbound path.
 *
 * Everything that reacts to harness work (notifications, approvals, inbound
 * commands) plugs into the same state object in the following phases.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  forgetTenantToken,
  sendCard,
  getBotInfo,
  getTenantToken,
  normalizeDomain,
  registrationBegin,
  registrationInit,
  registrationPoll,
  sendText,
} from './lib/feishu.js'
import { createAnswerers } from './lib/answers.js'
import { createGateway } from './lib/gateway.js'
import { createCaptureStore } from './lib/captures.js'
import { createInbound } from './lib/inbound.js'
import { createLabels } from './lib/labels.js'
import { createNotifier } from './lib/notify.js'
import { qrSvgDataUrl } from './lib/qr.js'
import { clearState, publicState, readState, writeState } from './lib/state.js'

/** Route prefix on the shared API channel. `connection.fetch.register` validates
 *  the absolute path against the channel, so this must keep the `/api` prefix. */
const API = '/api/feishu-im'

/** A device-code registration stops being pollable after this long. */
const PENDING_TTL_MS = 15 * 60 * 1000

const PLUGIN_NAME = 'dsh-plugin-feishu-im'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function readJsonBody(request) {
  const text = await request.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法的 JSON')
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asStringList(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)
  const seen = new Set()
  const result = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * Opt-in activation trace (`DSH_FEISHU_IM_TRACE=1`).
 *
 * The Host process writes no log this plugin can read, so diagnosing a silent
 * failure — a route that was never registered, a long connection that never came
 * up — otherwise needs a debugger. Off by default; the file is
 * `$DSH_HOME/feishu-im/host-probe.log`.
 */
const TRACE_ENABLED = process.env.DSH_FEISHU_IM_TRACE === '1'

/** Sentinel that turns the trace on at runtime without restarting the Host. */
function traceFlagPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'feishu-im', 'trace.on')
}

function probe(stage, detail) {
  if (!TRACE_ENABLED && !existsSync(traceFlagPath())) return
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    mkdirSync(join(home, 'feishu-im'), { recursive: true })
    appendFileSync(
      join(home, 'feishu-im', 'host-probe.log'),
      `${new Date().toISOString()} ${stage} ${JSON.stringify(detail ?? {})}\n`,
    )
  } catch {
    // Diagnostics must never affect activation.
  }
}

export function apply(ctx) {
  probe('apply-start', { node: process.version })

  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }

  /** id → pending device-code registration. */
  const pending = new Map()

  const prunePending = () => {
    const now = Date.now()
    for (const [id, entry] of pending) {
      if (now > entry.expiresAt) pending.delete(id)
    }
  }

  const requireConfigured = async () => {
    const state = await readState()
    if (!state.appId || !state.appSecret) throw new Error('还没有连接飞书应用，请先在设置页完成连接。')
    return state
  }

  const botIdentity = async (appId, appSecret, domain) => {
    const token = await getTenantToken(appId, appSecret, domain)
    const bot = await getBotInfo(token, domain)
    return { bot, token }
  }

  const handlers = {
    /** Full connection state for the page (secret-free). */
    async state() {
      prunePending()
      return json({ state: publicState(await readState()) })
    },

    /** Start scan-to-create and answer with the QR payload. */
    async onboardBegin(request) {
      const body = await readJsonBody(request)
      const domain = normalizeDomain(asString(body.domain) || 'feishu')
      await registrationInit(domain)
      const begin = await registrationBegin(domain)

      const id = randomUUID()
      const expiresAt = Date.now() + Math.min(begin.expireIn, PENDING_TTL_MS / 1000) * 1000
      pending.set(id, {
        deviceCode: begin.deviceCode,
        domain,
        interval: Math.max(2, begin.interval),
        expiresAt,
        lastPoll: 0,
      })
      prunePending()

      return json({
        id,
        domain,
        qrUrl: begin.qrUrl,
        qrDataUrl: await qrSvgDataUrl(begin.qrUrl),
        userCode: begin.userCode,
        expiresAt,
      })
    },

    /** Poll one registration; on success the credentials are already stored. */
    async onboardPoll(request) {
      const id = new URL(request.url).searchParams.get('id') || ''
      const entry = pending.get(id)
      if (!entry) return json({ status: 'unknown' })
      if (Date.now() > entry.expiresAt) {
        pending.delete(id)
        return json({ status: 'expired' })
      }
      const now = Date.now()
      if (now - entry.lastPoll < entry.interval * 1000) {
        return json({ status: 'pending', retryAfterMs: entry.interval * 1000 - (now - entry.lastPoll) })
      }
      entry.lastPoll = now

      let result
      try {
        result = await registrationPoll(entry.domain, entry.deviceCode)
      } catch (error) {
        return json({ status: 'pending', warning: error?.message || String(error) })
      }

      if (result.status === 'pending') return json({ status: 'pending' })
      pending.delete(id)
      if (result.status !== 'ready') return json({ status: result.status })

      let bot = { name: '', openId: '' }
      try {
        bot = (await botIdentity(result.appId, result.appSecret, result.domain)).bot
      } catch {
        // The credentials are valid enough to store; identity is best effort.
      }

      const previous = await readState()
      const saved = await writeState({
        ...previous,
        appId: result.appId,
        appSecret: result.appSecret,
        domain: result.domain,
        botName: bot.name,
        botOpenId: bot.openId,
        ownerOpenId: result.openId || previous.ownerOpenId,
        allowedOpenIds:
          previous.allowedOpenIds.length > 0
            ? previous.allowedOpenIds
            : result.openId
              ? [result.openId]
              : [],
        onboardedAt: Date.now(),
      })
      syncGateway()
      return json({ status: 'ready', state: publicState(saved) })
    },

    /** Stop waiting on a registration (the page closed the dialog). */
    async onboardCancel(request) {
      const body = await readJsonBody(request)
      const id = asString(body.id)
      if (id) pending.delete(id)
      return json({ ok: true })
    },

    /** Verify manually entered credentials, then store them. */
    async credentials(request) {
      const body = await readJsonBody(request)
      const appId = asString(body.appId)
      const appSecret = asString(body.appSecret)
      const domain = normalizeDomain(asString(body.domain) || 'feishu')

      if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error('App ID 应形如 cli_xxxxxxxx，请从飞书开放平台复制。')
      if (appSecret.length < 8) throw new Error('App Secret 看起来不完整。')

      const { bot } = await botIdentity(appId, appSecret, domain)
      const previous = await readState()
      if (previous.appId && previous.appId !== appId) forgetTenantToken(previous.appId, previous.domain)

      const saved = await writeState({
        ...previous,
        appId,
        appSecret,
        domain,
        botName: bot.name || previous.botName,
        botOpenId: bot.openId || previous.botOpenId,
      })
      syncGateway()
      return json({ state: publicState(saved) })
    },

    /** Persist the toggles and the allowlist. */
    async prefs(request) {
      const body = await readJsonBody(request)
      const previous = await readState()
      const next = { ...previous }

      if (body.notify && typeof body.notify === 'object') {
        next.notify = {
          turnEnd: body.notify.turnEnd !== false,
          approval: body.notify.approval !== false,
          question: body.notify.question !== false,
        }
      }
      if (body.allowedOpenIds !== undefined) next.allowedOpenIds = asStringList(body.allowedOpenIds)
      if (body.allowCommands !== undefined) next.allowCommands = body.allowCommands !== false
      if (body.answerMode !== undefined) next.answerMode = body.answerMode === 'both' ? 'both' : 'feishu'
      if (body.answerTimeoutMinutes !== undefined) {
        const minutes = Number(body.answerTimeoutMinutes)
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120) throw new Error('等待上限需要是 0–120 之间的分钟数')
        next.answerTimeoutMinutes = Math.round(minutes)
      }
      if (body.awayMode !== undefined) next.awayMode = body.awayMode === true
      if (body.homeChatId !== undefined) next.homeChatId = asString(body.homeChatId)

      const saved = await writeState(next)
      answers.install(saved)
      return json({ state: publicState(saved) })
    },

    /** Re-verify the stored credentials and refresh the bot identity. */
    async verify() {
      const state = await requireConfigured()
      const { bot } = await botIdentity(state.appId, state.appSecret, state.domain)
      const saved = await writeState({
        ...state,
        botName: bot.name || state.botName,
        botOpenId: bot.openId || state.botOpenId,
        verifiedAt: Date.now(),
      })
      return json({ state: publicState(saved), bot })
    },

    /** Send the one message that proves outbound delivery works. */
    async test() {
      const state = await requireConfigured()
      const target = state.ownerOpenId || state.allowedOpenIds[0] || ''
      if (!target) {
        throw new Error('还没有可用的飞书用户 open_id：请重新扫码授权，或在允许列表里填写你的 open_id。')
      }
      const token = await getTenantToken(state.appId, state.appSecret, state.domain)
      const sent = await sendText(token, state.domain, {
        receiveId: target,
        receiveIdType: 'open_id',
        text: '✅ DSH 飞书 IM 已连接。\n之后任务完成、需要授权、需要你回答时，都会发到这个对话。',
      })
      return json({ ok: true, messageId: sent.messageId })
    },

    /** Drop the connection. */
    async disconnect() {
      const state = await readState()
      if (state.appId) forgetTenantToken(state.appId, state.domain)
      pending.clear()
      const cleared = await clearState()
      syncGateway()
      return json({ state: publicState(cleared) })
    },
  }

  const routes = [
    { path: `${API}/state`, methods: ['GET'], handler: handlers.state },
    { path: `${API}/onboarding/begin`, methods: ['POST'], handler: handlers.onboardBegin },
    { path: `${API}/onboarding/poll`, methods: ['GET'], handler: handlers.onboardPoll },
    { path: `${API}/onboarding/cancel`, methods: ['POST'], handler: handlers.onboardCancel },
    { path: `${API}/credentials`, methods: ['POST'], handler: handlers.credentials },
    { path: `${API}/prefs`, methods: ['POST'], handler: handlers.prefs },
    { path: `${API}/verify`, methods: ['POST'], handler: handlers.verify },
    { path: `${API}/test`, methods: ['POST'], handler: handlers.test },
    { path: `${API}/disconnect`, methods: ['POST'], handler: handlers.disconnect },
  ]

  ctx.effect(() => () => pending.clear(), `${PLUGIN_NAME}: pending registrations`)

  const trace = (stage, detail) => probe(stage, detail)
  /** Workspace + session names for every outward message. */
  const describe = createLabels(ctx)
  const captures = createCaptureStore()
  const answers = createAnswerers({
    captures,
    ctx,
    readState,
    log: warn,
    trace,
    sendCard,
    describe,
    isAllowed: async (openId) => {
      const state = await readState()
      return openId === state.ownerOpenId || state.allowedOpenIds.includes(openId)
    },
  })
  const inbound = createInbound({
    ctx,
    readState,
    writeState,
    log: warn,
    trace,
    captures,
    onTextAnswer: (chatId, text) => answers.submitText(chatId, text),
  })
  const gateway = createGateway({ inbound, cardAction: (data) => answers.handleCardAction(data), log: warn, trace })
  const notifier = createNotifier({
    readState,
    log: warn,
    trace,
    describe,
    takeReply: inbound.takeReply,
    takeTyping: inbound.takeTyping,
  })
  // Registered directly: a fiber-scoped listener is disposed with this plugin on
  // unload, and `ctx.effect` would run it in a forked scope whose event lineage
  // does not necessarily include the sessions being observed.
  ctx.on('session/event', (session, event) => notifier.onSessionEvent(session, event))
  probe('listener-registered', { event: 'session/event' })
  ctx.effect(() => () => {
    answers.uninstall()
    void gateway.stop()
  }, `${PLUGIN_NAME}: long connection`)
  const syncGateway = () => {
    void readState()
      .then((state) => {
        answers.install(state)
        return gateway.ensure(state)
      })
      .catch(() => {})
  }
  // The first connection attempt runs after activation settles, so a failing
  // WebSocket cannot fail the plugin's own load.
  setTimeout(syncGateway, 0)


  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection
    probe('connection-available', {
      connection: typeof connection,
      register: typeof connection?.fetch?.register,
    })
    if (!connection || typeof connection.fetch?.register !== 'function') {
      warn(`[${PLUGIN_NAME}] connection.fetch is unavailable; the Feishu IM settings page cannot reach the host`)
      return
    }

    for (const route of routes) {
      try {
        scope.effect(
          () =>
            connection.fetch.register({
              path: route.path,
              methods: route.methods,
              requestBody: 'buffered',
              fetch: async (request) => {
                try {
                  return await route.handler(request)
                } catch (error) {
                  const message = error?.message || String(error)
                  warn(`[${PLUGIN_NAME}] ${request.method} ${route.path}: ${message}`)
                  return json({ error: message, ...(error?.hint ? { hint: error.hint } : {}) }, 400)
                }
              },
            }),
          `${PLUGIN_NAME}: ${route.path}`,
        )
        probe('route-registered', { path: route.path, methods: route.methods })
      } catch (error) {
        probe('route-failed', { path: route.path, message: String((error && error.message) || error) })
        warn(`[${PLUGIN_NAME}] cannot register ${route.path}: ${(error && error.message) || error}`)
      }
    }
  })
}
