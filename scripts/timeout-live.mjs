// Drive the timeout path against the real Feishu API, without DSH.
//
// It posts a real question card to the configured chat, waits for the configured
// answer timeout, and then prints exactly what the timeout branch did. Used to
// prove that the card PATCH and the fallback message really fire.
//
// Run: node scripts/timeout-live.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { createAnswerers } = await import('../lib/answers.js')
const { createCaptureStore } = await import('../lib/captures.js')
const feishu = await import('../lib/feishu.js')

const state = JSON.parse(readFileSync(join(homedir(), '.dsh/feishu-im/state.json'), 'utf8'))
const readState = async () => ({
  ...state,
  answerMode: 'feishu',
  notify: { question: true, approval: true },
  answerTimeoutMinutes: 1,
})

const listeners = {}
const ctx = { get: () => undefined, on: (name, fn) => { listeners[name] = fn; return () => {} } }

let cardMessageId = ''
let noticeMessageId = ''
const postedCards = []
const answers = createAnswerers({
  ctx,
  readState,
  captures: createCaptureStore(),
  sendCard: async (st, target, card) => {
    const token = await feishu.getTenantToken(st.appId, st.appSecret, st.domain)
    const sent = await feishu.sendMessage(token, st.domain, {
      receiveId: target.receiveId,
      receiveIdType: target.receiveIdType,
      msgType: 'interactive',
      content: card,
    })
    postedCards.push({ messageId: sent.messageId, card })
    const freeform = JSON.stringify(card).includes('"freeform"')
    if (freeform) cardMessageId = sent.messageId
    else noticeMessageId = sent.messageId
    return sent
  },
  log: (message) => console.log('[log]', message),
  trace: (stage, detail) => console.log('[trace]', stage, JSON.stringify(detail || {})),
  isAllowed: async () => true,
  describe: () => ({ text: '超时自测 › 卡片' }),
})

// The answer timer is unref'd (a Host process always has other handles); this
// script needs one so the wait does not exit the process early.
const keepAlive = setInterval(() => {}, 1000)
answers.install()
console.log('posting a question card; the answer timeout is 1 minute…')
const start = Date.now()
// Simulate the operator tapping 「输入你的答案」 a moment after the card lands.
const clicker = setTimeout(() => {
  const card = postedCards.find((entry) => JSON.stringify(entry.card).includes('"freeform"'))?.card
  const action = (card?.elements || []).flatMap((element) => element.actions || []).find((entry) => entry.value.k === 'freeform')
  if (!action) { console.log('no freeform button found'); return }
  answers.handleCardAction({ action: { value: action.value }, operator: { open_id: state.ownerOpenId } })
    .then((toast) => console.log('freeform click →', JSON.stringify(toast)))
    .catch((error) => console.log('freeform click failed:', error.message))
}, 3000)
const result = await listeners['user-questions/request'](
  { questions: [{ id: 'timeout_q', header: '超时自测', question: '请随便选一个，但别点——用来验证超时更新。', options: [{ label: 'A' }, { label: 'B' }] }] },
  async () => ({ answers: [{ id: 'timeout_q', selected: [] }] }),
)
console.log('fallback answer:', JSON.stringify(result))
console.log('elapsed ms:', Date.now() - start, '| card message:', cardMessageId)

// Read the card back from Feishu: this is the stored content, i.e. exactly what
// the client renders. No screen-watching needed.
const token = await feishu.getTenantToken(state.appId, state.appSecret, state.domain)
const response = await fetch(
  `${feishu.openBase(state.domain)}/open-apis/im/v1/messages/${cardMessageId}`,
  { headers: { authorization: `Bearer ${token}` } },
)
const body = await response.json()
const content = body?.data?.items?.[0]?.body?.content || ''
console.log('readback code:', body.code, '| bytes:', content.length)
console.log('carries timeout line:', content.includes('已超时'))
console.log('carries original question:', content.includes('请随便选一个'))
const parsed = content ? JSON.parse(content) : {}
for (const element of parsed.elements || []) {
  if (element.tag === 'markdown') console.log('  question card line:', element.content.slice(0, 90))
}

clearTimeout(clicker)
if (noticeMessageId) {
  const noticeResponse = await fetch(
    `${feishu.openBase(state.domain)}/open-apis/im/v1/messages/${noticeMessageId}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  const noticeBody = await noticeResponse.json()
  const noticeContent = noticeBody?.data?.items?.[0]?.body?.content || ''
  console.log('notice card readback code:', noticeBody.code, '| bytes:', noticeContent.length)
  console.log('notice says timeout:', noticeContent.includes('已超时'), '| says switched back:', noticeContent.includes('切回'))
  for (const element of (noticeContent ? JSON.parse(noticeContent) : {}).elements || []) {
    if (element.tag === 'markdown') console.log('  notice line:', element.content.replace(/\n/g, ' ').slice(0, 100))
  }
} else {
  console.log('NO notice card was posted — capture was never armed')
}
clearInterval(keepAlive)
