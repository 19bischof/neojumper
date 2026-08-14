# Neojumper

A local API that opens a file at a line in the earliest-created running
Neovim instance, selects its tmux pane, and brings Ghostty forward.

Relative file paths are resolved from that Neovim instance's current working
directory. Absolute paths and `~/...` paths are also supported.

## Run manually

```bash
cd ~/dev/neojumper
npm start
```

Send a request:

```bash
curl \
  --header 'Content-Type: application/json' \
  --data '{"file":"src/server.js","line":42}' \
  http://localhost:8766/api/open
```

## Start automatically at login

```bash
cd ~/dev/neojumper
./manage-launchd.sh load
```

Other supported actions:

```bash
./manage-launchd.sh restart
./manage-launchd.sh unload
```

Logs are written to `logs/neojumper.log` and `logs/neojumper.err.log`. Each
request logs its total duration and a per-stage timing breakdown (`discover`,
`nvimEdit`, `findPane`, `focus`), which is also returned in the JSON response as
`timings` and `totalMs`.

## Assumptions

- Neovim is installed at `/opt/homebrew/bin/nvim`.
- tmux is installed at `/opt/homebrew/bin/tmux`.
- Node.js is installed at `/opt/homebrew/bin/node`.
- Neovim is running inside an attached tmux client in Ghostty.

The server only listens on `127.0.0.1`. `POST /api/open` accepts JSON requests
from localhost.
