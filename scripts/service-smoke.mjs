// The service module only writes a user unit and talks to `systemctl --user`;
// this test pins the generated text and the quoting without touching systemd.
import assert from 'node:assert/strict'

const { renderUnit, renderPlist, execStartLine, platformInfo, UNIT_PATH, LAUNCHD_PATH } = await import('../lib/service.js')

const unit = renderUnit({
  argv: ['/usr/bin/node', '/home/me/.local/bin/dsh', 'web', '--port', '3080', '--trusted-host', '192.168.0.66'],
  execPath: '/usr/bin/node',
  cwd: '/home/me',
})

assert.match(unit, /^\[Unit\]\nDescription=/m, 'unit has a [Unit] section')
assert.match(unit, /^WorkingDirectory=\/home\/me$/m, 'working directory is the host cwd')
assert.match(unit, /^ExecStart=\/usr\/bin\/node \/home\/me\/\.local\/bin\/dsh web --port 3080 --trusted-host 192\.168\.0\.66$/m,
  'ExecStart replays the running command line')
assert.match(unit, /^Restart=always$/m, 'Restart=always is what makes the unit self-healing')
assert.match(unit, /^WantedBy=default\.target$/m, 'user units install into default.target, not multi-user.target')
assert.equal(UNIT_PATH.endsWith('/.config/systemd/user/dsh.service'), true)

// Arguments with spaces must stay one argument for systemd.
assert.equal(
  execStartLine(['/usr/bin/node', '/opt/my app/dsh', 'web', '--title', 'a "b"'], '/usr/bin/node'),
  '/usr/bin/node "/opt/my app/dsh" web --title "a \\"b\\""',
)

// No sudo, no system paths — the whole point of the rootless option.
assert.equal(/sudo|pkexec|\/etc\/systemd/.test(unit), false)

// Platform gating: only backends that can run without root are offered.
assert.equal(platformInfo('linux').supported, true)
assert.equal(platformInfo('linux').kind, 'systemd')
assert.equal(platformInfo('darwin').supported, true)
assert.equal(platformInfo('darwin').kind, 'launchd')
assert.equal(platformInfo('win32').supported, false)
assert.match(platformInfo('win32').reason, /仅支持 Linux/)

// launchd agent: KeepAlive is the macOS equivalent of Restart=always.
const plist = renderPlist({ argv: ['/usr/local/bin/node', '/usr/local/bin/dsh', 'web'], execPath: '/usr/local/bin/node', cwd: '/Users/me' })
assert.match(plist, /<string>com\.dsh\.web<\/string>/, 'label is stable: it is how the agent is booted out')
assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/, 'KeepAlive restarts the agent')
assert.match(plist, /<string>\/Users\/me<\/string>/, 'WorkingDirectory is the host cwd')
assert.equal(LAUNCHD_PATH.endsWith('/Library/LaunchAgents/com.dsh.web.plist'), true)

console.log('service smoke: all cases passed')
