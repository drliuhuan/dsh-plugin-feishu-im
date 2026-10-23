// Validate the agent tool schema without a Host.
//
// A malformed tool schema is not a local failure: the harness sends every
// exposed tool with every model request, so one bad `parameters` document makes
// *all* agents fail ("schema must be a JSON Schema of type: object"). This test
// captures the definition the plugin registers and asserts it is a complete,
// provider-acceptable JSON Schema before anything is installed.
//
// Run: node scripts/tool-schema.mjs
import assert from 'node:assert/strict'

process.env.DSH_HOME = process.env.DSH_HOME || '/tmp/fsim-tool-schema'

const { apply } = await import('../index.js')

const registered = new Map()
const scope = {
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  tools: { register(definition) { registered.set(definition.name, definition); return () => {} } },
}
const ctx = {
  logger: { warn: (message) => console.log('[warn]', message) },
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  on() { return () => {} },
  inject(deps, callback) {
    if (deps.includes('tools')) callback(scope)
  },
  get() { return undefined },
}

apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 300))

assert.ok(registered.has('feishu_sessions'), 'feishu_sessions was not registered (schema problem caught)')
assert.ok(registered.has('feishu_permission'), 'feishu_permission was not registered (schema problem caught)')

const parameters = registered.get('feishu_sessions').parameters
assert.equal(parameters.type, 'object', 'parameters must be a JSON Schema object')
assert.equal(parameters.additionalProperties, false)
assert.ok(parameters.properties?.action, 'action parameter is declared')
assert.deepEqual(parameters.properties.action.enum, ['list', 'current', 'switch'])
assert.deepEqual(parameters.required, ['action'], 'required is an array at the object level')

function assertNoPropertyRequired(node, path = '$') {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoPropertyRequired(item, `${path}[${index}]`))
    return
  }
  if ('required' in node && node.required !== undefined) {
    assert.ok(Array.isArray(node.required), `${path}.required must be an array, got ${typeof node.required}`)
  }
  for (const [key, value] of Object.entries(node)) assertNoPropertyRequired(value, `${path}.${key}`)
}
assertNoPropertyRequired(parameters)
assertNoPropertyRequired(registered.get('feishu_sessions').output.schema)

assert.equal(registered.get('feishu_sessions').output.schema.type, 'object', 'output schema must be a JSON Schema object')
assert.equal(typeof registered.get('feishu_sessions').output.render, 'function', 'output.render is required by the registry')
assert.equal(typeof registered.get('feishu_sessions').execute, 'function')

// The permission tool: a request must name a target mode, and the schema must be
// just as provider-safe as the sessions one.
const permission = registered.get('feishu_permission')
assert.equal(permission.parameters.type, 'object')
assert.deepEqual(permission.parameters.required, ['action'])
assert.deepEqual(permission.parameters.properties.action.enum, ['current', 'request'])
assert.deepEqual(permission.parameters.properties.mode.enum, ['readonly', 'workspace', 'auto', 'full'])
assertNoPropertyRequired(permission.parameters)
assertNoPropertyRequired(permission.output.schema)
assert.equal(permission.output.schema.type, 'object')
assert.equal(typeof permission.output.render, 'function')
assert.equal(typeof permission.execute, 'function')

console.log('feishu_sessions parameters:', JSON.stringify(parameters, null, 2))
console.log('tool schema: all checks passed')
