// Standalone DevTools window attached to Screen Studio's main process, in the
// style of luna-PC's scripts/devTools/electron.ts. It follows the inspector
// across app restarts and asks launch.mjs for a restart over stdout.
import { app, BrowserWindow, Menu, shell } from 'electron';
import { setTimeout as sleep } from 'node:timers/promises';

const inspectPort = process.env.SCREEN_STUDIO_INSPECT_PORT ?? '9229';

// Not top-level await: Electron only emits `ready` once the ESM entry has
// finished evaluating, so awaiting it at the top level deadlocks.
async function main() {
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Screen Studio DevTools',
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'quit' }] },
      {
        label: 'View',
        submenu: [
          {
            label: 'Restart Screen Studio',
            accelerator: 'CmdOrCtrl+R',
            click: () => {
              win.loadURL('about:blank');
              process.stdout.write('RESTART\n');
            },
          },
          { role: 'toggleDevTools' },
        ],
      },
      { role: 'editMenu' },
    ]),
  );

  while (true) {
    try {
      const [target] = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
      if (target && win.webContents.getURL() !== target.devtoolsFrontendUrl) {
        win.loadURL(target.devtoolsFrontendUrl);
        // Screen Studio grabs focus while booting, so pull the window back on top.
        win.setAlwaysOnTop(true);
        setTimeout(() => {
          win.setAlwaysOnTop(false);
          app.focus({ steal: true });
          win.show();
          win.focus();
        }, 2000);
      }
    } catch {
      // Screen Studio is (re)starting; keep polling.
    }
    await sleep(1000);
  }
}

main();
