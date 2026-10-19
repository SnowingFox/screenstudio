# Screen Studio DevTools

[English](README.md) · 中文

给已安装的 [Screen Studio](https://screen.studio) 注入一个应用内 DEV 面板（以及 Developer 菜单），用来看窗口配置、账号、偏好、tRPC 调用等。

**不改 `.app` / `app.asar`。** 每次都是启动时通过 Node inspector 把脚本 eval 进正在跑的主进程。

## 用法

1. 把 Screen Studio 装到 `/Applications/Screen Studio.app`
2. 本仓库：

```bash
bun install
bun run devtools
```

不要从 Dock / Launchpad / Finder 打开 Screen Studio。它是单实例，那样 launcher 会起不来。用 `bun run devtools` 开，Ctrl+C 会连 app 一起停。

窗口右边的 **DEV** 标签（或 `Cmd+Option+P`）打开面板。Chromium DevTools 走菜单栏 Developer，或 `Cmd+Option+I`。

App 不在默认路径时：

```bash
node devtools/launch.mjs --app "/path/to/Screen Studio.app"
```

### 后台常驻（pm2）

想让它常驻、Screen Studio 一直开着并带着面板：

```bash
npm install -g pm2
bun run daemon          # pm2 start ecosystem.config.cjs
bun run daemon:logs     # 看日志
bun run daemon:stop     # 停掉（会连 Screen Studio 一起退）
pm2 save                # 让 pm2 重启后记住它
```

`launch.mjs` 在 Screen Studio 退出时也会退出，pm2 会把它拉起来，所以**关掉 app 窗口它会（隔几秒）自己重开**。真要停就用 `bun run daemon:stop`。daemon 启动时 Screen Studio 不能已经在跑。想开机自启就跑 `pm2 startup`，按它打印的命令执行。

## 面板里有什么

| 分组 | 内容 |
| --- | --- |
| App | 版本、Electron / Chromium / Node、路径、启动参数 |
| Account | 登录态。**Sign in locally** 只写本机 JWT，不发到 screen.studio |
| Permissions | 录屏 / 辅助功能 / 麦克风 / 摄像头。辅助功能用系统 prompt 把自己加进列表 |
| Window / Windows | 当前窗口和所有窗口的 bounds、创建参数，点一下开 DevTools |
| Debug flags / Preferences | 读写 app 自己的 `preferences.update` |
| IPC requests | 主进程 tRPC 调用日志 |
| tRPC console | 在主进程里跑 query / mutation（mutation 是真的会执行） |

## 注入是怎么回事

```
bun run devtools
  └─ open Screen Studio.app --args --inspect=127.0.0.1:9229 --remote-debugging-port=9222
       └─ CDP Runtime.evaluate 进主进程
            ├─ inject.js          Developer 菜单
            └─ panel/main.js      找到 app 的 tRPC 桥，往子窗口塞 panel/renderer.js
```

可见窗口都是隐藏 host renderer `window.open` 出来的 `about:blank`。面板活在这些子窗口里，通过 long poll 跟主进程说话，数据走 app 自己的 tRPC（进程内调用，不经过 renderer）。

## 选项

| 参数 | 默认 | |
| --- | --- | --- |
| `--app` | `/Applications/Screen Studio.app` | |
| `--inspect-port` | `9229` | 主进程 inspector |
| `--remote-debugging-port` | `9222` | Chromium 远程调试 |
| `--main-devtools` | 关 | 再开一个挂在主进程上的 DevTools 窗口 |

## 权限

macOS 把 TCC（录屏、辅助功能）记在 **负责启动的进程** 上。所以 launcher 用 `open` 走 Launch Services，而不是直接 spawn 二进制——否则权限会记到终端上，System Settings 里找不到 Screen Studio。

Screen Studio 自己的 “Allow Accessibility access” 只打开设置页，不会把自己加进列表。用面板 Permissions 里的 **Add to Accessibility list**。
