// Smoke-render the plugin's client half with a minimal React shim.
// Goal: surface synchronous render crashes (undefined refs, bad props) without
// a browser. Not a substitute for the real page; it only proves the tree builds.

const hooks = { index: 0, forced: null }
const React = {
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) { this.props = props || {} }
  },
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  useState(initial) {
    hooks.index += 1
    let value = initial
    if (initial === null && hooks.index === 1 && hooks.forced !== null) value = hooks.forced
    return [value, () => {}]
  },
  useEffect() { hooks.index += 1 },
  useRef(value) { hooks.index += 1; return { current: value } },
  useCallback(fn) { hooks.index += 1; return fn },
}

let plugin = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      plugin = factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
      plugin.__id = id
    },
  },
}

globalThis.fetch = async () => new Response(JSON.stringify({ state: null }), { status: 200 })

await import('/home/drliuhuan/workspace/plugins/dsh-plugin-feishu-im/client.js')

if (!plugin) throw new Error('client module did not register')

globalThis.document = {
  head: { appendChild() {} },
  createElement() { return { setAttribute() {}, textContent: '', parentNode: null } },
}

let registered = null
const ctx = {
  get: () => undefined,
  effect(fn) { return fn(); },
  slots: {
    inject(key, cb) { return cb() },
    register(options, component) { registered = { options, component }; return () => {} },
  },
}

plugin.apply(ctx)
if (!registered) throw new Error('no slot registration')

function render(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { node.forEach((child, i) => render(child, path + '[' + i + ']')); return }
  if (typeof node.type === 'function') {
    hooks.index = 0
    const props = { ...node.props, children: node.children.length ? node.children : node.props.children }
    let out
    if (node.type.prototype && node.type.prototype.render) {
      const instance = new node.type(props)
      if (instance.state !== undefined && node.type.getDerivedStateFromError) {
        // Exercise the failure state of the boundary so its markup is covered.
        instance.state = node.type.getDerivedStateFromError(new Error('smoke'))
      }
      out = instance.render()
    } else {
      out = node.type(props)
    }
    render(out, path + '>' + (node.type.name || 'component'))
    return
  }
  if (typeof node.type === 'symbol') {
    node.children.forEach((child, i) => render(child, path + '>Fragment[' + i + ']'))
    return
  }
  node.children.forEach((child, i) => render(child, path + '>' + String(node.type) + '[' + i + ']'))
}

async function run(label) {
  try {
    hooks.index = 0
    const out = registered.component({ close() {} })
    render(out, label)
    console.log('render ok:', label)
    return true
  } catch (error) {
    console.error('render FAILED:', label, '→', error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error)
    return false
  }
}

await run('loading')
hooks.forced = {
  configured: true, appId: 'cli_x', domain: 'feishu', botName: 'B', botOpenId: 'ou_b', ownerOpenId: 'ou_o',
  allowedOpenIds: ['ou_o'], homeChatId: '', notify: { turnEnd: true, approval: true, question: true },
  allowCommands: true, awayMode: false, updatedAt: 0, stateFile: '/tmp/state.json',
}
await run('connected')
hooks.forced = {
  configured: false, appId: '', domain: 'feishu', botName: '', botOpenId: '', ownerOpenId: '',
  allowedOpenIds: [], homeChatId: '', notify: { turnEnd: true, approval: true, question: true },
  allowCommands: true, awayMode: false, updatedAt: 0, stateFile: '/tmp/state.json',
}
await run('connect')
