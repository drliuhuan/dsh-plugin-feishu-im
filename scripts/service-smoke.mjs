// The service module only writes a user unit and talks to `systemctl --user`;
// this test pins the generated text and the quoting without touching systemd.
import assert from 'node:assert/strict'

const { renderUnit, execStartLine, UNIT_PATH } = await import('../lib/service.js')

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

console.log('service smoke: all cases passed')
