// dsh-plugin-feishu-im — client half.
//
// Registers one page in the shell's `settings.section` list: the 「飞书 IM」 tab.
// The page talks to its own Host half through the authenticated exact Fetch
// routes the Host registers below `/api`; the browser cookie is the credential,
// so this file never sees the App Secret.
//
// Loaded as a classic script and registered on the DSH client module loader.
(function () {
  'use strict';

  var PLUGIN_ID = 'dsh-plugin-feishu-im';
  var API = '/api/feishu-im';
  // Bumped on every installed build: the page prints it, so a stale artifact is
  // visible instead of being mistaken for a code bug.
  var BUILD = '1.9.2';

  var CSS = [
    '.fsim-page{display:flex;flex-direction:column;gap:20px;max-width:760px;color:var(--dsw-alias-label-primary,#1a1a1a);}',
    '.fsim-head{display:flex;flex-direction:column;gap:6px;}',
    '.fsim-title{font-size:20px;font-weight:600;line-height:1.3;margin:0;}',
    '.fsim-sub{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0;}',
    '.fsim-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
    '.fsim-card-head{padding:14px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:10px;}',
    '.fsim-card-title{font-size:14px;font-weight:600;margin:0;}',
    '.fsim-card-body{padding:16px;display:flex;flex-direction:column;gap:14px;}',
    '.fsim-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}',
    '.fsim-row-text{display:flex;flex-direction:column;gap:3px;min-width:0;}',
    '.fsim-label{font-size:13px;font-weight:500;}',
    '.fsim-hint{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);}',
    '.fsim-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
    '.fsim-value{font-size:13px;}',
    '.fsim-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:6px;}',
    '.fsim-dot-on{background:var(--dsw-alias-state-success-primary);}',
    '.fsim-dot-off{background:var(--dsw-alias-state-idle-primary);}',
    '.fsim-btn{appearance:none;-webkit-appearance:none;height:32px;padding:0 14px;border-radius:8px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border:1px solid transparent;white-space:nowrap;transition:opacity .12s ease;display:inline-flex;align-items:center;justify-content:center;}',
    '.fsim-btn:disabled{opacity:.5;cursor:default;}',
    '.fsim-btn-primary{background:var(--dsw-alias-brand-primary,#2f7cf6);color:var(--dsw-alias-bg-base,#fff);-webkit-text-fill-color:var(--dsw-alias-bg-base,#fff);}',
    '.fsim-btn-ghost{background:var(--dsw-alias-bg-layer-2,#f2f3f5);border-color:var(--dsw-alias-border-l2,#d0d3d9);color:var(--dsw-alias-label-primary,#1a1a1a);-webkit-text-fill-color:currentColor;}',
    '.fsim-btn-danger{background:transparent;border-color:var(--dsw-alias-border-l2,#d0d3d9);color:var(--dsw-alias-state-error-primary,#d92d20);-webkit-text-fill-color:currentColor;}',
    '.fsim-actions{display:flex;gap:8px;flex-wrap:wrap;}',
    '.fsim-input{height:34px;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;padding:0 10px;outline:none;}',
    '.fsim-input:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.fsim-textarea{width:100%;box-sizing:border-box;min-height:64px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;padding:8px 10px;outline:none;resize:vertical;font-family:inherit;}',
    '.fsim-field{display:flex;flex-direction:column;gap:6px;}',
    '.fsim-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}',
    '.fsim-switch{position:relative;width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#2a2a2a);cursor:pointer;flex:none;transition:background .15s ease;}',
    '.fsim-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#2f7cf6);border-color:var(--dsw-alias-brand-primary,#2f7cf6);}',
    '.fsim-switch::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:transform .15s ease;}',
    '.fsim-switch[aria-checked="true"]::after{transform:translateX(18px);}',
    '.fsim-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);}',
    '.fsim-ok{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);}',
    '.fsim-qr-wrap{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;}',
    '.fsim-qr{width:200px;height:200px;border-radius:12px;background:#fff;padding:8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);}',
    '.fsim-qr-side{display:flex;flex-direction:column;gap:8px;min-width:220px;flex:1;}',
    '.fsim-wait{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary);}',
    '.fsim-pulse{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:fsim-pulse 1.2s ease-in-out infinite;}',
    '@keyframes fsim-pulse{0%,100%{opacity:.25}50%{opacity:1}}',
    '.fsim-divider{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;}',
    '.fsim-divider::before,.fsim-divider::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1);}',
    '.fsim-list{display:flex;flex-direction:column;}',
    '.fsim-list-item{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.fsim-list-item:last-child{border-bottom:none;}',
    '.fsim-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px;color:var(--dsw-alias-label-secondary);}',
    '.fsim-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.fsim-inline .fsim-input{width:96px;flex:none;}',
    '.fsim-warn{border:1px solid var(--dsw-alias-state-warn-primary,#b54708);border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.55;color:var(--dsw-alias-state-warn-primary,#b54708);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 8%,transparent);}',
  ].join('');

  async function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    var response = await fetch(API + path, init);
    var text = await response.text();
    var data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (error) { throw new Error('服务返回了无法解析的响应（HTTP ' + response.status + '）'); }
    }
    if (!response.ok) {
      var failure = new Error(data.error || ('请求失败（HTTP ' + response.status + '）'));
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  function errorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  function formatRemaining(expiresAt) {
    var left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    var minutes = Math.floor(left / 60);
    var seconds = left % 60;
    return minutes + ':' + (seconds < 10 ? '0' + seconds : String(seconds));
  }

  function createComponents(React, t) {
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    /**
     * Renders the message instead of letting a throw blank the settings panel.
     * The stack is shown too: this page is the only surface the operator has.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[feishu-im] render crashed:', error, info);
        }
      }
      render() {
        if (this.state.error) {
          var error = this.state.error;
          return h('div', { className: 'fsim-page' },
            h('div', { className: 'fsim-error' },
              '飞书 IM 页面渲染失败：', String((error && error.message) || error),
              h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px', margin: '8px 0 0' } },
                String((error && error.stack) || '').slice(0, 1500))));
        }
        return this.props.children;
      }
    }

    function Button(props) {
      var variant = props.variant || 'ghost';
      return h('button', {
        type: 'button',
        className: 'fsim-btn fsim-btn-' + variant,
        disabled: props.disabled,
        onClick: props.onClick,
      }, props.children);
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: 'fsim-switch',
        onClick: function () { if (!props.disabled) props.onChange(!props.checked); },
      });
    }

    function Row(props) {
      return h('div', { className: 'fsim-row' },
        h('div', { className: 'fsim-row-text' },
          h('div', { className: 'fsim-label' }, props.label),
          props.hint ? h('div', { className: 'fsim-hint' }, props.hint) : null),
        props.children);
    }

    function Card(props) {
      return h('section', { className: 'fsim-card' },
        props.title ? h('header', { className: 'fsim-card-head' },
          props.dot ? h('span', { className: 'fsim-dot ' + (props.dot === 'on' ? 'fsim-dot-on' : 'fsim-dot-off') }) : null,
          h('h3', { className: 'fsim-card-title' }, props.title),
          props.extra || null) : null,
        h('div', { className: 'fsim-card-body' }, props.children));
    }

    function Field(props) {
      return h('label', { className: 'fsim-field' },
        h('span', { className: 'fsim-field-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'fsim-hint' }, props.hint) : null);
    }

    /** 扫码创建：设备码流程 + 轮询。 */
    function ScanCard(props) {
      var qrState = useState(null);
      var qr = qrState[0];
      var setQr = qrState[1];
      var statusState = useState('idle');
      var status = statusState[0];
      var setStatus = statusState[1];
      var messageState = useState('');
      var message = messageState[0];
      var setMessage = messageState[1];
      var tickState = useState(0);
      var tick = tickState[0];
      var setTick = tickState[1];
      var alive = useRef(true);

      useEffect(function () {
        alive.current = true;
        return function () { alive.current = false; };
      }, []);

      var begin = useCallback(function () {
        setStatus('loading');
        setMessage('');
        api('/onboarding/begin', { method: 'POST', body: { domain: props.domain || 'feishu' } })
          .then(function (result) {
            if (!alive.current) return;
            setQr(result);
            setStatus('waiting');
          })
          .catch(function (error) {
            if (!alive.current) return;
            setStatus('idle');
            setMessage(errorMessage(error));
          });
      }, [props.domain]);

      // 轮询：设备码授权完成后，Host 已经把凭据写入状态文件。
      useEffect(function () {
        if (status !== 'waiting' || !qr) return undefined;
        var timer = setInterval(function () {
          api('/onboarding/poll?id=' + encodeURIComponent(qr.id))
            .then(function (result) {
              if (!alive.current) return;
              if (result.status === 'ready') {
                setStatus('ready');
                props.onConnected(result.state);
              } else if (result.status === 'expired') {
                setStatus('expired');
                setMessage('二维码已过期，请重新生成。');
              } else if (result.status === 'denied') {
                setStatus('idle');
                setMessage('授权被拒绝，可以重新生成二维码再试一次。');
              } else if (result.status === 'unknown') {
                setStatus('idle');
                setMessage('这次连接请求已失效，请重新生成二维码。');
              }
            })
            .catch(function (error) {
              if (!alive.current) return;
              setStatus('idle');
              setMessage(errorMessage(error));
            });
        }, 2500);
        return function () { clearInterval(timer); };
      }, [status, qr]);

      // 倒计时只影响显示。
      useEffect(function () {
        if (status !== 'waiting' || !qr) return undefined;
        var timer = setInterval(function () { setTick(function (value) { return value + 1; }); }, 1000);
        return function () { clearInterval(timer); };
      }, [status, qr]);

      function cancel() {
        var current = qr;
        setQr(null);
        setStatus('idle');
        if (current) api('/onboarding/cancel', { method: 'POST', body: { id: current.id } }).catch(function () {});
      }

      if (status === 'idle' || status === 'loading') {
        return h(Card, { title: '扫码创建飞书应用' },
          h('p', { className: 'fsim-sub' },
            '用飞书扫一下，自动创建一个只属于 DSH 的机器人应用，并带上收发消息所需的权限。'),
          h('div', { className: 'fsim-actions' },
            h(Button, { variant: 'primary', disabled: status === 'loading', onClick: begin },
              status === 'loading' ? '正在生成二维码…' : '生成连接二维码')),
          message ? h('div', { className: 'fsim-error' }, message) : null);
      }

      if (!qr) return null;

      return h(Card, { title: '扫码创建飞书应用' },
        h('div', { className: 'fsim-qr-wrap' },
          qr.qrDataUrl
            ? h('img', { className: 'fsim-qr', src: qr.qrDataUrl, alt: '飞书扫码创建应用' })
            : h('div', { className: 'fsim-qr fsim-hint', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '16px' } },
                '二维码组件未安装，请直接点开下面的链接。'),
          h('div', { className: 'fsim-qr-side' },
            h('div', { className: 'fsim-wait' },
              h('span', { className: 'fsim-pulse' }),
              h('span', null, '等待在飞书中确认…（' + formatRemaining(qr.expiresAt) + ' 后过期）')),
            h('div', { className: 'fsim-hint' },
              '手机上打开飞书扫左边二维码，按提示确认创建即可。这个页面会自动完成后续配置。'),
            qr.userCode ? h('div', { className: 'fsim-hint' }, '配对码：', h('span', { className: 'fsim-code' }, qr.userCode)) : null,
            qr.qrUrl ? h('a', { className: 'fsim-hint', href: qr.qrUrl, target: '_blank', rel: 'noreferrer' }, '点不开二维码时，用飞书打开这个链接') : null,
            h('div', { className: 'fsim-actions' },
              h(Button, { onClick: cancel }, '取消'),
              h(Button, { onClick: begin }, '重新生成'))),
        ),
        message ? h('div', { className: 'fsim-error' }, message) : null);
    }

    /** 手动填写凭据。 */
    function ManualCard(props) {
      var appIdState = useState('');
      var appId = appIdState[0];
      var setAppId = appIdState[1];
      var secretState = useState('');
      var secret = secretState[0];
      var setSecret = secretState[1];
      var domainState = useState('feishu');
      var domain = domainState[0];
      var setDomain = domainState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var messageState = useState('');
      var message = messageState[0];
      var setMessage = messageState[1];

      function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setBusy(true);
        setMessage('');
        api('/credentials', { method: 'POST', body: { appId: appId, appSecret: secret, domain: domain } })
          .then(function (result) { props.onConnected(result.state); })
          .catch(function (error) { setMessage(errorMessage(error)); })
          .then(function () { setBusy(false); });
      }

      return h(Card, { title: '已有飞书应用？手动连接' },
        h('p', { className: 'fsim-sub' },
          '在飞书开放平台创建应用并开启机器人能力，把 App ID / App Secret 填在这里。权限与事件订阅需要自行配置，扫码创建会替你完成这些。'),
        h(Field, { label: 'App ID' },
          h('input', {
            className: 'fsim-input', value: appId, placeholder: 'cli_xxxxxxxxxxxxxxxx',
            onChange: function (event) { setAppId(event.target.value); },
          })),
        h(Field, { label: 'App Secret' },
          h('input', {
            className: 'fsim-input', type: 'password', value: secret, placeholder: '••••••••',
            onChange: function (event) { setSecret(event.target.value); },
          })),
        h(Field, { label: '开放平台域' },
          h('select', {
            className: 'fsim-input', value: domain,
            onChange: function (event) { setDomain(event.target.value); },
          },
            h('option', { value: 'feishu' }, '飞书（feishu.cn）'),
            h('option', { value: 'lark' }, 'Lark（larksuite.com）'))),
        h('div', { className: 'fsim-actions' },
          h(Button, { variant: 'primary', disabled: busy || !appId || !secret, onClick: submit },
            busy ? '正在校验…' : '连接')),
        message ? h('div', { className: 'fsim-error' }, message) : null);
    }

    /** 已连接视图。 */
    function ConnectedView(props) {
      var state = props.state;
      var setState = props.setState;
      var busyState = useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var noticeState = useState('');
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var allowDraftState = useState((state.allowedOpenIds || []).join('\n'));
      var allowDraft = allowDraftState[0];
      var setAllowDraft = allowDraftState[1];
      var cwdDraftState = useState(state.sessionCwd || '~/dsh-plugin-feishu-im');
      var cwdDraft = cwdDraftState[0];
      var setCwdDraft = cwdDraftState[1];
      var wsTitleDraftState = useState(state.workspaceTitle || '飞书IM');
      var wsTitleDraft = wsTitleDraftState[0];
      var setWsTitleDraft = wsTitleDraftState[1];
      var timeoutDraftState = useState(String(state.answerTimeoutMinutes || 5));
      var timeoutDraft = timeoutDraftState[0];
      var setTimeoutDraft = timeoutDraftState[1];
      var never = state.answerTimeoutMinutes === 0;

      useEffect(function () {
        setAllowDraft((state.allowedOpenIds || []).join('\n'));
      }, [state.allowedOpenIds.join('|')]);

      useEffect(function () {
        setTimeoutDraft(String(state.answerTimeoutMinutes || 5));
      }, [state.answerTimeoutMinutes]);

      useEffect(function () {
        setCwdDraft(state.sessionCwd || '~/dsh-plugin-feishu-im');
      }, [state.sessionCwd]);

      useEffect(function () {
        setWsTitleDraft(state.workspaceTitle || '飞书IM');
      }, [state.workspaceTitle]);

      function run(key, task, success) {
        setBusy(key);
        setError('');
        setNotice('');
        task()
          .then(function (result) {
            if (result && result.state) setState(result.state);
            if (success) setNotice(success);
          })
          .catch(function (failure) { setError(errorMessage(failure)); })
          .then(function () { setBusy(''); });
      }

      function savePrefs(patch) {
        var previous = state;
        setState(function (current) {
          var merged = {};
          for (var key in current) merged[key] = current[key];
          for (var field in patch) merged[field] = patch[field];
          return merged;
        });
        api('/prefs', { method: 'POST', body: patch })
          .then(function (result) { setState(result.state); })
          .catch(function (failure) { setState(previous); setError(errorMessage(failure)); });
      }

      function toggleNotify(key) {
        var next = {};
        for (var name in state.notify) next[name] = state.notify[name];
        next[key] = !state.notify[key];
        savePrefs({ notify: next });
      }

      return h(React.Fragment, null,
        h(Card, { title: '连接状态', dot: 'on', extra: h('span', { className: 'fsim-hint' }, state.botName || state.appId) },
          h('div', { className: 'fsim-list' },
            h('div', { className: 'fsim-list-item' },
              h('div', { className: 'fsim-row-text' },
                h('div', { className: 'fsim-label' }, '机器人'),
                h('div', { className: 'fsim-hint' }, state.botName || '（未获取到机器人名称，可点“重新校验”）')),
              null),
            h('div', { className: 'fsim-list-item' },
              h('div', { className: 'fsim-row-text' },
                h('div', { className: 'fsim-label' }, 'App ID'),
                h('div', { className: 'fsim-mono' }, state.appId)),
              h('span', { className: 'fsim-hint' }, state.domain === 'lark' ? 'Lark' : '飞书')),
            h('div', { className: 'fsim-list-item' },
              h('div', { className: 'fsim-row-text' },
                h('div', { className: 'fsim-label' }, '我的飞书 open_id'),
                h('div', { className: 'fsim-mono' }, state.ownerOpenId || '（扫码授权后自动填写）')))),
          h('div', { className: 'fsim-actions' },
            h(Button, { variant: 'primary', disabled: busy !== '', onClick: function () {
              run('test', function () { return api('/test', { method: 'POST', body: {} }); }, '测试消息已发出，去飞书里看一下。');
            } }, busy === 'test' ? '正在发送…' : '发送测试消息'),
            h(Button, { disabled: busy !== '', onClick: function () {
              run('verify', function () { return api('/verify', { method: 'POST', body: {} }); }, '凭据有效。');
            } }, busy === 'verify' ? '校验中…' : '重新校验'),
            h(Button, { variant: 'danger', disabled: busy !== '', onClick: function () {
              if (typeof window !== 'undefined' && !window.confirm('断开后 DSH 不再向飞书推送消息，凭据会从本机删除。继续？')) return;
              run('disconnect', function () { return api('/disconnect', { method: 'POST', body: {} }); });
            } }, '断开连接')),
          error ? h('div', { className: 'fsim-error' }, error) : null,
          notice ? h('div', { className: 'fsim-ok' }, notice) : null),

        h(Card, { title: '推送内容' },
          h('p', { className: 'fsim-sub' }, '所有会话都会推送。'),
          h(Row, { label: '任务完成', hint: '一轮对话结束后，把结论和用时推过来。' },
            h(Switch, { label: '任务完成通知', checked: state.notify.turnEnd, onChange: function () { toggleNotify('turnEnd'); } })),
          h(Row, { label: '需要授权', hint: '工具要执行受限操作时，推一张带“允许 / 拒绝”按钮的卡片。' },
            h(Switch, { label: '授权通知', checked: state.notify.approval, onChange: function () { toggleNotify('approval'); } })),
          h(Row, { label: '需要你回答', hint: 'DSH 向你提问时，问题会变成可选按钮。' },
            h(Switch, { label: '提问通知', checked: state.notify.question, onChange: function () { toggleNotify('question'); } }))),

        h(Card, { title: '飞书会话的位置' },
          h('p', { className: 'fsim-sub' },
            '在飞书里发起的对话会新建在下面这个文件夹，并在工作区列表里归到同一个名字下。'),
          h(Field, {
            label: '工作文件夹',
            hint: '绝对路径或以 ~/ 开头；不存在会自动创建。默认 ~/dsh-plugin-feishu-im。',
          },
            h('input', {
              className: 'fsim-input',
              value: cwdDraft,
              placeholder: '~/dsh-plugin-feishu-im',
              onChange: function (event) { setCwdDraft(event.target.value); },
              onBlur: function () {
                if (cwdDraft !== state.sessionCwd) savePrefs({ sessionCwd: cwdDraft });
              },
            })),
          h(Field, {
            label: '工作区名称',
            hint: '工作区里显示的分组名，默认「飞书IM」。改名会在下一次新建对话时同步。',
          },
            h('input', {
              className: 'fsim-input',
              value: wsTitleDraft,
              placeholder: '飞书IM',
              onChange: function (event) { setWsTitleDraft(event.target.value); },
              onBlur: function () {
                if (wsTitleDraft !== state.workspaceTitle) savePrefs({ workspaceTitle: wsTitleDraft });
              },
            }))),

        h(Card, { title: '指挥与安全' },
          h(Row, { label: '允许在飞书里指挥 DSH', hint: '关闭后，飞书只用来接收通知，收到的消息不会变成对话。' },
            h(Switch, {
              label: '允许指挥', checked: state.allowCommands,
              onChange: function () { savePrefs({ allowCommands: !state.allowCommands }); },
            })),
          h(Row, {
            label: '网页与飞书同时询问',
            hint: state.answerMode === 'both'
              ? '现在两边都会弹出：谁先回答就用谁，另一边可能在本轮结束前一直显示。'
              : '默认只通过飞书询问：网页不会再弹同一个请求，所以在飞书答完就是最终结果。',
          },
            h(Switch, {
              label: '网页与飞书同时询问',
              checked: state.answerMode === 'both',
              onChange: function () { savePrefs({ answerMode: state.answerMode === 'both' ? 'feishu' : 'both' }); },
            })),
          h(Field, {
            label: '飞书等待上限（分钟）',
            hint: '1–120 分钟，或选择永不超时。超时后卡片失效，请求转回 DSH 网页。',
          },
            h('div', { className: 'fsim-inline' },
              h('input', {
                className: 'fsim-input',
                type: 'number',
                min: 1,
                max: 120,
                step: 1,
                value: never ? '0' : timeoutDraft,
                disabled: never,
                onChange: function (event) { setTimeoutDraft(event.target.value); },
                onBlur: function () {
                  if (never) return;
                  var minutes = Math.round(Number(timeoutDraft));
                  if (!isFinite(minutes) || minutes < 1 || minutes > 120) {
                    setTimeoutDraft(String(state.answerTimeoutMinutes || 5));
                    return;
                  }
                  if (minutes !== state.answerTimeoutMinutes) savePrefs({ answerTimeoutMinutes: minutes });
                },
              }),
              h('span', { className: 'fsim-hint' }, never ? '永不超时' : '分钟'),
              h(Switch, {
                label: '永不超时',
                checked: never,
                onChange: function () {
                  savePrefs({ answerTimeoutMinutes: never ? 5 : 0 });
                },
              }),
              h('span', { className: 'fsim-hint' }, '永不超时'))),
          h('div', { className: 'fsim-warn' },
            '注意：超时之前，DSH 网页不会弹出原生的选择窗口——这条请求只在飞书里等你。',
            never
              ? '当前设为永不超时，网页端会一直保持静默，直到你在飞书作答。'
              : '超过等待上限才会转回网页；期间即使网页开着也不会提示。'),
          h(Field, {
            label: '允许的飞书用户（open_id，每行一个）',
            hint: '留空表示沿用扫码授权的人。只接受列表里的用户发来的消息。',
          },
            h('textarea', {
              className: 'fsim-textarea', value: allowDraft,
              onChange: function (event) { setAllowDraft(event.target.value); },
              placeholder: 'ou_xxxxxxxxxxxxxxxx',
            })),
          h('div', { className: 'fsim-actions' },
            h(Button, { disabled: busy !== '', onClick: function () {
              run('allow', function () {
                return api('/prefs', { method: 'POST', body: { allowedOpenIds: allowDraft.split(/[\s,;]+/).filter(Boolean) } });
              }, '允许列表已保存。');
            } }, busy === 'allow' ? '保存中…' : '保存允许列表')),
          h('p', { className: 'fsim-hint' }, '状态文件：', h('span', { className: 'fsim-mono' }, state.stateFile))));
    }

    /** Slot entry: the boundary sits outside the page so a render throw is visible. */
    function Page() {
      return h(Boundary, null, h(FeishuImSection));
    }

    function FeishuImSection() {
      var stateRes = useState(null);
      var state = stateRes[0];
      var setState = stateRes[1];
      var loadingRes = useState(true);
      var loading = loadingRes[0];
      var setLoading = loadingRes[1];
      var errorRes = useState('');
      var error = errorRes[0];
      var setError = errorRes[1];
      var probeRes = useState('');
      var probe = probeRes[0];
      var setProbe = probeRes[1];

      var load = useCallback(function () {
        setLoading(true);
        api('/state')
          .then(function (result) {
            setState(result.state);
            setError('');
            setProbe('ok');
          })
          .catch(function (failure) {
            setError(errorMessage(failure));
            setProbe(failure && failure.status ? ('HTTP ' + failure.status) : 'network');
          })
          .then(function () { setLoading(false); });
      }, []);

      useEffect(function () { load(); }, [load]);

      var body;
      if (loading && !state) {
        body = h('p', { className: 'fsim-sub' }, '正在读取连接状态…');
      } else if (!state) {
        body = h('div', { className: 'fsim-error' },
          (error || '读取连接状态失败。') + ' ',
          h(Button, { onClick: load }, '重试'));
      } else if (!state.configured) {
        body = h(React.Fragment, null,
          h(ScanCard, { onConnected: function (next) { setState(next); setError(''); } }),
          h('div', { className: 'fsim-divider' }, '或'),
          h(ManualCard, { onConnected: function (next) { setState(next); setError(''); } }),
          error ? h('div', { className: 'fsim-error' }, error) : null);
      } else {
        body = h(ConnectedView, { state: state, setState: setState });
      }

      return h('div', { className: 'fsim-page' },
        h('header', { className: 'fsim-head' },
          h('h2', { className: 'fsim-title' }, t('title')),
          h('p', { className: 'fsim-sub' },
            '把 DSH 的工作进展推送到飞书，也可以在飞书里直接下达指令。所有消息都经过 DSH 处理后再回复。')),
        body,
        h('p', { className: 'fsim-hint', style: { opacity: 0.7 } },
          'dsh-plugin-feishu-im v' + BUILD + ' · /api/feishu-im/state: ' + (probe || '…')));
    }

    // Exposed for the render tests (scripts/render-ssr.mjs); the shell only
    // renders Page.
    return {
      FeishuImSection: FeishuImSection,
      Page: Page,
      Boundary: Boundary,
      ScanCard: ScanCard,
      ManualCard: ManualCard,
      ConnectedView: ConnectedView,
    };
  }

  function createPlugin(require, ctx) {
    var React = require('react');
    var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
    var language = 'zh';
    try {
      var current = locale && typeof locale.current === 'function' ? locale.current() : undefined;
      var value = current && typeof current === 'object' ? current.locale || current.language || current.id : current;
      if (typeof value === 'string' && value.toLowerCase().indexOf('zh') !== 0) language = 'en';
    } catch (error) { /* keep Chinese */ }

    var dictionary = {
      zh: { title: '飞书 IM', nav: '飞书 IM', description: '通过飞书接收 DSH 的任务进展、审批请求，并在飞书中指挥 DSH。' },
      en: { title: 'Feishu IM', nav: 'Feishu IM', description: 'Receive DSH progress and approval requests in Feishu, and drive DSH from chat.' },
    };
    var t = function (key) { return (dictionary[language] || dictionary.zh)[key]; };

    var components = createComponents(React, t);

    return {
      components: components,
      inject: ['slots'],
      apply: function (app) {
        app.effect(function () {
          var style = document.createElement('style');
          style.setAttribute('data-plugin', PLUGIN_ID);
          style.textContent = CSS;
          document.head.appendChild(style);
          return function () {
            if (style.parentNode) style.parentNode.removeChild(style);
          };
        }, 'feishu-im: stylesheet');

        app.slots.inject('settings.section', function () {
          return app.slots.register({
            name: 'settings.section',
            id: 'feishu-im',
            order: 18,
            label: function () { return t('nav'); },
          }, components.Page);
        });
      },
    };
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__FEISHU_IM_INTERNALS__ = { createPlugin: createPlugin, createComponents: createComponents, BUILD: BUILD };
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        // The factory itself stays free of side effects: the component tree is
        // built lazily and the slot is registered inside apply().
        var holder = {};
        var plugin = {
          inject: ['slots'],
          apply: function (ctx) {
            var built = createPlugin(require, ctx);
            holder.plugin = built;
            return built.apply(ctx);
          },
        };
        return plugin;
      },
    });
  }
})();
