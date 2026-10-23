#!/usr/bin/env python3
"""Restart the DSH host in place, with a Feishu heads-up on both sides.

There is no terminal to Ctrl-C when you only have the web UI, and a plugin
install can leave HMR wedged ("HMR transactions cannot be nested") until the
process restarts. This script does that safely:

  1. detaches itself (double fork + setsid) so the Host's own shutdown cannot
     kill the helper mid-way — that bug cost a manual restart on 2026-10-23;
  2. refuses to run while another session is mid-turn, and says which one;
  3. sends a Feishu message right before the kill and another once the new
     process is listening again;
  4. SIGTERMs the Host (SIGKILL after a grace period), restarts the exact same
     argv / cwd / environment, then waits for the port before reporting success.

Usage:
  python3 scripts/restart-dsh.py --delay 30          # the normal call
  python3 scripts/restart-dsh.py --check             # is anything running?
  python3 scripts/restart-dsh.py --dry-run           # print the plan only
  python3 scripts/restart-dsh.py --self-test         # prove the detach works

The "another session is running" check reads the plugin trace log
(`<DSH_HOME>/feishu-im/host-probe.log`, turn/start vs turn/end). The session that
asked for the restart is excluded via DSH_SESSION_ID or --exclude-session.
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

LOG_PATH = os.path.expanduser('~/.dsh/restart.log')
PROBE_PATH = os.path.expanduser('~/.dsh/feishu-im/host-probe.log')
STATE_PATH = os.path.expanduser('~/.dsh/feishu-im/state.json')
PORT = 3080
TURN_LINE = re.compile(r'^(\S+) event \{"type":"(turn/start|turn/end)","session":"([^"]+)"')
FRESH_SECONDS = 6 * 3600


def log(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}\n"
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as handle:
            handle.write(line)
    except OSError:
        pass
    print(line, end='', flush=True)


def daemonize() -> None:
    """Detach from the caller so the Host's shutdown cannot take us down.

    A plain `setsid` keeps the parent pid, so a Host that reaps its descendants
    kills the helper before it can start the replacement — exactly what happened
    on 2026-10-23 15:40. Double-forking reparents us to init and gives us our own
    session, so both the kill and the respawn outlive the Host.
    """
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir('/')
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)


def find_host_pids() -> list[int]:
    pids = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == os.getpid():
            continue
        try:
            raw = open(f'/proc/{pid}/cmdline', 'rb').read()
        except OSError:
            continue
        argv = [part.decode('utf-8', 'replace') for part in raw.split(b'\0') if part]
        if not argv or 'restart-dsh.py' in ' '.join(argv):
            continue
        looks_like_dsh = any(part.endswith('/dsh') or part == 'dsh' for part in argv[:3])
        if looks_like_dsh and 'web' in argv[1:4]:
            pids.append(pid)
    return pids


def proc_facts(pid: int) -> tuple[list[str], str, dict[str, str]]:
    raw_argv = open(f'/proc/{pid}/cmdline', 'rb').read()
    argv = [part.decode('utf-8', 'replace') for part in raw_argv.split(b'\0') if part]
    cwd = os.readlink(f'/proc/{pid}/cwd')
    env: dict[str, str] = {}
    for chunk in open(f'/proc/{pid}/environ', 'rb').read().split(b'\0'):
        if not chunk:
            continue
        key, _, value = chunk.partition(b'=')
        env[key.decode('utf-8', 'replace')] = value.decode('utf-8', 'surrogateescape')
    return argv, cwd, env


def is_excluded(session: str, exclude: set[str]) -> bool:
    """Trace lines shorten ids (`session-8b68`); match on the shared prefix."""
    return any(session.startswith(other) or other.startswith(session) for other in exclude)


def busy_sessions(exclude: set[str]) -> tuple[set[str], str]:
    """Sessions whose last turn event is a start, or an explanation of why unknown."""
    try:
        with open(PROBE_PATH, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 2_000_000))
            tail = handle.read().decode('utf-8', 'replace')
    except OSError as error:
        return set(), f'trace log unavailable ({error})'
    last: dict[str, tuple[str, float]] = {}
    for line in tail.splitlines():
        match = TURN_LINE.match(line)
        if not match:
            continue
        stamp, kind, session = match.groups()
        try:
            # Trace timestamps are UTC (`...Z`); timegm keeps them absolute
            # instead of shifting by the local offset.
            at = calendar.timegm(time.strptime(stamp[:19], '%Y-%m-%dT%H:%M:%S'))
        except ValueError:
            continue
        last[session] = (kind, at)
    if not last:
        return set(), 'no turn events in the trace log'
    now = time.time()
    running = {
        session
        for session, (kind, at) in last.items()
        if kind == 'turn/start' and not is_excluded(session, exclude) and now - at < FRESH_SECONDS
    }
    return running, ''


def read_feishu_state() -> dict | None:
    try:
        state = json.load(open(STATE_PATH, encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not state.get('appId') or not state.get('appSecret'):
        return None
    chat = state.get('homeChatId')
    if not chat:
        chats = list((state.get('chatSessions') or {}).keys())
        chat = chats[0] if chats else None
    if not chat:
        return None
    state['__chat'] = chat
    return state


def notify_feishu(text: str) -> str:
    """Send a plain-text message to the chat that owns this deployment."""
    state = read_feishu_state()
    if not state:
        return 'skipped: no Feishu credentials/chat on record'
    base = 'https://open.larkoffice.com' if state.get('domain') == 'lark' else 'https://open.feishu.cn'
    try:
        body = json.dumps({'app_id': state['appId'], 'app_secret': state['appSecret']}).encode()
        request = urllib.request.Request(
            f'{base}/open-apis/auth/v3/tenant_access_token/internal',
            data=body,
            headers={'Content-Type': 'application/json; charset=utf-8'},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            token = json.loads(response.read().decode()).get('tenant_access_token')
        if not token:
            return 'failed: no tenant token'
        payload = json.dumps(
            {'receive_id': state['__chat'], 'msg_type': 'text', 'content': json.dumps({'text': text})}
        ).encode()
        request = urllib.request.Request(
            f'{base}/open-apis/im/v1/messages?receive_id_type=chat_id',
            data=payload,
            headers={'Content-Type': 'application/json; charset=utf-8', 'Authorization': f'Bearer {token}'},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read().decode())
        return 'sent' if result.get('code') == 0 else f"failed: code={result.get('code')} {result.get('msg')}"
    except (urllib.error.URLError, OSError, ValueError) as error:
        return f'failed: {error}'


def plugin_version() -> str:
    try:
        path = os.path.expanduser('~/.dsh/profiles/web/node_modules/dsh-plugin-feishu-im/package.json')
        return json.load(open(path, encoding='utf-8')).get('version', '?')
    except (OSError, ValueError):
        return '?'


def wait_gone(pid: int, seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.2)
    return False


def listener_up() -> bool:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/', timeout=2) as response:
            return response.status in (200, 401, 403)
    except urllib.error.HTTPError as error:
        return error.code in (200, 401, 403)
    except (urllib.error.URLError, OSError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description='Restart the DSH web host in place.')
    parser.add_argument('--pid', type=int, default=None, help='host pid; omitted = detect')
    parser.add_argument('--delay', type=float, default=30.0, help='seconds before killing (default 30)')
    parser.add_argument('--exclude-session', action='append', default=[], help='session ids allowed to be mid-turn')
    parser.add_argument('--dry-run', action='store_true', help='print the plan and exit')
    parser.add_argument('--check', action='store_true', help='report busy state and exit')
    parser.add_argument('--no-notify', action='store_true', help='skip the Feishu messages')
    parser.add_argument('--self-test', action='store_true', help='daemonize, log, exit without killing anything')
    args = parser.parse_args()

    pid = args.pid
    if pid is None:
        pids = find_host_pids()
        if len(pids) != 1:
            print(f'expected exactly one dsh host, found {pids}; pass --pid', file=sys.stderr)
            return 2
        pid = pids[0]

    try:
        argv, cwd, env = proc_facts(pid)
    except OSError as error:
        print(f'cannot read pid {pid}: {error}', file=sys.stderr)
        return 2

    exclude = set(args.exclude_session) | ({os.environ['DSH_SESSION_ID']} if os.environ.get('DSH_SESSION_ID') else set())
    running, unknown = busy_sessions(exclude)

    print(f'host pid={pid}\n  cwd={cwd}\n  argv={" ".join(argv)}', flush=True)
    print(f'  excluded sessions={sorted(exclude) or "<none>"}', flush=True)
    print(f'  busy sessions={sorted(running) or "<none>"} {unknown}', flush=True)
    if args.check:
        return 3 if (running or unknown) else 0
    if args.dry_run:
        return 0
    if running or unknown:
        reason = f'会话 {", ".join(sorted(running))} 正在跑任务' if running else unknown
        log(f'restart: refused — {reason}')
        if not args.no_notify:
            log('restart: feishu notify ' + notify_feishu(f'⏸ 没有重启 DSH：{reason}。等这一轮跑完再执行重启。'))
        return 3

    if args.self_test:
        daemonize()
        log(f'self-test: daemonized ppid={os.getppid()} sid={os.getsid(0)} pid={os.getpid()}')
        time.sleep(3)
        log('self-test: still alive after 3s')
        return 0

    daemonize()
    log(f'restart: pid={pid} argv={argv} cwd={cwd} delay={args.delay}s')

    # The re-check happens at kill time: a long delay may have let a turn start.
    time.sleep(max(0.0, args.delay))
    running, unknown = busy_sessions(exclude)
    if running or unknown:
        reason = f'会话 {", ".join(sorted(running))} 正在跑任务' if running else unknown
        log(f'restart: refused after delay — {reason}')
        if not args.no_notify:
            log('restart: feishu notify ' + notify_feishu(f'⏸ 没有重启 DSH：{reason}。等这一轮跑完再执行重启。'))
        return 3

    if not args.no_notify:
        log('restart: feishu notify ' + notify_feishu('🔁 DSH 即将重启，页面会短暂断连；重启完成后我会再发一条消息，刷新页面即可继续。'))

    log(f'restart: SIGTERM {pid}')
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        log('restart: host already gone; starting a new one')
    if not wait_gone(pid, 15.0):
        log(f'restart: SIGKILL {pid}')
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        wait_gone(pid, 5.0)

    time.sleep(1.5)
    os.chdir(cwd)
    try:
        with open(LOG_PATH, 'ab', buffering=0) as sink:
            child = subprocess.Popen(
                argv,
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=sink,
                stderr=sink,
                start_new_session=True,
                close_fds=True,
            )
        log(f'restart: started pid={child.pid}')
    except OSError as error:
        log(f'restart: FAILED to start the host: {error}')
        if not args.no_notify:
            notify_feishu(f'❌ DSH 重启失败（无法启动进程：{error}），需要你手动启动。')
        return 1

    for _ in range(90):
        time.sleep(1.0)
        if listener_up():
            version = plugin_version()
            log(f'restart: listener is back on {PORT} (plugin v{version})')
            if not args.no_notify:
                log('restart: feishu notify ' + notify_feishu(
                    f'✅ DSH 已重启完成（插件 v{version}），刷新页面即可继续。'
                ))
            return 0
    log(f'restart: WARNING no listener on {PORT} after 90s')
    if not args.no_notify:
        notify_feishu(f'⚠️ DSH 重启后 {PORT} 端口 90 秒内没有起来，请检查 {LOG_PATH}。')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
