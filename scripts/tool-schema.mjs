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

let registered = null
const scope = {
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  tools: { register(definition) { registered = definition; return () => {} } },
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

assert.ok(registered, 'feishu_sessions was not registered (the plugin caught a schema problem)')
assert.equal(registered.name, 'feishu_sessions')

const parameters = registered.parameters
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
assertNoPropertyRequired(registered.output.schema)

assert.equal(registered.output.schema.type, 'object', 'output schema must be a JSON Schema object')
assert.equal(typeof registered.output.render, 'function', 'output.render is required by the registry')
assert.equal(typeof registered.execute, 'function')

console.log('feishu_sessions parameters:', JSON.stringify(parameters, null, 2))
console.log('tool schema: all checks passed')
