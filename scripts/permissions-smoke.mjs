// Permission modes: the mapping onto sandbox/approval knobs, and the one rule
// that makes `auto` safe (it never rubber-stamps privilege escalation).
import assert from 'node:assert/strict'

const { PERMISSION_MODES, PERMISSION_KEYS, isPermissionKey, shouldAutoApprove, DEFAULT_PERMISSION } =
  await import('../lib/permissions.js')

assert.deepEqual(PERMISSION_KEYS, ['readonly', 'workspace', 'auto', 'full'])
assert.equal(DEFAULT_PERMISSION, 'workspace')
assert.equal(PERMISSION_MODES.readonly.sandbox, 'read-only')
assert.equal(PERMISSION_MODES.workspace.sandbox, 'workspace-write')
assert.equal(PERMISSION_MODES.auto.sandbox, 'workspace-write')
assert.equal(PERMISSION_MODES.full.sandbox, 'danger-full-access')
assert.equal(PERMISSION_MODES.full.approval, 'never')
assert.equal(PERMISSION_MODES.auto.approval, 'ask', 'auto keeps asking so the plugin can decide')

for (const key of PERMISSION_KEYS) {
  assert.equal(isPermissionKey(key), true)
  assert.equal(typeof PERMISSION_MODES[key].label, 'string')
  assert.ok(PERMISSION_MODES[key].hint.length > 4)
}
assert.equal(isPermissionKey('yolo'), false)

// Auto review: ordinary workspace work is approved, escalation is not.
assert.equal(shouldAutoApprove('auto', { toolName: 'bash', reason: '需要读取工作区文件' }), true)
assert.equal(shouldAutoApprove('auto', { toolName: 'bash', reason: '允许本次操作使用 danger-full-access 权限' }), false)
assert.equal(shouldAutoApprove('auto', { displayReason: { zh: '申请完全权限' } }), false)
assert.equal(shouldAutoApprove('workspace', { reason: '普通操作' }), false, 'only auto mode reviews')
assert.equal(shouldAutoApprove('full', { reason: '普通操作' }), false)

console.log('permissions smoke: all cases passed')
