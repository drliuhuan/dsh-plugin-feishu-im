// Live proof for the three card end-states, against the real Feishu API.
//
// For each scenario it posts a real question card, drives the transition, then
// reads the message back and asserts on its stored content:
//
//   A. option click   → title 已作答, 问题：答案, no action buttons
//   B. typed answer   → same shape, answer marked （输入）
//   C. timeout        → title 已超时, no action buttons, footer points at DSH
//
// Run: node scripts/cards-live.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { createAnswerers } = await import('../lib/answers.js')
const { createCaptureStore } = await import('../lib/captures.js')
const feishu = await import('../lib/feishu.js')

// Count outbound traffic: a state transition must be a PATCH of the question
// card, never an extra chat message.
const traffic = { sends: 0, patches: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/im/v1/messages')) {
    if (init?.method === 'PATCH') traffic.patches += 1
    else if (init?.method === 'POST' && target.includes('receive_id_type')) traffic.sends += 1
  }
  return realFetch(url, init)
}

const saved = JSON.parse(readFileSync(join(homedir(), '.dsh/feishu-im/state.json'), 'utf8'))
let timeoutMinutes = 1
const readState = async () => ({
  ...saved,
  answerMode: 'feishu',
  notify: { question: true, approval: true },
  answerTimeoutMinutes: timeoutMinutes,
})

const keepAlive = setInterval(() => {}, 1000)
const listeners = {}
const ctx = { get: () => undefined, on: (name, fn) => { listeners[name] = fn; return () => {} } }

const posted = []
const answers = createAnswerers({
  ctx,
  readState,
  captures: createCaptureStore(),
  sendCard: async (st, target, card) => {
    console.log('[sendCard]', target.receiveId, JSON.stringify(card).slice(0, 60))
    const token = await feishu.getTenantToken(st.appId, st.appSecret, st.domain)
    const sent = await feishu.sendMessage(token, st.domain, {
      receiveId: target.receiveId,
      receiveIdType: target.receiveIdType,
      msgType: 'interactive',
      content: card,
    })
    posted.push({ messageId: sent.messageId, card })
    return sent
  },
  log: (message) => console.log('[log]', message),
  trace: (stage, detail) => { if (!String(stage).startsWith('event')) console.log('[trace]', stage, JSON.stringify(detail || {})) },
  isAllowed: async () => true,
  describe: () => ({ text: '卡片终态自测 › 会话' }),
  readState,
})

answers.install()

const token = await feishu.getTenantToken(saved.appId, saved.appSecret, saved.domain)

async function readCard(messageId) {
  const response = await fetch(
    `${feishu.openBase(saved.domain)}/open-apis/im/v1/messages/${messageId}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  const body = await response.json()
  const content = body?.data?.items?.[0]?.body?.content || ''
  let card = {}
  try { card = content ? JSON.parse(content) : {} } catch { card = {} }
  // Feishu stores an interactive message as {type:'card', data:{...card json}}.
  if (card.data && typeof card.data === 'object') card = card.data
  return { card, raw: content }
}

// Feishu normalises a stored card: a 1.0 card reads back as
// `{title: "...", elements: [[{tag:'text', ...}]]}`, not as the JSON we sent.
// These helpers therefore walk whatever shape came back.
function allStrings(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const item of node) allStrings(item, out)
  else if (node && typeof node === 'object') for (const value of Object.values(node)) allStrings(value, out)
  return out
}

function cardTitle(card) {
  if (typeof card?.title === 'string') return card.title
  return card?.header?.title?.content || ''
}

function cardText(card) {
  return allStrings(card).join(' ')
}

function hasActions(raw) {
  return /"tag"\s*:\s*"(action|button)"/.test(raw)
}

function question(questionId, text) {
  return {
    questions: [{
      id: questionId,
      header: '自测',
      question: text,
      options: [{ label: 'A 选项' }, { label: 'B 选项' }],
    }],
  }
}

function firstButton(card, kind) {
  return (card?.elements || [])
    .flatMap((element) => element.actions || [])
    .find((action) => action.value?.k === kind)
}

const noopNext = async () => ({ answers: [] })
let failures = 0

function check(label, condition, extra) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

// --- A: option click ---
{
  posted.length = 0
  traffic.sends = 0
  traffic.patches = 0
  const run = listeners['user-questions/request'](question('a1', '先做性能还是功能？'), noopNext)
  await new Promise((r) => setTimeout(r, 1500))
  console.log('[debug] posted after wait:', posted.length)
  const card = posted[0].card
  const option = firstButton(card, 'question')
  const clickResponse = await answers.handleCardAction({ action: { value: option.value }, operator: { open_id: saved.ownerOpenId } })
  // Feishu re-renders on the callback response; a PATCH alone can be overwritten.
  check('A callback returns the updated card', clickResponse?.card?.type === 'raw', JSON.stringify(clickResponse?.card?.type))
  await run
  const after = await readCard(posted[0].messageId)
  check('A title is 已作答', cardTitle(after.card).includes('已作答'), cardTitle(after.card))
  check('A no buttons left', !hasActions(after.raw))
  check('A only one message (the card)', traffic.sends === 1, `sends=${traffic.sends} patches=${traffic.patches}`)
  check('A shows 问题：答案', cardText(after.card).includes('先做性能还是功能？') && cardText(after.card).includes('A 选项'),
    cardText(after.card).replace(/\n/g, ' / ').slice(0, 80))
}

// --- B: typed answer ---
{
  posted.length = 0
  traffic.sends = 0
  traffic.patches = 0
  const run = listeners['user-questions/request'](question('b1', '下一阶段目标是什么？'), noopNext)
  await new Promise((r) => setTimeout(r, 1500))
  const card = posted.find((entry) => JSON.stringify(entry.card).includes('"freeform"')).card
  const free = firstButton(card, 'freeform')
  await answers.handleCardAction({ action: { value: free.value }, operator: { open_id: saved.ownerOpenId } })
  await answers.submitText(saved.homeChatId, '先把飞书链路打磨稳定')
  await run
  const after = await readCard(posted.find((entry) => JSON.stringify(entry.card).includes('"freeform"')).messageId)
  check('B title is 已作答', cardTitle(after.card).includes('已作答'), cardTitle(after.card))
  check('B no buttons left', !hasActions(after.raw))
  check('B only one message (the card)', traffic.sends === 1, `sends=${traffic.sends} patches=${traffic.patches}`)
  check('B states routing is back', /已切回原来的会话/.test(cardText(after.card)), '')
  check('B typed answer is shown', cardText(after.card).includes('先把飞书链路打磨稳定'), cardText(after.card).replace(/\n/g, ' / ').slice(0, 80))
}

// --- C: timeout ---
{
  timeoutMinutes = 1
  posted.length = 0
  traffic.sends = 0
  traffic.patches = 0
  console.log('…… C: arm free-form, then wait out the 1-minute timeout')
  const run = listeners['user-questions/request'](question('c1', '这条会超时。'), noopNext)
  await new Promise((r) => setTimeout(r, 1500))
  const armedCard = posted.find((entry) => JSON.stringify(entry.card).includes('"freeform"')).card
  const free = firstButton(armedCard, 'freeform')
  await answers.handleCardAction({ action: { value: free.value }, operator: { open_id: saved.ownerOpenId } })
  const waitingCard = await readCard(posted.find((entry) => JSON.stringify(entry.card).includes('"freeform"')).messageId)
  check('C waiting card keeps the options', /A 选项/.test(cardText(waitingCard.card)) && /B 选项/.test(cardText(waitingCard.card)),
    cardText(waitingCard.card).replace(/\n/g, ' / ').slice(-90))
  check('C waiting card states routing', /消息路由：已切到/.test(cardText(waitingCard.card)), cardText(waitingCard.card).slice(-60))
  await run
  const after = await readCard(posted[0].messageId)
  check('C title is 已超时', cardTitle(after.card).includes('已超时'), cardTitle(after.card))
  check('C no buttons left', !hasActions(after.raw))
  check('C only one message (the card)', traffic.sends === 1, `sends=${traffic.sends} patches=${traffic.patches}`)
  check('C states routing is back', /已切回原来的会话/.test(cardText(after.card)), '')
  check('C keeps the question', cardText(after.card).includes('这条会超时'), cardText(after.card).replace(/\n/g, ' / ').slice(0, 80))
}

clearInterval(keepAlive)
console.log(failures === 0 ? 'cards live: all scenarios passed' : `cards live: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
