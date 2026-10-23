// The "send test message" target: manual credentials have no owner open_id
// until the operator messages the bot, which used to make the button fail.
import assert from 'node:assert/strict'

const { pickTestTarget } = await import('../lib/feishu.js')

assert.deepEqual(
  pickTestTarget({ homeChatId: 'oc_1', ownerOpenId: 'ou_1' }),
  { receiveId: 'oc_1', receiveIdType: 'chat_id', source: 'bound-chat' },
  'a bound chat wins: it is where the conversation actually lives',
)
assert.deepEqual(
  pickTestTarget({ ownerOpenId: 'ou_1', allowedOpenIds: ['ou_2'] }),
  { receiveId: 'ou_1', receiveIdType: 'open_id', source: 'owner' },
  'the scanned owner works without a chat binding',
)
assert.deepEqual(
  pickTestTarget({ allowedOpenIds: ['ou_2'] }),
  { receiveId: 'ou_2', receiveIdType: 'open_id', source: 'allowlist' },
  'allowlist entry is a valid target',
)
assert.deepEqual(
  pickTestTarget({}, [{ chatId: 'oc_2', name: 'me' }]),
  { receiveId: 'oc_2', receiveIdType: 'chat_id', source: 'bot-chat' },
  'manual credentials fall back to a chat the bot is in',
)
assert.equal(pickTestTarget({}, []), undefined, 'nothing reachable → caller must explain why')

console.log('target smoke: all cases passed')
