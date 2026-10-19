#!/usr/bin/env node
// Starts Screen Studio with the Node inspector and Chromium remote debugging
// enabled and injects a Developer menu (inject.js) and the DEV panel (panel/)
// into its main process. With --main-devtools it also opens a standalone
// DevTools window on that process (window.mjs). The app bundle itself is never
// modified.
import electronPath from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    app: { type: 'string', default: '/Applications/Screen Studio.app' },
    'inspect-port': { type: 'string', default: '9229' },
    'remote-debugging-port': { type: 'string', default: '9222' },
    'main-devtools': { type: 'boolean', default: false },
  },
});
const inspectPort = Number(opts['inspect-port']);
const remotePort = Number(opts['remote-debugging-port']);
const binary = `${opts.app}/Contents/MacOS/Screen Studio`;
const logFile = join(tmpdir(), 'screen-studio-devtools.log');

function log(message) {
  console.log(`\x1b[36m[devtools]\x1b[0m ${message}`);
}

function fail(message) {
  console.error(`\x1b[31m[devtools]\x1b[0m ${message}`);
  process.exit(1);
}

function isAppRunning() {
  try {
    execFileSync('pgrep', ['-x', 'Screen Studio'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// If the port is taken, Electron keeps running without a debugger and we
// would end up injecting into whatever else is listening there.
async function assertPortFree(port) {
  const server = createServer();
  server.listen(port, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch {
    fail(`Port ${port} is already in use. Pick another one with --inspect-port / --remote-debugging-port.`);
  }
  server.close();
}

async function waitForInspector(child, port) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) fail('Screen Studio exited before its inspector came up.');
    try {
      const [target] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (target) return target;
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  fail(`Timed out waiting for the inspector on port ${port}.`);
}

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

// The inspector comes up before Electron has registered its `electron` module,
// and the module resolves a little before its main-process APIs are usable.
async function waitForElectron(webSocketUrl) {
  const probe = `(() => {
    try {
      const { BrowserWindow, Menu } = (process.mainModule?.require ?? require)('electron');
      return typeof BrowserWindow?.getAllWindows === 'function' && typeof Menu?.getApplicationMenu === 'function';
    } catch {
      return false;
    }
  })()`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await evaluate(webSocketUrl, probe).catch(() => false)) return;
    await sleep(25);
  }
  fail('Timed out waiting for Electron to initialize in the main process.');
}

async function evaluate(webSocketUrl, expression) {
  const ws = new WebSocket(webSocketUrl);
  await once(ws, 'open');
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      // includeCommandLineAPI exposes `require` before the main module has loaded.
      params: { expression, includeCommandLineAPI: true, returnByValue: true },
    }),
  );
  let reply;
  while (!reply) {
    const [event] = await once(ws, 'message');
    const message = JSON.parse(event.data);
    if (message.id === 1) reply = message;
  }
  ws.close();

  if (reply.error) throw new Error(reply.error.message);
  const { result, exceptionDetails } = reply.result;
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

// The `open -W` process, which exits together with the app.
let screenStudio;
let appPid;
let inspectorTarget;
let restarting = false;

async function startScreenStudio() {
  await assertPortFree(inspectPort);
  await assertPortFree(remotePort);

  // Launch through LaunchServices instead of spawning the binary: macOS
  // attributes TCC permissions (Screen Recording, Accessibility) to the
  // responsible process, which would otherwise be this terminal, and Screen
  // Studio would never show up in System Settings.
  screenStudio = spawn(
    'open',
    [
      '-n',
      '-W',
      '--stdout',
      logFile,
      '--stderr',
      logFile,
      opts.app,
      '--args',
      `--inspect=127.0.0.1:${inspectPort}`,
      `--remote-debugging-port=${remotePort}`,
    ],
    { stdio: 'inherit' },
  );
  screenStudio.once('exit', (code, signal) => {
    appPid = undefined;
    if (restarting) return;
    devtoolsWindow?.kill();
    appLog.kill();
    process.exit(code ?? (signal ? 1 : 0));
  });

  inspectorTarget = await waitForInspector(screenStudio, inspectPort);
  const { webSocketDebuggerUrl } = inspectorTarget;
  appPid = await evaluate(webSocketDebuggerUrl, 'process.pid').catch(() => undefined);
  await waitForElectron(webSocketDebuggerUrl);
  try {
    log(await evaluate(webSocketDebuggerUrl, readSource('./inject.js')));
  } catch (error) {
    log(`Injecting the Developer menu failed, remote debugging is still available: ${error.message}`);
  }
  try {
    log(await evaluate(webSocketDebuggerUrl, `(${readSource('./panel/main.js')})(${JSON.stringify(readSource('./panel/renderer.js'))})`));
  } catch (error) {
    log(`Injecting the DEV panel failed: ${error.message}`);
  }
}

async function restartScreenStudio() {
  if (restarting) return;
  restarting = true;
  log('Restarting Screen Studio...');

  const exited = once(screenStudio, 'exit');
  // Quit through the app so its close manager can finish pending work.
  await evaluate(inspectorTarget.webSocketDebuggerUrl, "require('electron').app.quit()").catch(() =>
    killApp('SIGTERM'),
  );
  await exited;

  restarting = false;
  await startScreenStudio();
}

function killApp(signal) {
  try {
    if (appPid) process.kill(appPid, signal);
  } catch {
    // Already gone.
  }
}

if (!existsSync(binary)) fail(`Screen Studio not found at "${opts.app}". Pass --app <path to Screen Studio.app>.`);
if (isAppRunning()) fail('Screen Studio is already running. Quit it first, it only allows a single instance.');

let devtoolsWindow;
if (opts['main-devtools']) {
  devtoolsWindow = spawn(electronPath, [fileURLToPath(new URL('./window.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, SCREEN_STUDIO_INSPECT_PORT: String(inspectPort) },
  });
  readline.createInterface({ input: devtoolsWindow.stdout }).on('line', (line) => {
    if (line === 'RESTART') restartScreenStudio();
  });
  devtoolsWindow.on('exit', () => log('DevTools window closed, Screen Studio keeps running.'));
}

// The app's output goes to a file through `open`; follow it here.
writeFileSync(logFile, '');
const appLog = spawn('tail', ['-n', '+1', '-F', logFile], { stdio: ['ignore', 'inherit', 'inherit'] });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    devtoolsWindow?.kill(signal);
    killApp(signal);
  });
}

await startScreenStudio();
log('DEV panel:     DEV tab on the right edge of the focused window, or Cmd+Option+P');
log('Renderer:      Developer menu or Cmd+Option+I inside Screen Studio');
log(
  opts['main-devtools']
    ? 'Main process:  DevTools window (Cmd+R there restarts Screen Studio)'
    : 'Main process:  chrome://inspect, or relaunch with --main-devtools for a DevTools window',
);
log(`App output:    ${logFile}`);
log(`All targets:   chrome://inspect (localhost:${remotePort} windows, localhost:${inspectPort} main process)`);
