# Screen Studio DevTools

English · [中文](README.zh.md)

Injects an in-app DEV panel (and a Developer menu) into an installed copy of [Screen Studio](https://screen.studio): window config, account, preferences, tRPC calls, and so on.

**The `.app` / `app.asar` is never modified.** On every launch the scripts are evaluated into the running main process through the Node inspector.

## Usage

1. Install Screen Studio at `/Applications/Screen Studio.app`
2. In this repo:

```bash
bun install
bun run devtools
```

Do not open Screen Studio from the Dock, Launchpad, or Finder. It only allows a single instance, so the launcher will refuse to start. Use `bun run devtools`; Ctrl+C quits the app with it.

The **DEV** tab on the right edge of a window (or `Cmd+Option+P`) opens the panel. Chromium DevTools is under the Developer menu, or `Cmd+Option+I`.

If the app is not in the default location:

```bash
node devtools/launch.mjs --app "/path/to/Screen Studio.app"
```

### Run in the background (pm2)

To keep it resident so Screen Studio is always up with the panel injected:

```bash
npm install -g pm2
bun run daemon          # pm2 start ecosystem.config.cjs
bun run daemon:logs     # follow output
bun run daemon:stop     # stop it (also quits Screen Studio)
pm2 save                # remember it across pm2 restarts
```

Quitting Screen Studio (Cmd+Q) makes `launch.mjs` exit with 0, and pm2 leaves it stopped; only abnormal exits are restarted. Run `bun run daemon:restart` to bring it back. Screen Studio must not already be running when the daemon starts. For launch-at-login, run `pm2 startup` and follow the printed command.

## What’s in the panel

| Section | |
| --- | --- |
| App | Version, Electron / Chromium / Node, paths, argv |
| Account | Sign-in state. **Sign in locally** writes a JWT on this machine only — nothing is sent to screen.studio |
| Permissions | Screen Recording / Accessibility / microphone / camera. Accessibility uses the system prompt so the app actually appears in the list |
| Window / Windows | Bounds and creation options; click a window to toggle DevTools |
| Debug flags / Preferences | Reads and writes the app’s own `preferences.update` |
| IPC requests | Log of main-process tRPC calls |
| tRPC console | Run queries / mutations in the main process (mutations really run) |

## How injection works

```
bun run devtools
  └─ open Screen Studio.app --args --inspect=127.0.0.1:9229 --remote-debugging-port=9222
       └─ CDP Runtime.evaluate in the main process
            ├─ inject.js          Developer menu
            └─ panel/main.js      finds the app’s tRPC bridge, injects panel/renderer.js into child windows
```

Every visible window is an `about:blank` opened by a hidden host renderer via `window.open`. The panel lives in those child windows and talks to the main process over a long poll. Data comes from the app’s own tRPC, called in-process so it never goes through the renderer.

## Options

| Flag | Default | |
| --- | --- | --- |
| `--app` | `/Applications/Screen Studio.app` | |
| `--inspect-port` | `9229` | Main-process inspector |
| `--remote-debugging-port` | `9222` | Chromium remote debugging |
| `--main-devtools` | off | Also open a DevTools window attached to the main process |

## Permissions

macOS attributes TCC (Screen Recording, Accessibility) to the **responsible process**. The launcher therefore starts Screen Studio with `open` (Launch Services) instead of spawning the binary — otherwise the grant would stick to the terminal and Screen Studio would never show up in System Settings.

Screen Studio’s own “Allow Accessibility access” only opens the Settings pane; it never adds itself to the list. Use **Add to Accessibility list** in the panel’s Permissions section.
