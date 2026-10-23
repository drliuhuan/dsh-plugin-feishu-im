/**
 * Rootless service management.
 *
 * Making DSH survive a logout or a reboot needs a supervisor. A *system* unit
 * needs root — and this deployment is driven from a web UI / Feishu, where there
 * is no terminal to type a sudo password into. A **user** unit needs no sudo at
 * all: systemd's per-user manager owns it, `Restart=always` works the same, and
 * with lingering enabled it also starts at boot without a login.
 *
 * This module only ever touches `~/.config/systemd/user/dsh.service` and
 * `systemctl --user`, so nothing here can escalate.
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const UNIT_NAME = 'dsh.service'
export const UNIT_PATH = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME)

function userEnv() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
  }
}

async function systemctl(args, { timeout = 15_000 } = {}) {
  try {
    const result = await run('systemctl', ['--user', ...args], { env: userEnv(), timeout })
    return { ok: true, out: String(result.stdout || '').trim(), err: '' }
  } catch (error) {
    return { ok: false, out: String(error?.stdout || '').trim(), err: String(error?.stderr || error?.message || error).trim() }
  }
}

/** systemd quoting: double quotes when the argument carries spaces or quotes. */
function quote(arg) {
  if (!/[^\w@%+=:,./-]/.test(arg)) return arg
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`
}

/** The exact command line this host was started with, as a systemd ExecStart. */
export function execStartLine(argv = process.argv, execPath = process.execPath) {
  const parts = [execPath, ...argv.slice(1)].map(quote)
  return parts.join(' ')
}

export function renderUnit({ argv = process.argv, execPath = process.execPath, cwd = process.cwd(), description } = {}) {
  return `[Unit]
Description=${description || 'DeepSeek Harness Web UI (dsh, user service)'}
After=network.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${execStartLine(argv, execPath)}
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
`
}

async function systemUnitActive() {
  try {
    const result = await run('systemctl', ['show', UNIT_NAME, '-p', 'LoadState', '-p', 'ActiveState'], { timeout: 8000 })
    const text = String(result.stdout || '')
    const load = /LoadState=(\S+)/.exec(text)?.[1] || ''
    const active = /ActiveState=(\S+)/.exec(text)?.[1] || ''
    return load && load !== 'not-found' && active === 'active'
  } catch {
    return false
  }
}

async function lingerEnabled() {
  try {
    const result = await run('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger'], { timeout: 8000 })
    return String(result.stdout || '').includes('Linger=yes')
  } catch {
    try {
      const user = String(process.env.USER || '')
      if (!user) return undefined
      const result = await run('loginctl', ['show-user', user, '-p', 'Linger'], { timeout: 8000 })
      return String(result.stdout || '').includes('Linger=yes')
    } catch {
      return undefined
    }
  }
}

export async function status() {
  const [file, linger, active, enabled, systemHosted] = await Promise.all([
    readFile(UNIT_PATH, 'utf8').catch(() => ''),
    lingerEnabled(),
    systemctl(['is-active', UNIT_NAME]),
    systemctl(['is-enabled', UNIT_NAME]),
    systemUnitActive(),
  ])
  return {
    unitPath: UNIT_PATH,
    installed: Boolean(file),
    unit: file,
    active: active.out === 'active',
    enabled: enabled.out === 'enabled',
    linger,
    systemHosted,
    // Everything here is rootless; the only reason to mention sudo is a system
    // unit that someone else created.
    hint: systemHosted
      ? '当前由系统级 dsh.service 托管（需要 root 才能改动）；用户级服务不应与它同时运行。'
      : linger === false
        ? '用户级服务已可用，但未开启 linger：注销后会被停止。开启需要在有 root 的终端执行一次 `loginctl enable-linger ' + (process.env.USER || '') + '`。'
        : '',
  }
}

export async function install(options = {}) {
  if (await systemUnitActive()) {
    return { ok: false, error: '已经由系统级 dsh.service 托管，不能同时安装用户级服务；如需切换，请先让有 root 权限的人执行 `systemctl disable --now dsh.service`。' }
  }
  const text = renderUnit(options)
  await mkdir(dirname(UNIT_PATH), { recursive: true })
  await writeFile(UNIT_PATH, text, { mode: 0o644 })
  const reload = await systemctl(['daemon-reload'])
  if (!reload.ok) return { ok: false, error: `daemon-reload 失败：${reload.err}`, unit: text }
  const enable = await systemctl(['enable', UNIT_NAME])
  if (!enable.ok) return { ok: false, error: `enable 失败：${enable.err}`, unit: text }
  return {
    ok: true,
    unitPath: UNIT_PATH,
    unit: text,
    // Deliberately not started: the current process still owns the port, and
    // starting it now would just lose a restart race. The next restart (or the
    // next boot) hands over to the unit.
    note: '已写入并设为开机自启；下次重启 DSH（或重启机器）时由用户级 systemd 接管，重启过程仍然不需要 sudo。',
  }
}

export async function remove() {
  const disable = await systemctl(['disable', '--now', UNIT_NAME])
  await rm(UNIT_PATH, { force: true })
  const reload = await systemctl(['daemon-reload'])
  return { ok: disable.ok || /not loaded|No such file/.test(disable.err) || !disable.err, removed: true, error: disable.ok ? '' : disable.err, reloaded: reload.ok }
}

export async function restart() {
  const result = await systemctl(['restart', UNIT_NAME])
  return result
}
