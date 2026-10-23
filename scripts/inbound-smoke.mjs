// The routing decision for messages that arrive while a turn is running:
// steering by default, queueing on request, queueing when idle.
import assert from 'node:assert/strict'

const { deliveryMode } = await import('../lib/inbound.js')

assert.equal(deliveryMode(true, false), 'steer', 'running turn + plain message steers')
assert.equal(deliveryMode(true, true), 'queue', '/queue opts out of steering')
assert.equal(deliveryMode(false, false), 'queue', 'idle session admits a normal turn')
assert.equal(deliveryMode(false, true), 'queue', '/queue is harmless when idle')
assert.equal(deliveryMode(undefined, false), 'queue', 'unknown status falls back to queueing')

console.log('inbound smoke: all cases passed')
