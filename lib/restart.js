/**
 * Restart DSH from inside DSH.
 *
 * Three rules, all learned the hard way on this deployment:
 *  1. never restart while another session is mid-turn — report which one instead;
 *  2. write `restart.pending` first, so the *next* process can send the
 *     "back up" message (this process dies before it could);
 *  3. hand the actual restart to the supervisor (systemd / launchd) instead of
 *     spawning a replacement into the cgroup that is about to be torn down.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { getTenantToken, sendText } from './feishu.js'
import * as service from './service.js'

export function createRestart({ ctx, readState, trace, log }) {
  const markerPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feishu-im', 'restart.pending')

  /** Sessions that are mid-turn, excluding the one that asked for the restart. */
  async function runningOthers(sessionId) {
    const controller = ctx.get?.('sessionController')
    if (!controller?.list) return []
    try {
      const listed = await controller.list({}, AbortSignal.timeout(10_000))
      const items = Array.isArray(listed) ? listed : listed?.items || []
      return items.filter((item) => item?.running && item.sessionId !== sessionId)
    } catch (error) {
      trace?.('restart-busy-check-failed', { message: String(error?.message || error) })
      return []
    }
  }

  async function notify(text) {
    const state = await readState()
    if (!state.appId || !state.appSecret) return { ok: false, error: 'not configured' }
    const chatId = state.homeChatId || Object.keys(state.chatSessions || {})[0]
    if (!chatId) return { ok: false, error: 'no chat' }
    const token = await getTenantToken(state.appId, state.appSecret, state.domain)
    await sendText(token, state.domain, { receiveId: chatId, receiveIdType: 'chat_id', text })
    return { ok: true }
  }

  /** Windows has no supervisor here; a detached re-exec is the best we can do. */
  function respawnFallback(delayMs = 4000) {
    const argv = process.argv.slice(1)
    const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
    const command = argv.length === 1
      ? `${quote(process.execPath)} ${quote(argv[0])}`
      : `${quote(process.execPath)} ${argv.map(quote).join(' ')}`
    const child = spawn('/bin/sh', ['-c', `sleep ${Math.round(delayMs / 1000)}; exec ${command}`], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: process.env,
    })
    child.unref()
    return child.pid
  }

  async function perform() {
    try {
      const status = await service.status()
      if (status.installed && status.kind && status.kind !== 'none') {
        // A user-level supervisor exists: its restart is atomic and survives us.
        const result = await service.restart()
        if (result?.ok) {
          trace?.('restart-via-supervisor', { kind: status.kind })
          return
        }
        log('[feishu-im] supervisor restart failed, falling back to exit:', result?.err || '')
      }
    } catch (error) {
      trace?.('restart-supervisor-failed', { message: String(error?.message || error) })
    }

    if (process.platform === 'win32') {
      const pid = respawnFallback()
      trace?.('restart-respawn', { pid })
      process.exit(0)
    }
    // A systemd unit with Restart=always (or launchd KeepAlive) brings us back.
    trace?.('restart-exit')
    process.kill(process.pid, 'SIGTERM')
  }

  /**
   * Ask for a restart. Resolves before the process dies, so the caller can send
   * its acknowledgement first; the actual restart happens a moment later.
   */
  async function request({ sessionId, reason = '手动重启', notify: announce = true } = {}) {
    const busy = await runningOthers(sessionId)
    if (busy.length > 0) {
      const names = busy.slice(0, 3).map((item) => item?.title || item?.sessionId?.slice(0, 12) || '?').join('、')
      await (announce ? notify(`⏸ 没有重启 DSH：${busy.length} 个会话正在跑任务（${names}）。等它们结束后再试。`) : Promise.resolve())
        .catch(() => {})
      return { ok: false, error: `有 ${busy.length} 个会话正在跑任务（${names}），已取消重启。`, busy: busy.length }
    }

    try {
      await mkdir(dirname(markerPath), { recursive: true })
      await writeFile(markerPath, JSON.stringify({ requestedAt: Date.now(), reason }))
    } catch (error) {
      trace?.('restart-marker-failed', { message: String(error?.message || error) })
    }

    if (announce) {
      await notify(`🔁 DSH 即将重启（${reason}），页面会短暂断连；重启完成后会再发一条消息。`).catch((error) => {
        trace?.('restart-notice-failed', { message: String(error?.message || error) })
      })
    }

    setTimeout(() => {
      void perform()
    }, 1500)
    return { ok: true, message: '正在重启 DSH…' }
  }

  return { request, runningOthers }
}
