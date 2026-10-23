/**
 * Feishu Open Platform access for the parts this plugin needs.
 *
 * Plain `fetch` only: the plugin must be able to probe credentials, mint a
 * tenant token and send a message even when the WebSocket SDK failed to install,
 * and every one of those calls is a documented HTTPS endpoint. The SDK is
 * loaded lazily by the gateway half and is required only for the inbound
 * long-connection.
 */

const ACCOUNTS = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
}

const OPEN = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

const REGISTRATION_PATH = '/oauth/v1/app/registration'
const REQUEST_TIMEOUT_MS = 15_000

/** Normalize a user-supplied domain name. */
export function normalizeDomain(domain) {
  return domain === 'lark' ? 'lark' : 'feishu'
}

/** Open Platform base URL for the given domain. */
export function openBase(domain) {
  return OPEN[normalizeDomain(domain)]
}

/** Accounts base URL for the given domain. */
export function accountsBase(domain) {
  return ACCOUNTS[normalizeDomain(domain)]
}

/** Human-readable Feishu failure, keeping the platform code and message. */
export class FeishuError extends Error {
  constructor(message, { code, status, hint } = {}) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
    this.status = status
    this.hint = hint
  }
}

function timeoutSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
}

async function readJson(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new FeishuError(`飞书返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`, {
      status: response.status,
    })
  }
}

async function postForm(base, fields) {
  const response = await fetch(`${base}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: timeoutSignal(),
  })
  const data = await readJson(response)
  return { status: response.status, data }
}

/**
 * Start the scan-to-create flow and report whether the environment supports
 * `client_secret` authentication at all.
 */
export async function registrationInit(domain) {
  const { status, data } = await postForm(accountsBase(domain), { action: 'init' })
  const methods = Array.isArray(data.supported_auth_methods) ? data.supported_auth_methods : []
  if (!methods.includes('client_secret')) {
    throw new FeishuError(
      `当前飞书环境不支持 client_secret 授权（支持的：${methods.join(', ') || '无'}），请改用手动填写 App ID / App Secret。`,
      { status },
    )
  }
  return { supportedAuthMethods: methods }
}

/**
 * Begin a device-code registration. The returned `qrUrl` is what the QR image
 * encodes, and the `PersonalAgent` archetype is what makes Feishu provision the
 * bot with its message permissions already attached.
 */
export async function registrationBegin(domain) {
  const { status, data } = await postForm(accountsBase(domain), {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  })
  const deviceCode = data.device_code
  if (!deviceCode) {
    throw new FeishuError(`飞书没有返回 device_code：${data.error || data.msg || `HTTP ${status}`}`, { status })
  }
  return {
    deviceCode,
    qrUrl: String(data.verification_uri_complete || ''),
    userCode: String(data.user_code || ''),
    interval: Number(data.interval) > 0 ? Number(data.interval) : 5,
    expireIn: Number(data.expire_in) > 0 ? Number(data.expire_in) : 600,
  }
}

/**
 * Poll one device code.
 *
 * @returns `{ status: 'pending' }`, `{ status: 'ready', appId, appSecret, domain, openId }`,
 *          or `{ status: 'denied' | 'expired' }`.
 */
export async function registrationPoll(domain, deviceCode) {
  let current = normalizeDomain(domain)
  let { data } = await postForm(accountsBase(current), {
    action: 'poll',
    device_code: deviceCode,
    tp: 'ob_app',
  })

  // Lark tenants are served by a different accounts host; a tenant-brand answer
  // tells us so and the same response may already carry the credentials.
  if (data?.user_info?.tenant_brand === 'lark' && current !== 'lark') {
    current = 'lark'
  }

  if (data.client_id && data.client_secret) {
    return {
      status: 'ready',
      appId: String(data.client_id),
      appSecret: String(data.client_secret),
      domain: current,
      openId: String(data?.user_info?.open_id || ''),
    }
  }

  const error = String(data.error || '')
  if (error === 'access_denied') return { status: 'denied' }
  if (error === 'expired_token') return { status: 'expired' }
  return { status: 'pending' }
}

const tokenCache = new Map()

/** Mint (or reuse) a tenant access token for one app. */
export async function getTenantToken(appId, appSecret, domain) {
  const key = `${normalizeDomain(domain)}:${appId}`
  const cached = tokenCache.get(key)
  if (cached && cached.expireAt > Date.now() + 60_000) return cached.token

  const response = await fetch(`${openBase(domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: timeoutSignal(),
  })
  const data = await readJson(response)
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new FeishuError(
      `App ID / App Secret 校验失败：${data.msg || `code=${data.code}`}`,
      { code: data.code, status: response.status },
    )
  }
  const token = String(data.tenant_access_token)
  tokenCache.set(key, { token, expireAt: Date.now() + Math.max(60, Number(data.expire) || 7200) * 1000 })
  return token
}

/** Forget a cached token (disconnect / credential change). */
export function forgetTenantToken(appId, domain) {
  tokenCache.delete(`${normalizeDomain(domain)}:${appId}`)
}

/** Read the bot identity behind the credentials (`/open-apis/bot/v3/info`). */
export async function getBotInfo(token, domain) {
  const response = await fetch(`${openBase(domain)}/open-apis/bot/v3/info`, {
    headers: { authorization: `Bearer ${token}` },
    signal: timeoutSignal(),
  })
  const data = await readJson(response)
  if (data.code !== 0) {
    throw new FeishuError(`读取机器人信息失败：${data.msg || `code=${data.code}`}`, { code: data.code })
  }
  const bot = data.bot || data?.data?.bot || {}
  return { name: String(bot.app_name || bot.bot_name || ''), openId: String(bot.open_id || '') }
}

/** Send one message through `im/v1/messages`. */
export async function sendMessage(token, domain, { receiveId, receiveIdType = 'open_id', msgType, content }) {
  const response = await fetch(
    `${openBase(domain)}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: msgType,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      }),
      signal: timeoutSignal(),
    },
  )
  const data = await readJson(response)
  if (data.code !== 0) {
    throw new FeishuError(`发送飞书消息失败：${data.msg || `code=${data.code}`}`, { code: data.code })
  }
  return { messageId: String(data?.data?.message_id || '') }
}

/**
 * Attach an emoji reaction to one message.
 *
 * Feishu has no "bot is typing" state, so a reaction is the only visible
 * progress mark the operator gets. Requires the message-reaction write scope;
 * a refusal is reported, never thrown, because losing the indicator must not
 * lose the work.
 *
 * @returns the reaction id, or `undefined` when the app may not react.
 */
export async function addReaction(token, domain, messageId, emojiType) {
  try {
    const response = await fetch(
      `${openBase(domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
        signal: timeoutSignal(),
      },
    )
    const data = await readJson(response)
    if (data.code !== 0) {
      return { error: `reaction ${emojiType}: ${data.msg || `code=${data.code}`}` }
    }
    return { reactionId: String(data?.data?.reaction_id || '') }
  } catch (error) {
    return { error: `reaction ${emojiType}: ${(error && error.message) || error}` }
  }
}

/** Remove one reaction previously added by this app. */
export async function removeReaction(token, domain, messageId, reactionId) {
  try {
    const response = await fetch(
      `${openBase(domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: timeoutSignal(),
      },
    )
    const data = await readJson(response)
    return data.code === 0 ? { ok: true } : { error: `reaction delete: ${data.msg || `code=${data.code}`}` }
  } catch (error) {
    return { error: `reaction delete: ${(error && error.message) || error}` }
  }
}

/**
 * Replace the content of one interactive card this app sent.
 *
 * Used to invalidate a pending approval/question card: the buttons disappear and
 * the card states what happened, so a later tap cannot look like a lost answer.
 */
export async function updateCard(state, messageId, card) {
  const token = await getTenantToken(state.appId, state.appSecret, state.domain)
  try {
    const response = await fetch(
      `${openBase(state.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: JSON.stringify(card) }),
        signal: timeoutSignal(),
      },
    )
    const data = await readJson(response)
    return data.code === 0 ? { ok: true } : { error: `card update: ${data.msg || `code=${data.code}`}` }
  } catch (error) {
    return { error: `card update: ${(error && error.message) || error}` }
  }
}

/** Send one interactive card (`msg_type: interactive`). */
export async function sendCard(state, target, card) {
  const token = await getTenantToken(state.appId, state.appSecret, state.domain)
  return sendMessage(token, state.domain, {
    receiveId: target.receiveId,
    receiveIdType: target.receiveIdType,
    msgType: 'interactive',
    content: card,
  })
}

/** Send a plain-text message. */
export function sendText(token, domain, { receiveId, receiveIdType = 'open_id', text }) {
  return sendMessage(token, domain, {
    receiveId,
    receiveIdType,
    msgType: 'text',
    content: { text },
  })
}
