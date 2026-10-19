// Main-process half of the DEV panel, evaluated inside Screen Studio's main
// process through the Node inspector (see launch.mjs). Must stay a single
// function expression: launch.mjs calls it with the source of renderer.js.
//
// Every visible Screen Studio window is an `about:blank` child that the hidden
// host renderer opened with window.open and fills through React portals. The
// panel is injected into those child windows and talks to this side through a
// long poll: we await `takeRequests()` in the page and answer with `settle()`.
// App data comes from the app's own tRPC router, called in-process so nothing
// is sent through (and logged by) the renderer.
((rendererSource) => {
  const load = process.mainModule?.require ?? require;
  const { app, BrowserWindow, clipboard, shell, webContents } = load('electron');
  const inspector = load('node:inspector');

  if (globalThis.__ssDevtoolsPanel) return 'DEV panel already installed';

  const MAX_REQUESTS = 200;
  const CALL_TIMEOUT_MS = 3000;

  const state = {
    invoke: null, // the app's original `trpc:invoke` handler
    procedures: null,
    requests: [],
    nextRequestId: 1,
    windowOptions: new Map(), // BrowserWindow id -> options it was opened with
    injected: new WeakSet(),
  };

  // ---------------------------------------------------------------------------
  // Serialization: everything sent to the page goes through JSON, and previews
  // of IPC payloads must stay cheap even for whole projects.

  function toPlain(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.length > 5000 ? `${value.slice(0, 5000)}…` : value;
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'undefined') return null;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'symbol') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.constructor.name} ${value.byteLength} bytes]`;
    if (seen.has(value)) return '[Circular]';
    if (depth >= 8) return '[…]';
    seen.add(value);
    if (value instanceof Map) value = Object.fromEntries(value);
    if (value instanceof Set) value = [...value];
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => toPlain(item, depth + 1, seen));
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = toPlain(item, depth + 1, seen);
    return out;
  }

  // JSON-ish rendering that stops after `budget` characters instead of
  // serializing the whole value first.
  function preview(value, budget = 2000) {
    let out = '';
    const seen = new WeakSet();
    const write = (text) => {
      out += text;
      if (out.length > budget) throw preview;
    };
    const walk = (item, indent) => {
      if (item === null || item === undefined) return write(String(item));
      if (typeof item === 'string') return write(JSON.stringify(item.length > 300 ? `${item.slice(0, 300)}…` : item));
      if (typeof item !== 'object') return write(typeof item === 'bigint' ? `${item}n` : String(item));
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return write(`<${item.constructor.name} ${item.byteLength} bytes>`);
      if (item instanceof Date) return write(item.toISOString());
      if (seen.has(item)) return write('[Circular]');
      seen.add(item);
      const isList = Array.isArray(item) || item instanceof Set;
      const entries = Array.isArray(item)
        ? item.entries()
        : item instanceof Set
          ? [...item].entries()
          : item instanceof Map
            ? item.entries()
            : Object.entries(item).values();
      const pad = '  '.repeat(indent + 1);
      let empty = true;
      for (const [key, child] of entries) {
        if (empty) write(isList ? '[\n' : '{\n');
        empty = false;
        write(isList ? pad : `${pad}${String(key)}: `);
        walk(child, indent + 1);
        write(',\n');
      }
      if (empty) return write(isList ? '[]' : '{}');
      write(`${'  '.repeat(indent)}${isList ? ']' : '}'}`);
    };
    try {
      walk(value, 0);
    } catch (error) {
      if (error !== preview) return `<${error.message}>`;
      return `${out.slice(0, budget)}\n…`;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Reaching the app's IPC bridge. Screen Studio keeps it (and the tRPC router)
  // in module scope, so walk the closure scopes of one of its ipcMain listeners
  // the way the DevTools Scope pane does, through an in-process inspector
  // session (its `post` dispatches synchronously).

  function findInClosures(fn, predicate) {
    const session = new inspector.Session();
    session.connect();
    const post = (method, params) => {
      let error;
      let result;
      session.post(method, params, (e, r) => {
        error = e;
        result = r;
      });
      if (error) throw error;
      return result;
    };
    const holder = { fn, predicate, found: undefined };
    const key = `__ssDevtoolsProbe${Date.now()}`;
    globalThis[key] = holder;
    try {
      const objectId = (expression) => post('Runtime.evaluate', { expression }).result.objectId;
      const scopes = post('Runtime.getProperties', { objectId: objectId(`globalThis.${key}.fn`), ownProperties: true })
        .internalProperties?.find((property) => property.name === '[[Scopes]]');
      if (!scopes) return undefined;
      const predicateId = objectId(`globalThis.${key}.predicate`);
      const holderId = objectId(`globalThis.${key}`);
      for (const scope of post('Runtime.getProperties', { objectId: scopes.value.objectId, ownProperties: true }).result) {
        if (!scope.value?.objectId || scope.value.description === 'Global') continue;
        for (const variable of post('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true }).result) {
          if (variable.value?.type !== 'object' || !variable.value.objectId) continue;
          const matches = post('Runtime.callFunctionOn', {
            objectId: variable.value.objectId,
            functionDeclaration: 'function (predicate) { try { return !!predicate(this) } catch { return false } }',
            arguments: [{ objectId: predicateId }],
            returnByValue: true,
          }).result.value;
          if (!matches) continue;
          post('Runtime.callFunctionOn', {
            objectId: variable.value.objectId,
            functionDeclaration: 'function (holder) { holder.found = this }',
            arguments: [{ objectId: holderId }],
          });
          return holder.found;
        }
      }
      return undefined;
    } finally {
      delete globalThis[key];
      session.disconnect();
    }
  }

  function recordRequest(entry) {
    state.requests.push({ id: state.nextRequestId++, ...entry });
    if (state.requests.length > MAX_REQUESTS) state.requests.splice(0, state.requests.length - MAX_REQUESTS);
  }

  // Log every tRPC call the app makes; the wrappers pass everything through.
  function wrapHandlers(bridge) {
    const invoke = bridge.handlersMap.get('trpc:invoke');
    bridge.handlersMap.set('trpc:invoke', async (event, op, ...rest) => {
      const started = Date.now();
      const base = { time: started, path: op?.path, type: op?.type, window: event?.browserWindow?.id, input: preview(op?.input) };
      try {
        const response = await invoke(event, op, ...rest);
        recordRequest({
          ...base,
          ms: Date.now() - started,
          error: response?.error?.message ?? null,
          output: response?.error ? null : preview(response?.result?.data),
        });
        return response;
      } catch (error) {
        recordRequest({ ...base, ms: Date.now() - started, error: String(error?.message ?? error), output: null });
        throw error;
      }
    });

    const subscribe = bridge.handlersMap.get('trpc:startSubscription');
    if (subscribe) {
      bridge.handlersMap.set('trpc:startSubscription', (event, op, ...rest) => {
        recordRequest({
          time: Date.now(),
          path: op?.path,
          type: 'subscription',
          window: event?.browserWindow?.id,
          input: preview(op?.input),
          ms: null,
          error: null,
          output: null,
        });
        return subscribe(event, op, ...rest);
      });
    }
    return invoke;
  }

  function connectToApp() {
    const { ipcMain } = load('electron');
    const listener = ipcMain.listeners('$$typelectron:$internal:invoke')[0];
    if (!listener) return false;
    const bridge = findInClosures(listener, (value) => value.handlersMap instanceof Map && value.handlersMap.has('trpc:invoke'));
    if (!bridge) return false;

    const router = findInClosures(
      bridge.handlersMap.get('trpc:invoke'),
      (value) => typeof value.createCaller === 'function' && typeof value._def?.queries === 'object',
    );
    if (router) {
      const { queries = {}, mutations = {}, subscriptions = {} } = router._def;
      state.procedures = [
        ...Object.keys(queries).map((path) => ({ path, type: 'query' })),
        ...Object.keys(mutations).map((path) => ({ path, type: 'mutation' })),
        ...Object.keys(subscriptions).map((path) => ({ path, type: 'subscription' })),
      ].sort((a, b) => a.path.localeCompare(b.path));
    }
    state.invoke = wrapHandlers(bridge);
    return true;
  }

  // The tRPC handler is registered while the app boots, after we are injected.
  const connectTimer = setInterval(() => {
    try {
      if (connectToApp()) clearInterval(connectTimer);
    } catch (error) {
      clearInterval(connectTimer);
      console.error('[devtools] Could not reach the Screen Studio IPC bridge:', error);
    }
  }, 300);
  setTimeout(() => clearInterval(connectTimer), 120_000);

  async function trpc(win, path, type = 'query', input = undefined) {
    if (!state.invoke) throw new Error('Screen Studio has not finished booting yet');
    const response = await Promise.race([
      state.invoke({ browserWindow: win }, { path, type, input }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${path} timed out`)), CALL_TIMEOUT_MS)),
    ]);
    if (response.error) throw new Error(response.error.message);
    return response.result.data;
  }

  const settled = (promise) => promise.then(
    (value) => ({ value }),
    (error) => ({ error: error.message }),
  );

  // ---------------------------------------------------------------------------
  // Snapshot shown by the panel.

  let appInfo = null;
  async function getAppInfo(win) {
    if (appInfo?.recorder) return appInfo;
    const [recorder, osVersion] = await Promise.all([
      settled(trpc(win, 'app.recorderVersion')),
      settled(trpc(win, 'system.osVersion')),
    ]);
    const version = app.getVersion();
    appInfo = {
      name: app.getName(),
      version,
      channel: !app.isPackaged ? 'dev' : version.includes('beta') ? 'beta' : 'prod',
      recorder: recorder.value ?? null,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      os: `macOS ${osVersion.value ?? '?'} · ${process.arch}`,
      pid: process.pid,
      locale: app.getLocale(),
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      argv: process.argv.slice(1).join(' '),
    };
    return appInfo;
  }

  function windowKind(win) {
    const url = win.webContents.getURL();
    if (url === 'about:blank' || url === '') return 'window';
    const args = win.webContents.getLastWebPreferences?.()?.additionalArguments ?? [];
    return args.includes('--render-worker') ? 'render worker' : 'host';
  }

  function describeWindow(win, detailed = false) {
    const { webContents: wc } = win;
    const base = {
      id: win.id,
      title: win.getTitle(),
      kind: windowKind(win),
      bounds: win.getBounds(),
      visible: win.isVisible(),
      focused: win.isFocused(),
      devToolsOpened: wc.isDevToolsOpened(),
    };
    if (!detailed) return base;
    const [contentWidth, contentHeight] = win.getContentSize();
    return {
      ...base,
      content: { width: contentWidth, height: contentHeight },
      alwaysOnTop: win.isAlwaysOnTop(),
      resizable: win.isResizable(),
      movable: win.isMovable(),
      fullScreen: win.isFullScreen(),
      opacity: win.getOpacity(),
      contentProtected: win.isContentProtected?.() ?? null,
      webContentsId: wc.id,
      osProcessId: wc.getOSProcessId(),
      url: wc.getURL(),
      options: toPlain(state.windowOptions.get(win.id) ?? null),
    };
  }

  async function snapshot(win) {
    const [preferences, signedIn, payload] = await Promise.all([
      settled(trpc(win, 'preferences.get')),
      settled(trpc(win, 'auth.hasToken')),
      settled(trpc(win, 'auth.authPayload')),
    ]);
    return {
      ready: Boolean(state.invoke),
      app: await getAppInfo(win),
      window: describeWindow(win, true),
      windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => describeWindow(w)),
      account: {
        signedIn: signedIn.value ?? null,
        payload: toPlain(payload.value ?? null),
        error: signedIn.error ?? payload.error ?? null,
      },
      preferences: toPlain(preferences.value ?? null),
      preferencesError: preferences.error ?? null,
      requests: state.requests.slice(-100),
    };
  }

  // ---------------------------------------------------------------------------
  // Page requests.

  function toggleDevTools(win) {
    if (!win || win.isDestroyed()) return;
    const { webContents: wc } = win;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  }

  const methods = {
    snapshot: (win) => snapshot(win),
    procedures: () => state.procedures ?? [],
    setPreference: (win, { key, value }) => trpc(win, 'preferences.update', 'mutation', { changes: { [key]: value } }),
    call: async (win, { path, type, input }) => {
      if (type !== 'query' && type !== 'mutation') throw new Error('Only queries and mutations can be called from here');
      return preview(await trpc(win, path, type, input), 20_000);
    },
    clearRequests: () => {
      state.requests.length = 0;
    },
    toggleDevTools: (win, { windowId } = {}) => toggleDevTools(windowId ? BrowserWindow.fromId(windowId) : win),
    copyDiagnostics: async (win) => {
      const { projectsFolderPath } = await trpc(win, 'preferences.get');
      const data = await trpc(win, 'debug.diagnosticData', 'query', { path: projectsFolderPath ?? app.getPath('home') });
      clipboard.writeText(JSON.stringify(toPlain(data), null, 2));
    },
    openPath: async (win, { which }) => {
      const paths = {
        userData: () => app.getPath('userData'),
        projects: async () => (await trpc(win, 'preferences.get')).projectsFolderPath,
        app: () => process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, ''),
      };
      const target = await paths[which]?.();
      if (!target) throw new Error(`Unknown path ${which}`);
      if (which === 'app') shell.showItemInFolder(target);
      else {
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      }
    },
  };

  async function handle(win, { id, method, params }) {
    let reply;
    try {
      if (!methods[method]) throw new Error(`Unknown method ${method}`);
      reply = { id, ok: true, value: toPlain((await methods[method](win, params)) ?? null) };
    } catch (error) {
      reply = { id, ok: false, value: String(error?.message ?? error) };
    }
    if (!win.isDestroyed()) {
      await win.webContents.executeJavaScript(`window.__ssDevtoolsPanel?.settle(${JSON.stringify(reply)})`).catch(() => {});
    }
  }

  async function pump(win) {
    const { webContents: wc } = win;
    while (!win.isDestroyed() && !wc.isDestroyed()) {
      let requests;
      try {
        requests = await wc.executeJavaScript('window.__ssDevtoolsPanel.takeRequests()');
      } catch {
        return; // Window closed or the page went away.
      }
      for (const request of requests) handle(win, request);
    }
  }

  async function inject(win) {
    if (win.isDestroyed() || state.injected.has(win.webContents)) return;
    state.injected.add(win.webContents);
    try {
      await win.webContents.executeJavaScript(rendererSource);
    } catch (error) {
      state.injected.delete(win.webContents);
      console.error(`[devtools] Could not inject the DEV panel into window #${win.id}:`, error);
      return;
    }
    pump(win);
  }

  // Children are opened by the host renderer; remember the options they were
  // created with (their "page config") and inject the panel right away.
  const watchHost = (wc) => {
    wc.on('did-create-window', (win, details) => {
      state.windowOptions.set(win.id, details.options);
      win.once('closed', () => state.windowOptions.delete(win.id));
      inject(win);
    });
  };
  webContents.getAllWebContents().forEach(watchHost);
  app.on('web-contents-created', (_event, wc) => watchHost(wc));
  BrowserWindow.getAllWindows()
    .filter((win) => windowKind(win) === 'window')
    .forEach(inject);

  globalThis.__ssDevtoolsPanel = {
    // Used by the Developer menu (inject.js).
    async toggle(win) {
      if (!win || win.isDestroyed()) return;
      await inject(win);
      await win.webContents.executeJavaScript('window.__ssDevtoolsPanel?.toggle()').catch(() => {});
    },
  };

  return 'DEV panel installed';
})
