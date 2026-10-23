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
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const UNIT_NAME = 'dsh.service'
export const UNIT_PATH = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME)
export const LAUNCHD_LABEL = 'com.dsh.web'
export const LAUNCHD_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)

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
/**
 * Which supervision backend this platform can offer without root.
 *
 * Linux  — systemd user units (`systemctl --user`), no sudo.
 * macOS  — launchd user agents (`~/Library/LaunchAgents`), no sudo.
 * other  — nothing rootless is implemented, so the Settings option is disabled
 *          and says why instead of failing halfway.
 */
export function platformInfo(platform = process.platform) {
  if (platform === 'linux') {
    return { platform, supported: true, kind: 'systemd', label: '用户级 systemd', reason: '' }
  }
  if (platform === 'darwin') {
    return { platform, supported: true, kind: 'launchd', label: 'launchd 用户代理', reason: '' }
  }
  return {
    platform,
    supported: false,
    kind: 'none',
    label: '',
    reason: '当前仅支持 Linux（用户级 systemd）与 macOS（launchd）；Windows 请用系统自带的服务管理器或任务计划程序。',
  }
}

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

/** The unit whose cgroup *this* process runs in, if any. */
export function selfUnit() {
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim()
    for (const line of cgroup.split('\n')) {
      for (const part of line.split('/')) {
        if (part.endsWith('.service')) return part.trim()
      }
    }
  } catch {
    /* not Linux, or no /proc */
  }
  return ''
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

export function renderPlist({ argv = process.argv, execPath = process.execPath, cwd = process.cwd() } = {}) {
  const args = [execPath, ...argv.slice(1)]
  const argXml = args.map((arg) => `    <string>${arg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.dsh', 'restart.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.dsh', 'restart.log')}</string>
</dict>
</plist>
`
}

export async function status() {
  const platform = platformInfo()
  const hostUnit = selfUnit()
  if (platform.kind === 'launchd') {
    const file = await readFile(LAUNCHD_PATH, 'utf8').catch(() => '')
    return {
      ...platform,
      unitPath: LAUNCHD_PATH,
      installed: Boolean(file),
      unit: file,
      active: await launchdLoaded(),
      enabled: Boolean(file),
      linger: true,
      systemHosted: false,
      mode: (await launchdLoaded()) ? 'user-service' : 'none',
      canInstall: !(await launchdLoaded()),
      warnings: (await launchdLoaded())
        ? []
        : ['当前不是服务模式：进程退出后不会自动拉起；安装后会由 launchd 以 KeepAlive 方式托管，不需要 sudo。'],
      hint: '',
    }
  }
  if (!platform.supported) {
    return {
      ...platform,
      unitPath: '',
      installed: false,
      unit: '',
      active: false,
      enabled: false,
      linger: undefined,
      systemHosted: false,
      mode: 'unsupported',
      canInstall: false,
      warnings: [],
      hint: platform.reason,
    }
  }
  const [file, linger, active, enabled, systemHosted] = await Promise.all([
    readFile(UNIT_PATH, 'utf8').catch(() => ''),
    lingerEnabled(),
    systemctl(['is-active', UNIT_NAME]),
    systemctl(['is-enabled', UNIT_NAME]),
    systemUnitActive(),
  ])
  const userUnitActive = active.out === 'active'
  const mode = systemHosted
    ? 'system-service'
    : userUnitActive && hostUnit === UNIT_NAME
      ? 'user-service'
      : 'none'
  return {
    ...platform,
    unitPath: UNIT_PATH,
    installed: Boolean(file),
    unit: file,
    active: userUnitActive,
    enabled: enabled.out === 'enabled',
    linger,
    systemHosted,
    mode,
    // Installing is only meaningful when nothing supervises this process yet.
    canInstall: mode === 'none',
    warnings: mode === 'none'
      ? [
          '当前不是服务模式：进程退出或机器重启后不会自动拉起，关掉终端/注销也会中断。',
          linger === false
            ? '用户级服务默认随登录会话结束而停止；要「注销后仍运行」需在有 root 的终端执行一次 `loginctl enable-linger ' + (process.env.USER || '用户') + '`。'
            : '安装后由用户级 systemd 托管（`systemctl --user`），全程不需要 sudo。',
        ]
      : [],
    hint: mode === 'system-service'
      ? '已由系统级 dsh.service 托管（需要 root 才能改动），无需也不能再装用户级服务。'
      : mode === 'user-service'
        ? '已由用户级 dsh.service 托管，无需重复安装。'
        : '',
  }
}

async function launchdLoaded() {
  try {
    const result = await run('launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${LAUNCHD_LABEL}`], { timeout: 8000 })
    return String(result.stdout || '').length > 0
  } catch {
    return false
  }
}

export async function install(options = {}) {
  const platform = platformInfo()
  if (!platform.supported) return { ok: false, error: platform.reason }
  if (platform.kind === 'launchd') {
    const plist = renderPlist(options)
    await mkdir(dirname(LAUNCHD_PATH), { recursive: true })
    await writeFile(LAUNCHD_PATH, plist, { mode: 0o644 })
    const boot = await run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? ''}`, LAUNCHD_PATH], { timeout: 15000 })
      .then(() => ({ ok: true, err: '' }))
      .catch((error) => ({ ok: false, err: String(error?.stderr || error?.message || error) }))
    if (!boot.ok) return { ok: false, error: `launchctl bootstrap 失败：${boot.err}`, unit: plist }
    return { ok: true, unitPath: LAUNCHD_PATH, unit: plist, note: '已注册 launchd 用户代理，KeepAlive 会让它在退出后自动拉起。' }
  }
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
  const platform = platformInfo()
  if (platform.kind === 'launchd') {
    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${LAUNCHD_LABEL}`], { timeout: 15000 }).catch(() => {})
    await rm(LAUNCHD_PATH, { force: true })
    return { ok: true, removed: true, error: '' }
  }
  const disable = await systemctl(['disable', '--now', UNIT_NAME])
  await rm(UNIT_PATH, { force: true })
  const reload = await systemctl(['daemon-reload'])
  return { ok: disable.ok || /not loaded|No such file/.test(disable.err) || !disable.err, removed: true, error: disable.ok ? '' : disable.err, reloaded: reload.ok }
}

export async function restart() {
  const platform = platformInfo()
  if (platform.kind === 'launchd') {
    try {
      await run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${LAUNCHD_LABEL}`], { timeout: 15000 })
      return { ok: true, out: '', err: '' }
    } catch (error) {
      return { ok: false, out: '', err: String(error?.stderr || error?.message || error) }
    }
  }
  if (!platform.supported) return { ok: false, err: platform.reason }
  return systemctl(['restart', UNIT_NAME])
}
