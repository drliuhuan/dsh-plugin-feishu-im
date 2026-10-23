/**
 * Durable plugin state.
 *
 * Why a file instead of plugin Config: the App Secret must not live in
 * `cordis.patch.yml` (plain text, often copied/synced), and the harness keeps no
 * generic record for an arbitrary app secret. A 0600 JSON document under
 * `$DSH_HOME/feishu-im/` is the smallest thing that is both secret-bearing and
 * survives restarts, which is the same shape the CLI agents on this machine use
 * for their own credentials.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = 1

/** Directory holding this plugin's own state. */
function stateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'feishu-im')
}

/** Absolute path of the state document. */
export function stateFile() {
  return join(stateDir(), 'state.json')
}

/** The shape every reader merges onto; absent fields keep these values. */
const DEFAULTS = {
  version: VERSION,
  appId: '',
  appSecret: '',
  domain: 'feishu',
  botName: '',
  botOpenId: '',
  ownerOpenId: '',
  allowedOpenIds: [],
  homeChatId: '',
  chatSessions: {},
  notify: { turnEnd: true, approval: true, question: true },
  allowCommands: true,
  awayMode: false,
  // 'feishu': the card is the only prompt (the web UI stays silent), so a
  //           Feishu answer cannot leave a dangling prompt behind.
  // 'both':   both surfaces ask and the first answer wins.
  answerMode: 'feishu',
  // Minutes to wait for a Feishu answer before handing the request back to the
  // DSH web prompt. 0 waits forever.
  answerTimeoutMinutes: 5,
  updatedAt: 0,
}

/** Normalize whatever was stored into one complete state object. */
function normalize(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {}
  const notify = source.notify && typeof source.notify === 'object' ? source.notify : {}
  return {
    ...DEFAULTS,
    ...source,
    domain: source.domain === 'lark' ? 'lark' : 'feishu',
    allowedOpenIds: Array.isArray(source.allowedOpenIds)
      ? source.allowedOpenIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
      : [],
    notify: {
      turnEnd: notify.turnEnd !== false,
      approval: notify.approval !== false,
      question: notify.question !== false,
    },
    chatSessions: source.chatSessions && typeof source.chatSessions === 'object'
      ? Object.fromEntries(
          Object.entries(source.chatSessions).filter(
            ([chat, session]) => typeof chat === 'string' && typeof session === 'string' && session,
          ),
        )
      : {},
    answerMode: source.answerMode === 'both' ? 'both' : 'feishu',
    answerTimeoutMinutes: Number.isFinite(source.answerTimeoutMinutes)
      ? Math.max(0, Math.min(120, Math.round(source.answerTimeoutMinutes)))
      : 5,
    allowCommands: source.allowCommands !== false,
    awayMode: source.awayMode === true,
    version: VERSION,
  }
}

/** Read the state document; a missing or corrupt file reads as defaults. */
export async function readState() {
  try {
    return normalize(JSON.parse(await readFile(stateFile(), 'utf8')))
  } catch {
    return normalize(undefined)
  }
}

/** Atomically replace the state document with `0600` permissions. */
export async function writeState(next) {
  const state = normalize(next)
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  const target = stateFile()
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), { mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => {})
  await rename(temporary, target)
  await chmod(target, 0o600).catch(() => {})
  return { ...state, updatedAt: Date.now() }
}

/** Remove the document (disconnect). */
export async function clearState() {
  await rm(stateFile(), { force: true })
  return normalize(undefined)
}

/** Project state for the browser: never carries the App Secret. */
export function publicState(state) {
  const value = normalize(state)
  return {
    configured: Boolean(value.appId && value.appSecret),
    appId: value.appId,
    domain: value.domain,
    botName: value.botName,
    botOpenId: value.botOpenId,
    ownerOpenId: value.ownerOpenId,
    allowedOpenIds: value.allowedOpenIds,
    homeChatId: value.homeChatId,
    chatSessions: value.chatSessions,
    notify: value.notify,
    allowCommands: value.allowCommands,
    answerMode: value.answerMode,
    answerTimeoutMinutes: value.answerTimeoutMinutes,
    awayMode: value.awayMode,
    updatedAt: value.updatedAt,
    stateFile: stateFile(),
  }
}
