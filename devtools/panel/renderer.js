// DEV panel UI, injected into each Screen Studio window by panel/main.js. It
// runs in the window's own main world (the app's code lives in the hidden host
// window) and reaches the main process only through the long poll at the
// bottom: panel/main.js awaits takeRequests() and answers with settle().
// The UI lives in an iframe so the app's styles don't leak in and keystrokes
// typed into the panel never reach the app's keyboard shortcuts.
(() => {
  if (window.__ssDevtoolsPanel) return;

  const PANEL_WIDTH = 340;
  const TAB_WIDTH = 22;
  const REFRESH_MS = 1000;
  // Windows smaller than this (toolbars, widgets) only get the panel through
  // the Developer menu, as do windows other than the focused one (main.js
  // decides through setTabAllowed).
  const MIN_TAB_WINDOW = { width: 420, height: 300 };

  const DEBUG_FLAGS = [
    ['devMode', 'Hidden Debug menu and developer commands'],
    ['enableVideoDebugInfo'],
    ['enableDebugCanvasPerformanceInfo'],
    ['enableDebugCanvasFrameMeasure'],
    ['enableDebugCanvasNoCache'],
    ['enableDebugWebcodecsInPreview'],
    ['enableExportDebugWindow'],
    ['debugShareWidget'],
    ['debugShowAppWindowsInRecordings', 'Turns off content protection on app windows'],
    ['devForceUpdates'],
  ];
  const LOG_LEVELS = ['verbose', 'debug', 'info', 'warn', 'error'];

  // ---------------------------------------------------------------------------
  // Long poll with panel/main.js.

  const pending = new Map();
  const queue = [];
  let wake = null;
  let nextRequestId = 1;

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pending.set(id, { resolve, reject });
      queue.push({ id, method, params });
      wake?.();
    });
  }

  // ---------------------------------------------------------------------------
  // Frame.

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-label', 'Screen Studio DevTool');
  // A color-scheme mismatch with the embedder makes Chromium paint the frame opaque.
  const colorScheme = getComputedStyle(document.documentElement).colorScheme || 'normal';
  frame.style.cssText = `all: initial; position: fixed; z-index: 2147483647; right: 0; border: 0;
    background: transparent; color-scheme: ${colorScheme}; -webkit-app-region: no-drag;`;
  document.documentElement.append(frame);

  const doc = frame.contentDocument;
  doc.documentElement.style.colorScheme = colorScheme;
  doc.head.append(Object.assign(doc.createElement('style'), { textContent: css() }));

  function h(tag, props = {}, ...children) {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'list') el.setAttribute(key, value);
      else el[key] = value;
    }
    el.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
    return el;
  }

  const tab = h('button', { class: 'tab', title: 'Screen Studio DevTool', onclick: () => setOpen(!open) }, 'DEV');
  const status = h('span', { class: 'status' });
  const scroll = h('div', { class: 'scroll' });
  const panel = h(
    'div',
    { class: 'panel', hidden: true },
    h(
      'div',
      { class: 'header' },
      'Screen Studio RE · DevTool',
      status,
      h('button', { class: 'close', title: 'Close', onclick: () => setOpen(false) }, '✕'),
    ),
    scroll,
  );
  doc.body.append(panel, tab);

  // Re-rendering under the pointer would swallow clicks.
  let pointerDown = false;
  doc.addEventListener('pointerdown', () => (pointerDown = true), true);
  doc.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false)), true);

  let open = false;
  let tabAllowed = false;
  // False while Screen Studio is in the background (main.js, setActive).
  let appActive = true;
  function layout() {
    const showTab =
      tabAllowed && window.innerWidth >= MIN_TAB_WINDOW.width && window.innerHeight >= MIN_TAB_WINDOW.height;
    frame.style.display = appActive && (open || showTab) ? 'block' : 'none';
    if (open) {
      Object.assign(frame.style, {
        top: '0',
        transform: 'none',
        height: '100vh',
        width: `${Math.min(PANEL_WIDTH + TAB_WIDTH + 18, window.innerWidth)}px`,
      });
    } else {
      Object.assign(frame.style, { top: '50%', transform: 'translateY(-50%)', height: '64px', width: `${TAB_WIDTH}px` });
    }
  }
  window.addEventListener('resize', layout);

  function setOpen(value) {
    open = value;
    panel.hidden = !open;
    tab.classList.toggle('active', open);
    layout();
    if (open) refresh();
  }
  layout();

  // ---------------------------------------------------------------------------
  // Formatting.

  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (ms) => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
  const DATE_KEYS = new Set(['exp', 'iat', 'nbf']);

  function flatten(value, prefix = '', out = []) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
    } else {
      out.push([prefix, value]);
    }
    return out;
  }

  function row(label, value, { field = false, title } = {}) {
    return h(
      'div',
      { class: 'row' },
      h('span', { class: 'label', title: label }, label),
      h('span', { class: `value${field ? ' field' : ''}`, title: title ?? show(value) }, show(value)),
    );
  }

  function note(text, extra = '') {
    return h('div', { class: `note ${extra}` }, text);
  }

  async function act(button, method, params, done = 'Done') {
    const label = button.textContent;
    button.disabled = true;
    try {
      await rpc(method, params);
      button.textContent = done;
    } catch (error) {
      button.textContent = error.message;
    }
    setTimeout(() => {
      button.textContent = label;
      button.disabled = false;
    }, 1400);
    refresh();
  }

  function toggleSwitch(on, onChange) {
    return h('button', { class: `switch${on ? ' on' : ''}`, role: 'switch', ariaChecked: String(on), onclick: () => onChange(!on) });
  }

  async function setPreference(key, value) {
    await rpc('setPreference', { key, value }).catch((error) => (status.textContent = error.message));
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Sections. `build(body, badge)` creates the static parts once and returns
  // `update(snapshot)`, called on every refresh.

  function section(title, { collapsed = false, build }) {
    const badge = h('span', { class: 'badge' });
    const body = h('div', { class: 'section-body' });
    const el = h(
      'div',
      { class: `section${collapsed ? ' collapsed' : ''}` },
      h(
        'div',
        { class: 'section-head', onclick: () => el.classList.toggle('collapsed') },
        h('span', { class: 'chevron' }, '▾'),
        h('span', {}, title),
        badge,
      ),
      body,
    );
    scroll.append(el);
    return build(body, badge);
  }

  const sections = [
    section('App', {
      build: (body, badge) => (data) => {
        const a = data.app;
        badge.textContent = a.channel;
        body.replaceChildren(
          row('Version', a.version),
          row('Recorder', a.recorder ?? '—'),
          row('Electron', a.electron),
          row('Chromium', a.chromium),
          row('Node', a.node),
          row('V8', a.v8),
          row('System', a.os),
          row('Main PID', a.pid),
          row('Locale', a.locale),
          row('App path', a.appPath),
          row('User data', a.userData),
          row('Arguments', a.argv),
        );
      },
    }),

    section('Account', {
      build: (body, badge) => {
        let name = 'Local Dev';
        let email = 'dev@localhost.local';
        const planOf = (payload, local) => {
          const activation = payload?.appActivation;
          const kind = activation?.type === 'license-key' || activation?.type === 'legacy-license-key'
            ? 'License'
            : activation?.type === 'subscription'
              ? `Subscription${activation.provider ? ` · ${activation.provider}` : ''}`
              : activation?.type === 'team'
                ? 'Team'
                : payload?.provider === 'sso'
                  ? 'SSO'
                  : 'Local';
          return local ? `${kind} · local mode` : kind;
        };
        const field = (label, value, onInput) =>
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'label' }, label),
            onInput
              ? h('input', {
                  class: 'field-input',
                  value,
                  spellcheck: false,
                  oninput: (event) => onInput(event.target.value),
                })
              : h('span', { class: 'value field' }, show(value ?? '—')),
          );
        return (data) => {
          const { signedIn, payload, local, error } = data.account;
          badge.replaceChildren(
            signedIn ? h('span', { class: 'dot' }, '●') : '',
            signedIn ? 'Signed in' : signedIn === false ? 'Signed out' : '—',
          );
          if (payload?.fullName) name = payload.fullName;
          if (payload?.email) email = payload.email;
          if (signedIn && !payload) {
            body.replaceChildren(
              note(error ?? 'A token is stored but it could not be decoded.', 'error'),
              h('button', { class: 'btn', onclick: (event) => act(event.currentTarget, 'signOut', undefined, 'Signed out') }, 'Sign out'),
            );
            return;
          }
          if (signedIn && payload) {
            body.replaceChildren(
              field('Name', payload.fullName || name),
              field('Email', payload.email),
              field('Plan', planOf(payload, local)),
              h('button', { class: 'btn', onclick: (event) => act(event.currentTarget, 'signOut', undefined, 'Signed out') }, 'Sign out'),
              local
                ? note('Local sign-in: stays on this machine, nothing is sent to Screen Studio.')
                : note('Decoded from the auth token the app keeps locally.'),
            );
            return;
          }
          body.replaceChildren(
            field('Name', name, (value) => (name = value)),
            field('Email', email, (value) => (email = value)),
            field('Plan', 'Local mode'),
            h(
              'button',
              {
                class: 'btn',
                onclick: (event) => act(event.currentTarget, 'signInLocal', { name, email }, 'Signed in'),
              },
              'Sign in locally',
            ),
            note(error ?? 'Local sign-in: stays on this machine, nothing is sent to Screen Studio.'),
          );
        };
      },
    }),

    section('Permissions', {
      build: (body, badge) => (data) => {
        const p = data.permissions;
        const missing = ['screen', 'accessibility'].filter((key) => p[key] !== 'granted');
        badge.replaceChildren(missing.length ? `${missing.length} missing` : h('span', {}, h('span', { class: 'dot' }, '●'), 'Granted'));
        const statusRow = (label, value) =>
          h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('span', { class: `value${value === 'granted' ? '' : ' error'}` }, value));
        const settingsButton = (label, pane) =>
          h('button', { class: 'btn', onclick: (event) => act(event.currentTarget, 'openPrivacySettings', { pane }) }, label);
        body.replaceChildren(
          statusRow('Screen', p.screen),
          statusRow('Accessibility', p.accessibility),
          statusRow('Microphone', p.microphone),
          statusRow('Camera', p.camera),
          p.accessibility === 'granted'
            ? null
            : h(
                'button',
                {
                  class: 'btn',
                  onclick: (event) => act(event.currentTarget, 'requestAccessibility', undefined, 'Check System Settings'),
                },
                'Add to Accessibility list',
              ),
          p.accessibility === 'granted' ? null : settingsButton('Open Accessibility settings', 'Privacy_Accessibility'),
          p.screen === 'granted' ? null : settingsButton('Open Screen Recording settings', 'Privacy_ScreenCapture'),
          p.translocated
            ? note(
                'Running from a translocated copy of a quarantined app (e.g. straight from the DMG). Install it to /Applications so permission grants stick.',
                'error',
              )
            : null,
          note('The app\'s own "Allow Accessibility access" only opens System Settings; it never adds itself to the list.'),
        );
      },
    }),

    section('Window', {
      build: (body, badge) => {
        let showOptions = false;
        return (data) => {
          const w = data.window;
          badge.textContent = `#${w.id}`;
          const flags = ['visible', 'focused', 'alwaysOnTop', 'resizable', 'movable', 'fullScreen', 'contentProtected']
            .filter((key) => w[key])
            .join(' · ');
          body.replaceChildren(
            row('Title', w.title || '(untitled)'),
            row('Kind', w.kind),
            row('Position', `${w.bounds.x}, ${w.bounds.y}`),
            row('Size', `${w.bounds.width} × ${w.bounds.height}  (content ${w.content.width} × ${w.content.height})`),
            row('Scale', `${window.devicePixelRatio}x`),
            row('Opacity', w.opacity),
            row('State', flags || '—'),
            row('webContents', `#${w.webContentsId} · pid ${w.osProcessId}`),
            row('URL', w.url),
            w.options
              ? h(
                  'div',
                  {},
                  h(
                    'button',
                    { class: 'btn', onclick: () => ((showOptions = !showOptions), refresh()) },
                    showOptions ? 'Hide creation options' : 'Show creation options',
                  ),
                  showOptions ? h('pre', { class: 'block' }, JSON.stringify(w.options, null, 2)) : null,
                )
              : note('Creation options are unknown: the window was opened before the panel was injected.'),
            h('button', { class: 'btn', onclick: (event) => act(event.currentTarget, 'toggleDevTools') }, 'Toggle DevTools'),
          );
        };
      },
    }),

    section('Windows', {
      collapsed: true,
      build: (body, badge) => (data) => {
        badge.textContent = data.windows.length;
        body.replaceChildren(
          ...data.windows.map((w) =>
            h(
              'div',
              {
                class: 'item',
                title: 'Click to toggle DevTools for this window',
                onclick: () => rpc('toggleDevTools', { windowId: w.id }).then(refresh),
              },
              h('span', { class: 'mono muted' }, `#${w.id}`),
              h('span', { class: 'main' }, `${w.title || '(untitled)'}${w.id === data.window.id ? '  ← this' : ''}`),
              h('span', { class: 'mono muted right' }, `${w.bounds.width}×${w.bounds.height}`),
              h(
                'span',
                { class: 'sub' },
                [w.kind, w.visible ? 'visible' : 'hidden', w.focused && 'focused', w.devToolsOpened && 'devtools open']
                  .filter(Boolean)
                  .join(' · '),
              ),
            ),
          ),
        );
      },
    }),

    section('Debug flags', {
      build: (body, badge) => (data) => {
        const prefs = data.preferences;
        if (!prefs) {
          badge.textContent = '';
          body.replaceChildren(note(data.preferencesError ?? 'Waiting for preferences…'));
          return;
        }
        badge.textContent = `${DEBUG_FLAGS.filter(([key]) => prefs[key]).length} on`;
        body.replaceChildren(
          ...DEBUG_FLAGS.filter(([key]) => key in prefs).map(([key, description]) =>
            h(
              'div',
              { class: 'flag' },
              h('span', { class: 'name' }, h('span', { class: 'mono' }, key), description ? h('small', {}, description) : null),
              toggleSwitch(Boolean(prefs[key]), (value) => setPreference(key, value)),
            ),
          ),
          h(
            'div',
            { class: 'flag' },
            h('span', { class: 'name' }, h('span', { class: 'mono' }, 'logLevel')),
            h(
              'span',
              { class: 'segmented' },
              LOG_LEVELS.map((level, index) =>
                h(
                  'button',
                  { class: prefs.logLevel === index ? 'on' : '', onclick: () => setPreference('logLevel', index) },
                  level,
                ),
              ),
            ),
          ),
          prefs.forcedFrontendUrl ? row('forcedFrontendUrl', prefs.forcedFrontendUrl) : null,
          note('Saved through the app\'s own preferences.update, same as its settings UI.'),
        );
      },
    }),

    section('Preferences', {
      collapsed: true,
      build: (body, badge) => (data) => {
        const prefs = data.preferences;
        if (!prefs) return;
        const debugKeys = new Set([...DEBUG_FLAGS.map(([key]) => key), 'logLevel', 'forcedFrontendUrl']);
        const entries = Object.entries(prefs).filter(([key]) => !debugKeys.has(key));
        badge.textContent = entries.length;
        body.replaceChildren(
          ...entries.map(([key, value]) =>
            typeof value === 'boolean'
              ? h(
                  'div',
                  { class: 'flag' },
                  h('span', { class: 'name' }, h('span', { class: 'mono', title: key }, key)),
                  toggleSwitch(value, (next) => setPreference(key, next)),
                )
              : row(key, value),
          ),
        );
      },
    }),

    section('IPC requests', {
      build: (body, badge) => {
        const expanded = new Set();
        let filter = '';
        let last = null;
        const list = h('div');
        body.append(
          h(
            'div',
            { class: 'toolbar' },
            h('input', {
              placeholder: 'Filter by procedure',
              spellcheck: false,
              oninput: (event) => {
                filter = event.target.value.trim();
                if (last) render(last);
              },
            }),
            h('button', { class: 'btn small', onclick: () => rpc('clearRequests').then(refresh) }, 'Clear'),
          ),
          list,
        );
        const render = (requests) => {
          const shown = requests.filter((r) => !filter || r.path?.includes(filter)).reverse();
          list.replaceChildren(
            ...shown.map((r) =>
              h(
                'div',
                {
                  class: `item${r.error ? ' failed' : ''}`,
                  onclick: (event) => {
                    if (event.target.closest('pre')) return;
                    expanded.has(r.id) ? expanded.delete(r.id) : expanded.add(r.id);
                    render(last);
                  },
                },
                h('span', { class: 'mono muted' }, clock(r.time)),
                h('span', { class: 'main mono' }, r.path),
                h('span', { class: 'mono muted right' }, r.ms === null ? '' : `${r.ms} ms`),
                h('span', { class: 'sub' }, [r.type, r.window && `window #${r.window}`, r.error].filter(Boolean).join(' · ')),
                expanded.has(r.id)
                  ? [
                      h('pre', { class: 'block' }, `input: ${r.input}`),
                      r.output !== null ? h('pre', { class: 'block' }, `output: ${r.output}`) : null,
                    ]
                  : null,
              ),
            ),
            shown.length ? null : note(requests.length ? 'No request matches the filter.' : 'No tRPC calls recorded yet.'),
          );
        };
        return (data) => {
          last = data.requests;
          badge.textContent = data.requests.length;
          render(last);
        };
      },
    }),

    section('tRPC console', {
      collapsed: true,
      build: (body, badge) => {
        let procedures = [];
        const datalist = h('datalist', { id: 'procedures' });
        const path = h('input', { placeholder: 'preferences.get', list: 'procedures', spellcheck: false });
        const type = h('select', {}, h('option', { value: 'query' }, 'query'), h('option', { value: 'mutation' }, 'mutation'));
        const input = h('textarea', { rows: 3, placeholder: 'Input as JSON, empty for none', spellcheck: false });
        const output = h('pre', { class: 'block', hidden: true });
        path.addEventListener('input', () => {
          const match = procedures.find((p) => p.path === path.value);
          if (match) type.value = match.type;
        });
        const run = h('button', {
          class: 'btn',
          onclick: async () => {
            output.hidden = false;
            output.classList.remove('error');
            let parsed;
            try {
              parsed = input.value.trim() ? JSON.parse(input.value) : undefined;
            } catch (error) {
              output.classList.add('error');
              output.textContent = `Invalid JSON: ${error.message}`;
              return;
            }
            output.textContent = 'Running…';
            try {
              output.textContent = await rpc('call', { path: path.value.trim(), type: type.value, input: parsed });
            } catch (error) {
              output.classList.add('error');
              output.textContent = error.message;
            }
          },
        }, 'Run');
        body.append(
          datalist,
          h('div', { class: 'toolbar' }, path, type),
          h('div', { class: 'toolbar' }, input),
          run,
          output,
          note('Calls the app\'s router in the main process with this window as the caller. Mutations really run.'),
        );
        return async (data) => {
          if (procedures.length || !data.ready) return;
          procedures = (await rpc('procedures')).filter((p) => p.type !== 'subscription');
          badge.textContent = procedures.length;
          datalist.replaceChildren(...procedures.map((p) => h('option', { value: p.path, label: p.type })));
        };
      },
    }),

    section('Tools', {
      build: (body) => {
        const button = (label, method, params, done) =>
          h('button', { class: 'btn', onclick: (event) => act(event.currentTarget, method, params, done) }, label);
        body.append(
          button('Copy diagnostics', 'copyDiagnostics', undefined, 'Copied to clipboard'),
          button('Open user data folder', 'openPath', { which: 'userData' }),
          button('Open projects folder', 'openPath', { which: 'projects' }),
          button('Reveal app in Finder', 'openPath', { which: 'app' }),
        );
        return () => {};
      },
    }),
  ];

  // ---------------------------------------------------------------------------
  // Refresh loop, only while the panel is open.

  let refreshing = false;
  let refreshAgain = false;
  let refreshTimer = null;
  async function refresh() {
    clearTimeout(refreshTimer);
    if (!open || !appActive) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      const data = await rpc('snapshot');
      status.textContent = data.ready ? '' : 'waiting for app…';
      if (!pointerDown) for (const update of sections) await update(data);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      } else if (open) {
        refreshTimer = setTimeout(refresh, REFRESH_MS);
      }
    }
  }

  window.__ssDevtoolsPanel = {
    takeRequests() {
      if (queue.length) return queue.splice(0);
      return new Promise((resolve) => {
        wake = () => {
          wake = null;
          resolve(queue.splice(0));
        };
      });
    },
    settle({ id, ok, value }) {
      const request = pending.get(id);
      pending.delete(id);
      if (ok) request?.resolve(value);
      else request?.reject(new Error(value));
    },
    toggle() {
      setOpen(!open);
    },
    setTabAllowed(value) {
      tabAllowed = value;
      layout();
    },
    setActive(value) {
      appActive = value;
      layout();
      if (value) refresh();
    },
  };

  function css() {
    return `
      html, body { margin: 0; background: transparent; overflow: hidden; height: 100%; }
      *, *::before, *::after { box-sizing: border-box; }
      body {
        font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
        color: #e5e5ea; -webkit-font-smoothing: antialiased; cursor: default;
      }
      button { font: inherit; color: inherit; }
      .mono, .value, pre, input, select, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .tab {
        position: fixed; right: 0; top: 50%; transform: translateY(-50%);
        width: ${TAB_WIDTH}px; height: 56px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        background: #1c1c1e; color: #ffd60a; border: 1.5px solid #ffd60a; border-right: 0;
        border-radius: 8px 0 0 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, .35);
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px;
        writing-mode: vertical-rl; cursor: pointer; opacity: .75;
      }
      .tab:hover, .tab.active { opacity: 1; }
      .panel {
        position: fixed; top: 10px; bottom: 10px; right: ${TAB_WIDTH + 8}px; width: ${PANEL_WIDTH}px;
        max-width: calc(100vw - ${TAB_WIDTH + 18}px);
        display: flex; flex-direction: column; overflow: hidden;
        background: #1c1c1e; border: 1px solid rgba(255, 255, 255, .09); border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, .5);
      }
      .panel[hidden] { display: none; }
      .header { display: flex; align-items: center; gap: 8px; padding: 12px 10px 8px 16px; font-weight: 600; color: #d1d1d6; }
      .status { color: #8e8e93; font-weight: 400; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .close {
        margin-left: auto; width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
        color: #aeaeb2; cursor: pointer; font-size: 13px;
      }
      .close:hover { background: rgba(255, 255, 255, .1); color: #fff; }
      .scroll { flex: 1; overflow-y: auto; padding: 2px 8px 12px; }
      .scroll::-webkit-scrollbar { width: 6px; }
      .scroll::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .15); border-radius: 3px; }
      .section + .section { margin-top: 6px; }
      .section-head {
        display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px;
        background: rgba(255, 255, 255, .055); font-weight: 600; cursor: pointer; user-select: none;
      }
      .chevron { display: inline-block; width: 10px; font-size: 10px; color: #aeaeb2; transition: transform .15s; }
      .section.collapsed .chevron { transform: rotate(-90deg); }
      .section.collapsed .section-body { display: none; }
      .badge { margin-left: auto; color: #98989d; font-weight: 500; font-size: 12.5px; }
      .dot { color: #30d158; margin-right: 5px; }
      .section-body { padding: 4px 0 2px; }
      .row { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 10px; padding: 5px 10px; align-items: baseline; }
      .label { color: #98989d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .value { font-size: 12px; color: #f2f2f7; overflow-wrap: anywhere; user-select: text; }
      .value.field, .field-input {
        background: rgba(255, 255, 255, .06); border-radius: 6px; padding: 4px 8px;
      }
      .field-input {
        width: 100%; border: 1px solid transparent; font-size: 12px; color: #f2f2f7;
      }
      .field-input:focus { border-color: rgba(255, 214, 10, .55); background: rgba(255, 255, 255, .09); }
      .muted { color: #8e8e93; }
      .note { color: #8e8e93; font-size: 11.5px; line-height: 1.4; padding: 4px 10px 6px; }
      .error { color: #ff6961 !important; }
      .btn {
        display: block; width: calc(100% - 20px); margin: 6px 10px; padding: 7px 10px; border: 0; border-radius: 7px;
        background: rgba(255, 255, 255, .1); color: #f2f2f7; font-weight: 500; font-size: 12.5px; cursor: pointer;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .btn:hover { background: rgba(255, 255, 255, .16); }
      .btn:disabled { opacity: .6; cursor: default; }
      .btn.small { display: inline-block; width: auto; margin: 0; padding: 4px 9px; font-size: 11.5px; }
      .flag { display: flex; align-items: center; gap: 10px; padding: 5px 10px; }
      .flag .name { flex: 1; min-width: 0; }
      .flag .name .mono { display: block; font-size: 12px; color: #f2f2f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .flag small { display: block; color: #8e8e93; font-size: 11px; }
      .switch {
        position: relative; flex: none; width: 30px; height: 18px; padding: 0; border: 0; border-radius: 9px;
        background: rgba(255, 255, 255, .18); cursor: pointer; transition: background .15s;
      }
      .switch::after {
        content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
        background: #fff; transition: transform .15s;
      }
      .switch.on { background: #30d158; }
      .switch.on::after { transform: translateX(12px); }
      .segmented { display: flex; flex: none; border-radius: 6px; overflow: hidden; background: rgba(255, 255, 255, .07); }
      .segmented button { border: 0; background: transparent; padding: 3px 6px; font-size: 11px; color: #aeaeb2; cursor: pointer; }
      .segmented button.on { background: rgba(255, 214, 10, .22); color: #ffd60a; }
      input, select, textarea {
        font-size: 12px; color: #f2f2f7; background: rgba(255, 255, 255, .07);
        border: 1px solid rgba(255, 255, 255, .08); border-radius: 6px; padding: 5px 7px; outline: none;
      }
      input:focus, select:focus, textarea:focus { border-color: rgba(255, 214, 10, .55); }
      textarea { width: 100%; resize: vertical; }
      .toolbar { display: flex; gap: 6px; align-items: center; padding: 4px 10px; }
      .toolbar input { flex: 1; min-width: 0; }
      .item {
        display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 8px; padding: 5px 10px;
        border-radius: 6px; font-size: 12px; cursor: pointer;
      }
      .item:hover { background: rgba(255, 255, 255, .045); }
      .item .main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f2f2f7; }
      .item .right { text-align: right; }
      .item .sub { grid-column: 2 / 4; color: #8e8e93; font-size: 11px; overflow-wrap: anywhere; }
      .item.failed .main, .item.failed .sub { color: #ff6961; }
      .item pre { grid-column: 1 / 4; }
      pre.block {
        margin: 4px 0 0; padding: 6px 8px; max-height: 240px; overflow: auto; border-radius: 6px;
        background: rgba(0, 0, 0, .3); color: #d1d1d6; font-size: 11px; line-height: 1.4;
        white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; cursor: text;
      }
      .section-body > pre.block, .section-body > div > pre.block { margin: 4px 10px; }
    `;
  }
})();
