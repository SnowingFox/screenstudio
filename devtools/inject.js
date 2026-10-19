// Evaluated inside Screen Studio's main process through the Node inspector
// (see launch.mjs). Must stay a single expression; its value is reported back.
(() => {
  const load = process.mainModule?.require ?? require;
  const { app, BrowserWindow, Menu, MenuItem } = load('electron');

  const DEVELOPER_MENU_ID = 'injected-developer-menu';

  if (globalThis.__devtoolsInjected) return 'Developer menu already installed';
  globalThis.__devtoolsInjected = true;

  const liveWindows = () =>
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .sort((a, b) => a.id - b.id);

  const describe = (win) => {
    const name = win.getTitle() || win.webContents.getURL().split('/').pop() || 'untitled';
    return `#${win.id} ${name}${win.isVisible() ? '' : ' (hidden)'}`;
  };

  // Most Screen Studio windows are small, frameless or transparent, so docked
  // DevTools would be unusable.
  const toggle = (win) => {
    if (!win || win.isDestroyed()) return;
    const { webContents } = win;
    if (webContents.isDevToolsOpened()) webContents.closeDevTools();
    else webContents.openDevTools({ mode: 'detach' });
  };

  const editorWindow = () =>
    liveWindows().find((win) => win.isVisible() && win.webContents.getURL().endsWith('/index.html'));

  // Visible app windows are about:blank children of the hidden host window.
  const largestAppWindow = () =>
    liveWindows()
      .filter((win) => win.isVisible() && win.webContents.getURL() === 'about:blank')
      .sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0];

  const buildDeveloperMenu = () =>
    new MenuItem({
      id: DEVELOPER_MENU_ID,
      label: 'Developer',
      submenu: [
        {
          label: 'Toggle DevTools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => toggle(BrowserWindow.getFocusedWindow() ?? editorWindow()),
        },
        {
          // Installed by panel/main.js.
          label: 'Toggle DEV Panel',
          accelerator: 'CmdOrCtrl+Alt+P',
          click: () => globalThis.__ssDevtoolsPanel?.toggle(BrowserWindow.getFocusedWindow() ?? largestAppWindow()),
        },
        {
          label: 'Toggle DevTools for Window',
          submenu: liveWindows().map((win) => ({ label: describe(win), click: () => toggle(win) })),
        },
        { type: 'separator' },
        {
          label: 'Close All DevTools',
          click: () => liveWindows().forEach((win) => win.webContents.closeDevTools()),
        },
      ],
    });

  // The app can rebuild its menu at any time, which would drop an item added
  // once, so re-append the Developer menu on every setApplicationMenu call.
  const setApplicationMenu = Menu.setApplicationMenu.bind(Menu);
  let appMenu = Menu.getApplicationMenu();

  const install = () => {
    if (!appMenu) return;
    const menu = new Menu();
    for (const item of appMenu.items) {
      if (item.id !== DEVELOPER_MENU_ID) menu.append(item);
    }
    menu.append(buildDeveloperMenu());
    setApplicationMenu(menu);
  };

  Menu.setApplicationMenu = (menu) => {
    appMenu = menu;
    if (menu) install();
    else setApplicationMenu(menu);
  };

  // Keep the per-window submenu in sync with the open windows.
  let refreshTimer = null;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(install, 100);
  };
  const watch = (win) => {
    win.on('closed', scheduleRefresh);
    win.on('show', scheduleRefresh);
    win.on('hide', scheduleRefresh);
    win.on('page-title-updated', scheduleRefresh);
  };
  liveWindows().forEach(watch);
  app.on('browser-window-created', (_event, win) => {
    watch(win);
    scheduleRefresh();
  });

  // An attached DevTools window makes Node wait for the debugger to disconnect
  // before exiting, so drop all inspector sessions once quitting is final.
  app.on('quit', () => load('node:inspector').close());

  install();
  return `Developer menu installed (${liveWindows().length} windows open)`;
})();
