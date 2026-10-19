// pm2 config for keeping the DevTools launcher (and with it, an injected Screen
// Studio) resident in the background.
//
//   pm2 start ecosystem.config.cjs     # start / bun run daemon
//   pm2 logs screenstudio-devtools     # follow output
//   pm2 stop screenstudio-devtools     # stop (also quits Screen Studio)
//
// launch.mjs exits with 0 when Screen Studio quits normally, and pm2 leaves it
// stopped (stop_exit_codes). Other exits (failed launch, crash of the launcher)
// are restarted. Start it again with `pm2 restart screenstudio-devtools`.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'screenstudio-devtools',
      script: path.join(__dirname, 'devtools', 'launch.mjs'),
      interpreter: 'node',
      cwd: __dirname,
      // args: '--main-devtools',   // uncomment to also open the main-process DevTools window
      autorestart: true,
      // Quitting Screen Studio (Cmd+Q) is not a crash: don't bring it back.
      stop_exit_codes: [0],
      restart_delay: 3000,
      // Guard against a hot loop when the app is missing or already running:
      // a run has to stay up 10s to count as healthy, and we give up after 10
      // quick failures.
      min_uptime: 10_000,
      max_restarts: 10,
      // Let the app close gracefully (its close manager may have pending work)
      // before pm2 escalates to SIGKILL.
      kill_timeout: 8_000,
      time: true,
      merge_logs: true,
    },
  ],
};
