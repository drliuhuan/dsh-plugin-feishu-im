import assert from 'node:assert/strict'
// Two-step permission switching, end to end against stubs: the picker must not
// apply anything, the confirmation must, cancel must not, and an agent request
// only resolves after that confirmation.
import { createAnswerers } from '../lib/answers.js'
import { createPermissions } from '../lib/permissions.js'

const state = {
  version: 1, appId: 'cli_x', appSecret: 's', domain: 'feishu',
  homeChatId: 'oc_1', chatSessions: { oc_1: 'session-1' },
  allowedOpenIds: [], ownerOpenId: 'ou_1', answerTimeoutMinutes: 5,
  notify: { turnEnd: true, approval: true, question: true },
  defaultPermission: 'workspace', chatPermissions: {},
}
const readState = async () => state
const writeState = async (next) => { Object.assign(state, next); return state }

const posted = []
const sendCard = async (st, target, element) => { posted.push(element); return { messageId: `om_${posted.length}` } }
const ctx = { get: () => undefined, on: () => () => {} }

const permissions = createPermissions({ ctx, readState, writeState, trace: () => {} })
const answers = createAnswerers({
  permissions, ctx, readState, sendCard,
  log: () => {}, trace: () => {},
  isAllowed: async () => true,
  describe: () => ({ text: 'workspace › session' }),
  captures: undefined,
  onResume: async () => {},
})

const first = await answers.handleCardAction({
  action: { value: { k: 'perm', c: 'oc_1', m: 'readonly' } },
  open_message_id: 'om_1', operator: { open_id: 'ou_1' },
})
assert.ok(first?.toast, 'selection returns a toast')
assert.match(first.toast.content, /确认/, 'selection asks for confirmation')
assert.equal(state.chatPermissions.oc_1, undefined, 'selection alone must not change the mode')

const confirmCard = posted.at(-1)
const elements = confirmCard?.elements || confirmCard?.body?.elements || []
const actions = elements.find((el) => el.tag === 'action')
const confirmValue = actions.actions[0].value
assert.equal(confirmValue.k, 'permconfirm')

const second = await answers.handleCardAction({
  action: { value: confirmValue }, open_message_id: 'om_2', operator: { open_id: 'ou_1' },
})
assert.ok(second?.toast, 'confirm returns a toast')
assert.equal(state.chatPermissions.oc_1, 'readonly', 'confirmation applies the mode')

const again = await answers.handleCardAction({
  action: { value: { k: 'perm', c: 'oc_1', m: 'full' } },
  open_message_id: 'om_3', operator: { open_id: 'ou_1' },
})
const cancelCard = posted.at(-1)
const cancelActions = (cancelCard?.elements || cancelCard?.body?.elements || []).find((el) => el.tag === 'action')
await answers.handleCardAction({
  action: { value: cancelActions.actions[1].value }, open_message_id: 'om_4', operator: { open_id: 'ou_1' },
})
assert.equal(state.chatPermissions.oc_1, 'readonly', 'cancel must not change the mode')


// The agent path: requestPermissionChange posts the picker and resolves only
// after the second (confirmation) card is accepted.
const pendingRequest = answers.requestPermissionChange({ chatId: 'oc_1', reason: '需要改配置文件', mode: 'full' })
await new Promise((resolve) => setTimeout(resolve, 50))
const picker = posted.at(-1)
const pickerAction = (picker.elements || []).find((el) => el.tag === 'action')
const pickValue = pickerAction.actions[0].value
assert.equal(pickValue.k, 'perm')
assert.ok(pickValue.id, 'agent-issued picker carries the wait id')
await answers.handleCardAction({ action: { value: pickValue }, open_message_id: 'om_5', operator: { open_id: 'ou_1' } })
const confirmAfterPick = posted.at(-1)
const confirmAction = (confirmAfterPick.elements || []).find((el) => el.tag === 'action')
await answers.handleCardAction({ action: { value: confirmAction.actions[0].value }, open_message_id: 'om_6', operator: { open_id: 'ou_1' } })
const result = await pendingRequest
assert.equal(result.ok, true, 'request resolves ok after confirmation')
assert.equal(result.mode, 'readonly')
assert.equal(state.chatPermissions.oc_1, 'readonly')

console.log('permission flow smoke: click + request passed')
