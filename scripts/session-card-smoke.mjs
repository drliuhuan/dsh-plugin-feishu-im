// The session picker card: ten buttons, each labelled with the title and the
// last-interaction time, and a body that only explains keyword search.
import assert from 'node:assert/strict'

const { createInbound } = await import('../lib/inbound.js')

const state = {
  version: 1, appId: 'cli_x', appSecret: 's', domain: 'feishu',
  homeChatId: 'oc_1', chatSessions: { oc_1: 'session-1' },
  allowedOpenIds: ['ou_1'], ownerOpenId: 'ou_1', answerTimeoutMinutes: 5,
  notify: { turnEnd: true, approval: true, question: true },
  defaultPermission: 'workspace', chatPermissions: {},
  allowCommands: true,
}
const now = Date.now()
const rows = Array.from({ length: 12 }, (_, index) => ({
  sessionId: `session-${index}`,
  label: `会话标题${index + 1}`,
  workspace: 'workspace',
  updatedAt: now - (index + 1) * 60_000,
  running: false,
}))

const cards = []
const inbound = createInbound({
  ctx: { get: () => undefined, on: () => () => {} },
  readState: async () => state,
  writeState: async (next) => { Object.assign(state, next); return state },
  log: () => {},
  trace: () => {},
  captures: undefined,
  onTextAnswer: async () => {},
  sessions: {
    list: async () => rows,
    remember: () => {},
    current: async () => 'session-2',
    relativeTime: (at) => `${Math.round((now - at) / 60000)} 分钟前`,
    chatOfSession: async () => ({ chatId: 'oc_1' }),
    resolve: async () => rows[0],
    switchTo: async () => {},
  },
  restart: { request: async () => ({ ok: true }) },
  permissions: { modeOf: () => 'workspace', setForChat: async () => ({ applied: true }) },
  postCard: async (chatId, card) => { cards.push(card); return { messageId: 'om_1' } },
  updateCardMessage: async () => {},
})

await inbound.handle({
  message: {
    message_id: 'om_in_1', chat_id: 'oc_1', chat_type: 'p2p',
    message_type: 'text', content: JSON.stringify({ text: '/sessions' }),
  },
  sender: { sender_id: { open_id: 'ou_1' } },
})

const card = cards.at(-1)
assert.ok(card, 'a card was posted')
const markdown = card.elements.find((el) => el.tag === 'markdown')
assert.match(markdown.content, /\/sessions <关键字>/, 'body explains keyword search')
assert.doesNotMatch(markdown.content, /会话标题1/, 'body no longer repeats the titles')

const buttons = card.elements.filter((el) => el.tag === 'action').flatMap((el) => el.actions)
assert.equal(buttons.length, 10, 'ten buttons, one per session')
assert.match(buttons[0].text.content, /^会话标题1 · 1 分钟前$/, 'button carries title + relative time')
assert.match(buttons[2].text.content, /^✓ /, 'the current session is marked')
assert.equal(buttons[0].value.k, 'resume', 'buttons keep the resume action')
assert.equal(buttons[0].value.label, '会话标题1', 'full title travels in the value')

console.log('session card smoke: all cases passed')
