// Session listing/switching against a fake Host.
//
// Run: DSH_HOME=$(mktemp -d) node scripts/sessions-smoke.mjs
import assert from 'node:assert/strict'

const { createSessions } = await import('../lib/sessions.js')
const { readState, writeState } = await import('../lib/state.js')

const now = Date.now()
const summaries = [
  {
    sessionId: 'session-aaaa1111-2222-3333-4444-555566667777',
    updatedAt: now - 60_000,
    running: true,
    cwd: '/home/me/work/alpha',
    projections: { values: { title: '规划飞书插件' } },
  },
  {
    sessionId: 'session-bbbb8888-9999-0000-1111-222233334444',
    updatedAt: now - 3_600_000,
    running: false,
    cwd: '/home/me/work/beta',
    projections: { values: { title: '修 CI 流水线' } },
  },
  {
    // A subagent child must never appear in the picker.
    sessionId: 'session-ccccchild',
    updatedAt: now,
    running: false,
    parentSessionId: 'session-aaaa1111-2222-3333-4444-555566667777',
    cwd: '/home/me/work/alpha',
    projections: { values: { title: '子代理' } },
  },
]

const ctx = {
  get: (name) => {
    if (name === 'sessionController') return { list: async () => summaries }
    if (name === 'workspaceRegistry') return { list: () => [{ path: '/home/me/work/alpha', title: '工作区 Alpha' }] }
    return undefined
  },
}

await writeState({ appId: 'cli_test', appSecret: 'secret_test_value', domain: 'feishu', homeChatId: 'oc_test' })

const sessions = createSessions({ ctx, readState, writeState, trace: () => {} })

const rows = await sessions.list()
assert.equal(rows.length, 2, 'subagent children are filtered out')
assert.equal(rows[0].label, '规划飞书插件')
assert.equal(rows[0].workspace, '工作区 Alpha')
assert.equal(rows[1].label, '修 CI 流水线')

const filtered = await sessions.list({ query: 'ci' })
assert.equal(filtered.length, 1)
assert.equal(filtered[0].label, '修 CI 流水线')

const formatted = sessions.format(rows, rows[0].sessionId)
assert.match(formatted, /1\. \*\*规划飞书插件\*\* ←当前/)
assert.match(formatted, /2\. \*\*修 CI 流水线\*\*/)

// Indexes resolve against what the operator last saw.
sessions.remember('oc_test', rows)
assert.equal((await sessions.resolve('oc_test', '2')).sessionId, rows[1].sessionId)
assert.equal((await sessions.resolve('oc_test', 'session-bbbb')).sessionId, rows[1].sessionId)
assert.equal((await sessions.resolve('oc_test', 'CI')).sessionId, rows[1].sessionId)
assert.equal((await sessions.resolve('oc_test', rows[1].sessionId)).sessionId, rows[1].sessionId)
await assert.rejects(() => sessions.resolve('oc_test', 'nope'), /没找到匹配/)

await sessions.switchTo('oc_test', rows[1])
assert.equal(await sessions.current('oc_test'), rows[1].sessionId)
assert.equal((await sessions.chatOfSession(rows[1].sessionId)).chatId, 'oc_test')
assert.equal(await sessions.chatOfSession('session-unknown'), undefined)

const afterSwitch = sessions.format(rows, await sessions.current('oc_test'))
assert.match(afterSwitch, /2\. \*\*修 CI 流水线\*\* ←当前/, 'the current marker follows the binding')

console.log('sessions smoke: all cases passed')
