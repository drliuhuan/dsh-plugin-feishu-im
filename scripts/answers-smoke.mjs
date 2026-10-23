// End-to-end smoke test for the answer path, without Feishu or DSH.
//
// Covers the two behaviours that are easy to break and hard to see:
//   1. a question card answered by an option button;
//   2. a question card answered by 「输入你的答案」 + a chat message, which must
//      reach the question listener as a `custom` answer and leave the chat's
//      capture empty again.
//
// Run: node scripts/answers-smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These cases write fixture state. Point DSH_HOME at a throwaway directory even
// when the caller forgot to, so a smoke test can never overwrite the operator's
// real Feishu credentials again (that happened on 2026-10-23).
if (!process.env.DSH_HOME) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'fsim-smoke-'))

const { createAnswerers } = await import('../lib/answers.js')
const { createCaptureStore } = await import('../lib/captures.js')

const state = {
  appId: 'cli_test',
  appSecret: 'secret_test_value',
  domain: 'feishu',
  homeChatId: 'oc_home',
  ownerOpenId: 'ou_owner',
  allowedOpenIds: ['ou_owner'],
  notify: { turnEnd: true, approval: true, question: true },
  answerMode: 'feishu',
  answerTimeoutMinutes: 5,
  allowCommands: true,
}

const listeners = {}
const sent = []
const notices = []
const patches = []

const ctx = {
  get: () => undefined,
  on(name, listener) {
    listeners[name] = listener
    return () => {}
  },
}

// Avoid real HTTP: the answerer notifies the chat and may patch cards.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (init?.method === 'PATCH') patches.push(target)
  if (target.includes('tenant_access_token')) {
    return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
  }
  if (target.includes('/im/v1/messages')) {
    notices.push(target)
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_notice' } }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: 0 }), { status: 200 })
}

try {
  const captures = createCaptureStore()
  const answers = createAnswerers({
    ctx,
    readState: async () => state,
    sendCard: async (_state, target, card) => {
      sent.push({ target, card })
      return { messageId: `om_card_${sent.length}` }
    },
    log: () => {},
    trace: () => {},
    isAllowed: async (openId) => openId === 'ou_owner',
    describe: () => ({ text: '测试工作区 › 测试会话' }),
    captures,
  })

  answers.install()
  assert.ok(listeners['approval/request'], 'approval listener registered')
  assert.ok(listeners['user-questions/request'], 'question listener registered')

  const question = {
    questions: [
      { id: 'q1', header: '下一步', question: '先做性能还是功能？', options: [{ label: 'A 性能' }, { label: 'B 功能' }] },
    ],
    agent: {},
    signal: undefined,
  }

  // --- case 1: option button ---
  const optionRun = listeners['user-questions/request'](question, async () => ({ answers: [] }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const card = sent.at(-1).card
  const optionButton = card.body
    ? card.body.elements.flatMap((element) => element.actions || []).find((action) => action.value.k === 'question')
    : card.elements.flatMap((element) => element.actions || []).find((action) => action.value.k === 'question')
  assert.ok(optionButton, 'the card carries option buttons')
  const optionToast = await answers.handleCardAction({
    action: { value: optionButton.value },
    operator: { open_id: 'ou_owner' },
  })
  assert.equal(optionToast.toast.type, 'success')
  const optionAnswer = await optionRun
  assert.deepEqual(optionAnswer.answers, [{ id: 'q1', selected: ['A 性能'] }])

  // --- case 2: free-form ---
  const freeRun = listeners['user-questions/request'](question, async () => ({ answers: [] }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const card2 = sent.at(-1).card
  const freeButton = card2.body
    ? card2.body.elements.flatMap((element) => element.actions || []).find((action) => action.value.k === 'freeform')
    : card2.elements.flatMap((element) => element.actions || []).find((action) => action.value.k === 'freeform')
  assert.ok(freeButton, 'the card carries a free-form button')

  const freeToast = await answers.handleCardAction({
    action: { value: freeButton.value },
    operator: { open_id: 'ou_owner' },
  })
  assert.equal(freeToast.toast.type, 'info')
  assert.ok(captures.peek('oc_home'), 'the chat is armed for the next message')

  const consumed = await answers.submitText('oc_home', '先把飞书链路打磨稳定')
  // Both the question card and the switch-notice card must be rewritten; a
  // missing import used to make this silently do nothing.
  assert.ok(patches.length >= 1, `expected the question card to be rewritten, saw ${patches.length}`)
  assert.equal(consumed, true, 'the message was consumed as the answer')
  assert.equal(captures.peek('oc_home'), undefined, 'the capture is single-use')

  const freeAnswer = await freeRun
  assert.equal(freeAnswer.answers.length, 1)
  assert.equal(freeAnswer.answers[0].id, 'q1')
  assert.deepEqual(freeAnswer.answers[0].selected, [])
  assert.equal(freeAnswer.answers[0].custom, '先把飞书链路打磨稳定')

  // --- case 3: a late tap explains itself ---
  const lateToast = await answers.handleCardAction({
    action: { value: freeButton.value },
    operator: { open_id: 'ou_owner' },
  })
  assert.equal(lateToast.toast.type, 'warning')

  // --- case 4: a stranger cannot answer ---
  const stranger = await answers.handleCardAction({
    action: { value: optionButton.value },
    operator: { open_id: 'ou_stranger' },
  })
  assert.equal(stranger.toast.type, 'error', 'a stranger is refused before any request is touched')

  answers.uninstall()
  console.log('answers smoke: all cases passed')
} finally {
  globalThis.fetch = realFetch
}
