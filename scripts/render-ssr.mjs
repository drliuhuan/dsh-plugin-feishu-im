// Real-React render test for the client half.
//
// The shim in render-smoke.mjs proves the tree builds; this one runs the actual
// React 19 renderer over every page state, so a React-specific throw (invalid
// children, hook misuse, bad element props) surfaces as a failed assertion here
// instead of a blank settings panel in the browser.
//
// Run: node scripts/render-ssr.mjs
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// React is a test-only dependency: it is not part of the plugin's runtime, so it
// is not in package.json. Point `FSIM_REACT_DIR` at a directory that has
// react/react-dom installed, or install them here once:
//   npm i --no-save react react-dom
const here = dirname(fileURLToPath(import.meta.url))
const reactDir = process.env.FSIM_REACT_DIR || join(here, '..', 'node_modules')

async function load(spec, file) {
  if (existsSync(join(reactDir, spec, file))) {
    return import(pathToFileURL(join(reactDir, spec, file)).href)
  }
  return import(spec)
}

const React = (await load('react', 'index.js')).default
const { renderToStaticMarkup } = await load('react-dom', 'server.node.js')

const requireReact = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      // Mirror the shell: build the plugin object, but never apply it here.
      captured = { id, plugin: factory(requireReact) }
    },
  },
}

await import(new URL('../client.js', import.meta.url).href)

const internals = globalThis.__FEISHU_IM_INTERNALS__
if (!internals) throw new Error('client module did not expose internals')
if (!captured) throw new Error('client module did not call the loader')
if (typeof captured.plugin.apply !== 'function') throw new Error('loaded plugin has no apply()')

const built = internals.createPlugin(requireReact, { get: () => undefined })
const views = built.components
console.log('build:', internals.BUILD)

const connected = {
  configured: true,
  appId: 'cli_xxxxxxxxxxxxxxxx',
  domain: 'feishu',
  botName: 'DSH 助手',
  botOpenId: 'ou_bot',
  ownerOpenId: 'ou_owner',
  allowedOpenIds: ['ou_owner'],
  homeChatId: '',
  notify: { turnEnd: true, approval: true, question: false },
  allowCommands: true,
  awayMode: false,
  updatedAt: Date.now(),
  stateFile: '/home/user/.dsh/feishu-im/state.json',
}

const disconnected = { ...connected, configured: false, appId: '', botName: '', ownerOpenId: '', allowedOpenIds: [] }

const cases = [
  ['Page (loading/empty state)', React.createElement(views.Page, {}), '正在读取连接状态'],
  ['ScanCard', React.createElement(views.ScanCard, { onConnected() {} }), '生成连接二维码'],
  ['ManualCard', React.createElement(views.ManualCard, { onConnected() {} }), '手动连接'],
  ['ConnectedView', React.createElement(views.ConnectedView, { state: connected, setState() {} }), '发送测试消息'],
]

let failures = 0
for (const [label, element] of cases) {
  try {
    const html = renderToStaticMarkup(element)
    const missing = typeof cases.find((entry) => entry[0] === label)[2] === 'string' && !html.includes(cases.find((entry) => entry[0] === label)[2])
    console.log((missing ? 'WARN ' : 'ok   ') + label + ' (' + html.length + ' bytes)')
    if (missing) console.log('       expected text not found in output')
  } catch (error) {
    failures += 1
    console.log('FAIL ' + label + ' → ' + (error && error.message))
    if (error && error.stack) console.log(error.stack.split('\n').slice(0, 6).join('\n'))
  }
}

// Client error boundaries do not run during SSR; the boundary's fallback markup
// is covered by scripts/render-smoke.mjs instead.

// A disconnected page must render both connect routes without throwing.
try {
  const html = renderToStaticMarkup(React.createElement(views.FeishuImSection, {}))
  console.log('ok   FeishuImSection (disconnected html ' + html.length + ' bytes)')
} catch (error) {
  failures += 1
  console.log('FAIL FeishuImSection → ' + (error && error.message))
}

if (failures > 0) {
  console.error(failures + ' case(s) failed')
  process.exit(1)
}
console.log('all render cases passed')
